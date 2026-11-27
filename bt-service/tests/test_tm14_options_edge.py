"""TM-14 owner edge tests: India options engine (CE/PE on NFO/BFO).

Engine-level tests drive IndiaOptionsEngine._execute_bars with a hand-built
data_map (same harness as test_tm14_options.py). Tests marked "RULING" follow
the owner's fix plan round 1 (coord/reviews/TM-14.md): short margin from the
underlying close (strike x lot fallback) and composite support for india_options.
"""
import logging
import math
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from bt_service import run_backtest
from vibe_bt.backtest.engines.india_options import IndiaOptionsEngine, parse_option
from vibe_bt.backtest.runner import _detect_market

FIXTURES = Path(__file__).parent / "fixtures"
CE = "NIFTY25NOV24000CE@NFO"  # monthly expiry = last Tuesday of Nov 2025 = 2025-11-25
PE = "NIFTY25NOV24000PE@NFO"
FUT = "NIFTY25NOVFUT@NFO"
IDX = "NIFTY@NSE"
EXPIRY = pd.Timestamp("2025-11-25")
CAP = 1_000_000
NO_COST = {
    "slippage": 0, "in_opt_brokerage": 0, "in_opt_stt": 0, "in_opt_exchange_txn": 0,
    "in_opt_sebi_fee": 0, "in_opt_stamp_duty": 0,
}


def frame(dates, opens, closes=None):
    closes = closes if closes is not None else opens
    return pd.DataFrame(
        {"open": opens, "high": opens, "low": opens, "close": closes, "volume": 1000},
        index=pd.DatetimeIndex(dates),
    )


def drive(engine, data_map, weights, codes):
    """weights: {code: [w per bar]} over the first code's index."""
    dates = data_map[codes[0]].index
    close_df = pd.DataFrame({c: data_map[c]["close"] for c in codes}, index=dates)
    target = pd.DataFrame(weights, index=dates)[codes]
    engine._execute_bars(dates, data_map, close_df, target, codes)
    return engine


# ── lot sizes ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("sym, lot", [
    ("NIFTY25NOV24000CE@NFO", 65),
    ("BANKNIFTY25NOV52000PE@NFO", 30),
    ("FINNIFTY25NOV23000CE@NFO", 60),
    ("MIDCPNIFTY25NOV12000PE@NFO", 120),
])
def test_lot_size_all_four_roots(sym, lot, caplog):
    e = IndiaOptionsEngine({})
    with caplog.at_level(logging.WARNING):
        assert e.get_contract_multiplier(sym) == float(lot)
    assert "lot 1" not in caplog.text
    assert e._engine_diagnostics() == {}


def test_lot_size_unknown_root_warns_once_and_is_listed(caplog):
    e = IndiaOptionsEngine({})
    sym = "QQQQ28NOV251500CE@NFO"
    with caplog.at_level(logging.WARNING):
        assert e.get_contract_multiplier(sym) == 1.0
        assert e.get_contract_multiplier(sym) == 1.0
    assert caplog.text.count("QQQQ") >= 1
    assert sum("QQQQ" in r.getMessage() for r in caplog.records) == 1  # warned once
    assert e._engine_diagnostics()["pricing_assumptions"] == [
        {"product": "QQQQ", "field": "lot_size", "value": 1}
    ]


def test_lot_size_override_key_case_insensitive():
    e = IndiaOptionsEngine({"lot_sizes": {"nifty": 75, "qqqq": 10}})
    assert e.get_contract_multiplier(CE) == 75.0
    assert e.get_contract_multiplier("QQQQ25NOV500CE@NFO") == 10.0
    assert e._engine_diagnostics() == {}


# ── symbol parsing ───────────────────────────────────────────────────────────

def test_parse_weekly_ddmonyy():
    s = parse_option("NIFTY02DEC2524000CE@NFO")
    assert (s.root, s.expiry, s.strike, s.kind) == ("NIFTY", date(2025, 12, 2), 24000.0, "CE")


def test_parse_monthly_yymon_last_tuesday():
    s = parse_option("NIFTY26JAN25000PE@NFO")
    assert (s.root, s.expiry, s.strike, s.kind) == ("NIFTY", date(2026, 1, 27), 25000.0, "PE")
    # month whose last day is itself a Tuesday
    assert parse_option("NIFTY25SEP24000CE").expiry == date(2025, 9, 30)


def test_parse_ddmonyy_four_digit_strike_boundary():
    # 4-digit strike is the minimum for the DDMONYY reading
    s = parse_option("NIFTY28NOV259000CE")
    assert s.expiry == date(2025, 11, 28) and s.strike == 9000.0
    # 3-digit strike -> YYMON reading (yy=25, strike 500)
    s = parse_option("QQQQ25NOV500CE")
    assert s.expiry == date(2025, 11, 25) and s.strike == 500.0


def test_parse_decimal_strike():
    s = parse_option("NIFTY25NOV24000.5CE")
    assert s.strike == 24000.5


@pytest.mark.parametrize("bad", [
    "", "NIFTY", "NIFTY24000CE", "NIFTY25NOV24000XE@NFO", "NIFTY25XYZ24000CE",
    "NIFTY25DECFUT@NFO", "RELIANCE@NSE", "25NOV24000CE",
])
def test_parse_bad_symbol_returns_none(bad):
    assert parse_option(bad) is None


def test_parse_lowercase():
    s = parse_option("nifty28nov2524000ce@nfo")
    assert (s.root, s.expiry, s.strike, s.kind) == ("NIFTY", date(2025, 11, 28), 24000.0, "CE")
    assert _detect_market("nifty28nov2524000ce@nfo") == "india_options"


def test_parse_bfo_sensex():
    s = parse_option("SENSEX25DEC80000CE@BFO")
    assert (s.root, s.expiry, s.strike, s.kind) == ("SENSEX", date(2025, 12, 30), 80000.0, "CE")
    assert _detect_market("SENSEX25DEC80000PE@BFO") == "india_options"


def test_non_option_symbol_never_expires():
    e = IndiaOptionsEngine({})
    bar = pd.Series({"open": 1.0}, name=pd.Timestamp("2099-01-01"))
    assert e.can_execute("NOTANOPTION@NFO", 1, bar)


# ── costs ────────────────────────────────────────────────────────────────────

def test_exact_round_trip_costs_in_rupees():
    # 10 lots NIFTY (65) bought at 200, sold at 220, default tariff, no slippage.
    # buy  notional 130,000: 20 + 45.539 + 0.13 = 65.669; GST 11.82042; stamp 3.9  -> 81.38942
    # sell notional 143,000: 20 + 50.0929 + 0.143 = 70.2359; GST 12.642462; STT 214.5 -> 297.378362
    dates = pd.bdate_range("2025-11-10", periods=3)
    dm = {CE: frame(dates, [200.0, 210.0, 220.0])}
    e = IndiaOptionsEngine({"initial_cash": CAP, "slippage": 0})
    drive(e, dm, {CE: [0.135, 0.135, 0.0]}, [CE])
    assert len(e.trades) == 1
    t = e.trades[0]
    assert t.size == 10 and t.entry_price == 200.0 and t.exit_price == 220.0
    assert t.commission == pytest.approx(81.38942 + 297.378362, abs=1e-6)
    assert t.pnl == pytest.approx(20 * 65 * 10)
    assert e.capital == pytest.approx(CAP + 13000 - 378.767782, abs=1e-6)


def test_stt_sell_only_stamp_buy_only():
    e = IndiaOptionsEngine({**NO_COST, "in_opt_gst": 0, "in_opt_stt": 0.0015, "in_opt_stamp_duty": 0.00003})
    e._active_symbol = CE
    notional = 1 * 65 * 100.0
    assert e.calc_commission(1, 100.0, 1, True) == pytest.approx(notional * 0.00003)   # buy open
    assert e.calc_commission(1, 100.0, 1, False) == pytest.approx(notional * 0.0015)   # sell close
    assert e.calc_commission(1, 100.0, -1, True) == pytest.approx(notional * 0.0015)   # sell open
    assert e.calc_commission(1, 100.0, -1, False) == pytest.approx(notional * 0.00003)  # buy close


def test_zero_premium_order_pays_only_brokerage_and_gst():
    e = IndiaOptionsEngine({})
    e._active_symbol = CE
    assert e.calc_commission(1, 0.0, 1, False) == pytest.approx(20 * 1.18)


# ── expiry ───────────────────────────────────────────────────────────────────

def expiry_run(sym, weight, und_close, dates=None, with_underlying=True, map_root=True,
               opt_closes=None):
    dates = dates if dates is not None else pd.bdate_range("2025-11-20", "2025-11-27")
    n = len(dates)
    closes = opt_closes or [100.0] * n
    dm = {sym: frame(dates, [100.0] * n, closes)}
    cfg = {"initial_cash": CAP, **NO_COST}
    if map_root:
        cfg["underlying"] = {"NIFTY": IDX}
    if with_underlying:
        und = [24000.0 if d < EXPIRY else (und_close if d == EXPIRY else 99999.0) for d in dates]
        if EXPIRY not in dates:  # holiday: last bar before expiry carries the settlement close
            last_before = max(d for d in dates if d < EXPIRY)
            und = [und_close if d == last_before else u for d, u in zip(dates, und)]
        dm[IDX] = frame(dates, [24000.0] * n, und)
    e = IndiaOptionsEngine(cfg)
    drive(e, dm, {sym: [weight] * n}, [sym])
    return e


@pytest.mark.parametrize("sym, weight, und, intrinsic", [
    (CE, 0.1, 24500.0, 500.0),    # long CE ITM
    (CE, 0.1, 23500.0, 0.0),      # long CE OTM
    (CE, 0.1, 24000.0, 0.0),      # long CE ATM
    (PE, 0.1, 23500.0, 500.0),    # long PE ITM
    (PE, 0.1, 24500.0, 0.0),      # long PE OTM
    (PE, 0.1, 24000.0, 0.0),      # long PE ATM
    (CE, -0.1, 24500.0, 500.0),   # short CE ITM
    (CE, -0.1, 23500.0, 0.0),     # short CE OTM
    (CE, -0.1, 24000.0, 0.0),     # short CE ATM
    (PE, -0.1, 23500.0, 500.0),   # short PE ITM
    (PE, -0.1, 24500.0, 0.0),     # short PE OTM
    (PE, -0.1, 24000.0, 0.0),     # short PE ATM
])
def test_expiry_settlement_matrix(sym, weight, und, intrinsic):
    e = expiry_run(sym, weight, und)
    assert len(e.trades) == 1
    t = e.trades[0]
    direction = 1 if weight > 0 else -1
    assert t.direction == direction and t.size > 0
    assert t.exit_reason == "expiry"
    assert t.exit_time == EXPIRY
    assert t.exit_price == pytest.approx(intrinsic)
    assert t.pnl == pytest.approx(direction * (intrinsic - 100.0) * 65 * t.size)
    assert sym not in e.positions


def test_expiry_root_mapped_but_underlying_missing_falls_back_to_last_price():
    e = expiry_run(CE, 0.1, 0.0, with_underlying=False, map_root=True,
                   opt_closes=[100.0, 100.0, 100.0, 77.0, 50.0, 50.0])
    t = e.trades[0]
    assert t.exit_reason == "expiry" and t.exit_price == 77.0


def test_expiry_underlying_present_but_root_not_mapped_falls_back():
    e = expiry_run(CE, 0.1, 24500.0, with_underlying=True, map_root=False,
                   opt_closes=[100.0, 100.0, 100.0, 77.0, 50.0, 50.0])
    t = e.trades[0]
    assert t.exit_reason == "expiry" and t.exit_price == 77.0


def test_expiry_underlying_with_no_bar_up_to_expiry_falls_back():
    dates = pd.bdate_range("2025-11-20", "2025-11-27")
    dm = {CE: frame(dates, [100.0] * 6, [100.0, 100.0, 100.0, 77.0, 50.0, 50.0]),
          IDX: frame(pd.bdate_range("2025-11-26", periods=2), [30000.0] * 2)}
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST, "underlying": {"NIFTY": IDX}})
    drive(e, dm, {CE: [0.1] * 6}, [CE])
    t = e.trades[0]
    assert t.exit_reason == "expiry" and t.exit_price == 77.0


def test_no_entry_on_expiry_day_but_entry_day_before_allowed():
    dates = pd.bdate_range("2025-11-20", "2025-11-27")
    dm = {CE: frame(dates, [100.0] * 6)}
    # first non-zero target exactly on the expiry date -> blocked
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST})
    drive(e, dm, {CE: [0, 0, 0, 0.1, 0.1, 0.1]}, [CE])
    assert e.trades == [] and CE not in e.positions
    # first non-zero target the day before expiry -> enters, expires next bar
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST})
    drive(e, dm, {CE: [0, 0, 0.1, 0.1, 0.1, 0.1]}, [CE])
    assert len(e.trades) == 1
    t = e.trades[0]
    assert t.entry_time == pd.Timestamp("2025-11-24") and t.exit_reason == "expiry"


def test_no_entry_after_expiry():
    dates = pd.bdate_range("2025-11-26", "2025-11-28")
    dm = {CE: frame(dates, [100.0] * 3)}
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST})
    drive(e, dm, {CE: [0.1, 0.1, 0.1]}, [CE])
    assert e.trades == [] and not e.positions


def test_position_open_across_expiry_holiday_closes_on_next_bar():
    # no bar on the expiry date (holiday); the first bar after it closes with reason expiry
    dates = pd.DatetimeIndex(["2025-11-20", "2025-11-21", "2025-11-24", "2025-11-26", "2025-11-27"])
    e = expiry_run(CE, 0.1, 24300.0, dates=dates)
    assert len(e.trades) == 1
    t = e.trades[0]
    assert t.exit_reason == "expiry"
    assert t.exit_time == pd.Timestamp("2025-11-26")
    # settles against the last underlying close on/before expiry (24300), not the 11-26 bar
    assert t.exit_price == pytest.approx(300.0)


# ── short margin ─────────────────────────────────────────────────────────────

def short_run(cap, dm, cfg=None):
    e = IndiaOptionsEngine({"initial_cash": cap, **NO_COST, **(cfg or {})})
    drive(e, dm, {PE: [-1.0, -1.0]}, [PE])
    return e


def test_RULING_short_margin_from_underlying_close_no_lookahead():
    # Underlying 20,000 up to and including the entry bar, 40,000 on the next bar.
    # Ruling: margin = 0.15 x 20,000 x 65 = 195,000/lot -> floor(1e6/195,000) = 5 lots.
    # Strike basis (24,000) would give 4 lots; look-ahead (40,000) would give 2.
    dates = pd.bdate_range("2025-11-10", periods=2)
    und_dates = pd.bdate_range("2025-11-07", periods=3)  # one bar before, entry bar, next bar
    dm = {PE: frame(dates, [100.0, 100.0]),
          IDX: frame(und_dates, [20000.0, 20000.0, 40000.0])}
    e = short_run(CAP, dm, {"underlying": {"NIFTY": IDX}})
    t = e.trades[0]
    assert t.direction == -1 and t.size == 5
    assert t.entry_margin == pytest.approx(5 * 0.15 * 20000 * 65)


def test_short_margin_strike_fallback_when_no_underlying():
    dates = pd.bdate_range("2025-11-10", periods=2)
    dm = {PE: frame(dates, [100.0, 100.0])}
    t = short_run(CAP, dm, {"underlying": {"NIFTY": IDX}}).trades[0]  # mapped but not loaded
    assert t.size == 4 and t.entry_margin == pytest.approx(4 * 0.15 * 24000 * 65)


def test_short_margin_cut_to_fit_from_premium_sizing():
    # premium sizing asks for floor(1e6 / 6,500) = 153 lots; margin allows 4
    dates = pd.bdate_range("2025-11-10", periods=2)
    e = short_run(CAP, {PE: frame(dates, [100.0, 100.0])})
    assert e.trades[0].size == 4


@pytest.mark.parametrize("cap, lots", [
    (4 * 234_000, 4),          # capital exactly at margin for 4 lots
    (4 * 234_000 - 0.01, 3),   # one paisa short -> 3 lots
    (234_000, 1),              # exactly one lot
    (234_000 - 0.01, 0),       # below one lot -> no position
])
def test_short_margin_capital_boundary(cap, lots):
    dates = pd.bdate_range("2025-11-10", periods=2)
    e = short_run(cap, {PE: frame(dates, [1000.0, 1000.0])})
    if lots == 0:
        assert e.trades == [] and not e.positions
    else:
        assert e.trades[0].size == lots


def test_long_pays_full_premium_not_strike_margin():
    dates = pd.bdate_range("2025-11-10", periods=2)
    dm = {CE: frame(dates, [100.0, 100.0])}
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST})
    drive(e, dm, {CE: [0.5, 0.5]}, [CE])
    t = e.trades[0]
    assert t.size == 76  # floor(500,000 / 6,500)
    assert t.entry_margin == pytest.approx(76 * 65 * 100.0)


# ── composite / mixed baskets (RULING: composite must support india_options) ─

def test_RULING_composite_registers_options_engine():
    from vibe_bt.backtest.engines.composite import CompositeEngine
    from vibe_bt.backtest.engines.india_fno import IndiaFnoEngine

    comp = CompositeEngine({}, [CE, FUT])
    assert isinstance(comp._rule_for(CE), IndiaOptionsEngine)
    assert isinstance(comp._rule_for(FUT), IndiaFnoEngine)


def test_RULING_composite_option_leg_expires():
    # In a mixed basket the option leg must still settle at expiry.
    from vibe_bt.backtest.engines.composite import CompositeEngine

    dates = pd.bdate_range("2025-11-20", "2025-11-27")
    dm = {CE: frame(dates, [100.0] * 6, [100.0, 100.0, 100.0, 77.0, 50.0, 50.0]),
          "RELIANCE@NSE": frame(dates, [1000.0] * 6)}
    comp = CompositeEngine({"initial_cash": CAP, **NO_COST}, [CE, "RELIANCE@NSE"])
    drive(comp, dm, {CE: [0.1] * 6, "RELIANCE@NSE": [0.1] * 6}, [CE, "RELIANCE@NSE"])
    opt = [t for t in comp.trades if t.symbol == CE]
    assert opt and opt[0].exit_reason == "expiry" and opt[0].exit_time == EXPIRY


def test_RULING_composite_short_option_uses_option_margin():
    from vibe_bt.backtest.engines.composite import CompositeEngine

    dates = pd.bdate_range("2025-11-10", periods=2)
    dm = {PE: frame(dates, [100.0, 100.0]), FUT: frame(dates, [24000.0, 24000.0])}
    comp = CompositeEngine({"initial_cash": CAP, **NO_COST}, [PE, FUT])
    drive(comp, dm, {PE: [-1.0, -1.0], FUT: [0.0, 0.0]}, [PE, FUT])
    t = [t for t in comp.trades if t.symbol == PE][0]
    assert t.size == 4 and t.entry_margin == pytest.approx(4 * 0.15 * 24000 * 65)


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = (FIXTURES / "nifty_opt_1d.csv").as_posix()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        + "".join(
            f'  - symbol: "{s}"\n    type: csv\n    path: "{path}"\n    date_format: "%Y-%m-%d"\n'
            for s in (CE, "RELIANCE@NSE", FUT)
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")


def _code(weight):
    return (
        "import pandas as pd\n"
        "class SignalEngine:\n"
        "    def generate(self, data_map):\n"
        f"        return {{c: pd.Series({weight}, index=df.index) for c, df in data_map.items()}}\n"
    )


def test_RULING_e2e_equity_plus_option_basket(env):
    r = run_backtest(_code(0.1), [CE, "RELIANCE@NSE"], "2025-11-03", "2025-11-28",
                     capital=CAP, source="local", costs=NO_COST)
    assert r["ok"], r.get("error")
    assert {t["code"] for t in r["trades"]} >= {CE, "RELIANCE@NSE"}
    buy = next(t for t in r["trades"] if t["code"] == CE and t["side"] == "buy")
    # priced in NIFTY lots (65) by the options engine: ~0.1 x 1e6 / (~300 x 65) = 4-5 lots.
    # Misrouted to a lot-1 engine it would be ~300 units.
    assert 1 <= buy["qty"] <= 6
    assert buy["qty"] * 65 * buy["price"] <= 0.1 * CAP * 1.01
    assert not math.isnan(r["metrics"]["final_value"])


def test_RULING_e2e_option_plus_future_basket(env):
    r = run_backtest(_code(0.1), [CE, FUT], "2025-11-03", "2025-11-28",
                     capital=CAP, source="local", costs=NO_COST)
    assert r["ok"], r.get("error")
    assert {t["code"] for t in r["trades"]} >= {CE, FUT}
    buy = next(t for t in r["trades"] if t["code"] == CE and t["side"] == "buy")
    assert 1 <= buy["qty"] <= 6  # option leg in NIFTY lots


# ── data edges ───────────────────────────────────────────────────────────────

def test_empty_frame_no_trades():
    empty = frame(pd.DatetimeIndex([]), [])
    e = IndiaOptionsEngine({"initial_cash": CAP})
    drive(e, {CE: empty}, {CE: []}, [CE])
    assert e.trades == [] and not e.positions and e.capital == CAP


def test_nan_premium_bar_does_not_open_or_poison_capital():
    dates = pd.bdate_range("2025-11-10", periods=4)
    dm = {CE: frame(dates, [np.nan, 100.0, 110.0, 120.0], [np.nan, 100.0, 110.0, 120.0])}
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST})
    drive(e, dm, {CE: [0.1, 0.1, 0.1, 0.0]}, [CE])
    assert all(t.entry_price == t.entry_price and t.entry_price > 0 for t in e.trades)
    assert all(math.isfinite(t.pnl) for t in e.trades)
    assert math.isfinite(e.capital)


def test_nan_premium_on_expiry_bar_without_underlying():
    # fallback settlement must not book a NaN exit price
    dates = pd.bdate_range("2025-11-20", "2025-11-27")
    closes = [100.0, 100.0, 100.0, np.nan, 50.0, 50.0]
    e = expiry_run(CE, 0.1, 0.0, with_underlying=False, map_root=False, opt_closes=closes)
    t = e.trades[0]
    assert t.exit_reason == "expiry"
    assert math.isfinite(t.exit_price) and math.isfinite(e.capital)
