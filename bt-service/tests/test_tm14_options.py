"""TM-14: India options engine. Engine-level tests drive IndiaOptionsEngine._execute_bars
with a hand-built data_map; end-to-end tests run the service on tests/fixtures/nifty_opt_1d.csv
(needs the india_options routing)."""
import logging
import math
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from bt_service import run_backtest
from vibe_bt.backtest.engines.india_options import IndiaOptionsEngine, parse_option
from vibe_bt.backtest.runner import _detect_market

FIXTURES = Path(__file__).parent / "fixtures"
CE = "NIFTY25NOV24000CE@NFO"  # monthly expiry = last Tuesday of Nov 2025 = 2025-11-25
PE = "NIFTY25NOV24000PE@NFO"
IDX = "NIFTY@NSE"
CAP = 1_000_000
NO_COST = {
    "slippage": 0, "in_opt_brokerage": 0, "in_opt_stt": 0, "in_opt_exchange_txn": 0,
    "in_opt_sebi_fee": 0, "in_opt_stamp_duty": 0,
}


def frame(dates, opens, closes=None):
    closes = closes or opens
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


def hand_cost(notional, is_buy):
    base = 20 + notional * 0.0003503 + notional * 0.000001
    return base + base * 0.18 + notional * (0.00003 if is_buy else 0.0015)


def test_parse_forms():
    a = parse_option("NIFTY28NOV2524000CE@NFO")
    assert (a.root, a.expiry, a.strike, a.kind) == ("NIFTY", date(2025, 11, 28), 24000.0, "CE")
    b = parse_option("BANKNIFTY25NOV52000PE")
    assert (b.root, b.expiry, b.strike, b.kind) == ("BANKNIFTY", date(2025, 11, 25), 52000.0, "PE")
    assert parse_option("NIFTY25DECFUT@NFO") is None
    assert parse_option("NIFTY25DEC24100CE").expiry == date(2025, 12, 30)  # last Tuesday


def test_long_ce_round_trip_pnl_and_costs():
    dates = pd.bdate_range("2025-11-10", periods=3)
    dm = {CE: frame(dates, [100.0, 110.0, 120.0])}
    e = IndiaOptionsEngine({"initial_cash": CAP, "slippage": 0})
    drive(e, dm, {CE: [0.1, 0.1, 0.0]}, [CE])
    assert len(e.trades) == 1
    t = e.trades[0]
    # 100000 / (100 * 65) = 15.38 -> 15 lots
    assert t.size == 15 and t.entry_price == 100.0 and t.exit_price == 120.0
    assert t.pnl == pytest.approx((120 - 100) * 65 * 15)  # 19500
    costs = hand_cost(15 * 65 * 100.0, True) + hand_cost(15 * 65 * 120.0, False)
    assert t.commission == pytest.approx(costs)
    assert e.capital == pytest.approx(CAP + 19500 - costs)


def test_short_pe_margin_is_enforced_and_cut_to_fit():
    dates = pd.bdate_range("2025-11-10", periods=2)
    dm = {PE: frame(dates, [100.0, 100.0])}
    e = IndiaOptionsEngine({"initial_cash": CAP, "slippage": 0})
    drive(e, dm, {PE: [-1.0, -1.0]}, [PE])
    t = e.trades[0]  # closed by the end-of-backtest liquidation
    per_lot = 0.15 * 24000 * 65  # 234,000
    # premium sizing asks for 153 lots; margin allows floor(1,000,000 / 234,000) = 4
    assert t.size == 4 and t.direction == -1
    assert t.entry_margin == pytest.approx(4 * per_lot)


def test_short_margin_pct_override():
    dates = pd.bdate_range("2025-11-10", periods=2)
    dm = {PE: frame(dates, [100.0, 100.0])}
    e = IndiaOptionsEngine({"initial_cash": CAP, "slippage": 0, "opt_short_margin_pct": 0.3})
    drive(e, dm, {PE: [-1.0, -1.0]}, [PE])
    assert e.trades[0].size == 2  # floor(1e6 / (0.3*24000*65 = 468,000))


def expiry_run(und_close, with_underlying=True):
    dates = pd.bdate_range("2025-11-20", "2025-11-27")  # 20,21,24,25,26,27
    dm = {CE: frame(dates, [100.0] * len(dates), [100.0, 100.0, 100.0, 90.0, 80.0, 80.0])}
    cfg = {"initial_cash": CAP, "slippage": 0, **NO_COST}
    if with_underlying:
        cfg["underlying"] = {"NIFTY": IDX}
        dm[IDX] = frame(dates, [24000.0] * len(dates), [24000.0, 24000.0, 24000.0, und_close, 99999.0, 99999.0])
    e = IndiaOptionsEngine(cfg)
    drive(e, dm, {CE: [0.1] * len(dates)}, [CE])
    return e


def test_itm_call_settles_at_intrinsic():
    e = expiry_run(24500.0)
    assert len(e.trades) == 1
    t = e.trades[0]
    assert t.exit_reason == "expiry" and t.exit_price == pytest.approx(500.0)
    assert t.exit_time == pd.Timestamp("2025-11-25")  # first bar on expiry date
    assert t.pnl == pytest.approx((500 - 100) * 65 * t.size)
    assert CE not in e.positions  # and no re-entry after expiry


def test_otm_call_settles_at_zero():
    t = expiry_run(23500.0).trades[0]
    assert t.exit_reason == "expiry" and t.exit_price == 0.0
    assert t.pnl == pytest.approx(-100 * 65 * t.size)


def test_expiry_without_underlying_uses_last_price():
    t = expiry_run(0.0, with_underlying=False).trades[0]
    assert t.exit_reason == "expiry" and t.exit_price == 90.0  # option close on the expiry bar


def test_unknown_root_lot_one_and_warning(caplog):
    sym = "ZZZZ25NOV500CE@NFO"
    e = IndiaOptionsEngine({})
    with caplog.at_level(logging.WARNING):
        assert e.get_contract_multiplier(sym) == 1.0
    assert "ZZZZ" in caplog.text and "lot 1" in caplog.text
    assert e._engine_diagnostics()["pricing_assumptions"] == [
        {"product": "ZZZZ", "field": "lot_size", "value": 1}
    ]


def test_lot_size_override_and_fallback():
    e = IndiaOptionsEngine({"lot_sizes": {"NIFTY": 75}})
    assert e.get_contract_multiplier(CE) == 75.0
    assert IndiaOptionsEngine({}).get_contract_multiplier(CE) == 65.0
    assert IndiaOptionsEngine({}).get_contract_multiplier("BANKNIFTY25NOV52000CE") == 30.0


def test_cost_arithmetic():
    e = IndiaOptionsEngine({})
    e._active_symbol = CE
    notional = 10 * 65 * 200.0  # 130,000
    base = 20 + 130000 * 0.0003503 + 130000 * 0.000001  # 20 + 45.539 + 0.13 = 65.669
    gst = base * 0.18
    assert e.calc_commission(10, 200.0, 1, True) == pytest.approx(base + gst + notional * 0.00003)
    assert e.calc_commission(10, 200.0, 1, False) == pytest.approx(base + gst + notional * 0.0015)
    # a short opens on the sell side (STT) and closes on the buy side (stamp)
    assert e.calc_commission(10, 200.0, -1, True) == pytest.approx(base + gst + notional * 0.0015)
    assert e.calc_commission(10, 200.0, -1, False) == pytest.approx(base + gst + notional * 0.00003)
    assert base + gst + notional * 0.00003 == pytest.approx(hand_cost(notional, True))


def test_cost_overrides():
    e = IndiaOptionsEngine({**NO_COST, "in_opt_gst": 0, "in_opt_stt": 0.01})
    e._active_symbol = CE
    assert e.calc_commission(1, 100.0, 1, False) == pytest.approx(65 * 100 * 0.01)


@pytest.mark.parametrize("key", [
    "in_opt_brokerage", "in_opt_stt", "in_opt_exchange_txn", "in_opt_sebi_fee",
    "in_opt_stamp_duty", "in_opt_gst", "slippage",
])
@pytest.mark.parametrize("bad", [-1.0, float("nan"), float("inf"), "x"])
def test_invalid_overrides_rejected(key, bad):
    with pytest.raises(ValueError):
        IndiaOptionsEngine({key: bad})


@pytest.mark.parametrize("bad", [0, -0.1, 1.5, float("nan")])
def test_invalid_margin_pct_rejected(bad):
    with pytest.raises(ValueError):
        IndiaOptionsEngine({"opt_short_margin_pct": bad})


def test_invalid_lot_size_rejected():
    with pytest.raises(ValueError):
        IndiaOptionsEngine({"lot_sizes": {"NIFTY": 0}})


# ── end to end (needs routing from part B) ──

OPT = "NIFTY25NOV24000CE@NFO"


def _code(weight):
    return (
        "import pandas as pd\n"
        "class SignalEngine:\n"
        "    def generate(self, data_map):\n"
        f"        return {{c: pd.Series({weight}, index=df.index) for c, df in data_map.items()}}\n"
    )


@pytest.fixture
def env(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        f'  - symbol: "{OPT}"\n'
        "    type: csv\n"
        f'    path: "{(FIXTURES / "nifty_opt_1d.csv").as_posix()}"\n'
        '    date_format: "%Y-%m-%d"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")


def test_routing():
    assert _detect_market("NIFTY28NOV2524000CE@NFO") == "india_options"
    assert _detect_market("NIFTY25NOV24000PE@BFO") == "india_options"
    assert _detect_market("NIFTY25DECFUT@NFO") == "india_fno"
    assert _detect_market("RELIANCE.NS") == "india_equity"


def test_e2e_long_ce_settles_at_expiry(env):
    r = run_backtest(_code(0.1), [OPT], "2025-11-03", "2025-11-28", capital=CAP,
                     source="local", costs=NO_COST)
    assert r["ok"], r.get("error")
    first, last = r["trades"][0], r["trades"][-1]
    assert first["side"] == "buy" and first["qty"] > 0
    assert last["side"] == "sell"
    # no underlying mapped -> settled at the option's last price on the expiry bar (2025-11-25 close 420)
    assert last["price"] == pytest.approx(420.0)
    assert not math.isnan(r["metrics"]["final_value"])


def test_e2e_auto_chain_openalgo_then_local(env, monkeypatch):
    # OPENALGO unset -> the openalgo link is skipped, the chain falls through to local.
    for k in ("OPENALGO_API_KEY", "OPENALGO_HOST", "OPENALGO_URL"):
        monkeypatch.delenv(k, raising=False)
    r = run_backtest(_code(0.1), [OPT], "2025-11-03", "2025-11-28", capital=CAP,
                     source="auto", costs=NO_COST)
    assert r["ok"], r.get("error")
    assert r["trades"]
