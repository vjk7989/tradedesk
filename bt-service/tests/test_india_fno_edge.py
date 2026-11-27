"""Edge tests for the India F&O futures engine (P7.1).

Unit tests drive IndiaFnoEngine directly; the end-to-end cases run the service
against tests/fixtures/niftyfut_1d.csv (an up-trending NIFTY future, first fill
on 2024-01-03 open 22044.77).
"""
import logging
import math
from pathlib import Path

import pytest

from bt_service import run_backtest
from vibe_bt.backtest.engines._market_hooks import code_currency, matched_market
from vibe_bt.backtest.engines.india_fno import _FALLBACK_LOT_SIZES, IndiaFnoEngine, fno_root
from vibe_bt.backtest.runner import _detect_market, _select_market_engine

FIXTURES = Path(__file__).parent / "fixtures"
SYM = "NIFTY25DECFUT@NFO"
FIN = "FINNIFTY25DECFUT@NFO"
NXT = "NIFTYNXT5025DECFUT@NFO"  # NIFTY-prefixed root with no fallback lot
CAP = 1_000_000
ZERO = {
    "in_fno_brokerage": 0, "in_fno_stt": 0, "in_fno_exchange_txn": 0,
    "in_fno_sebi_fee": 0, "in_fno_stamp_duty": 0, "slippage": 0,
}
NO_SLIP = {"slippage": 0}

# Default tariff (AC): brokerage INR 20/order, STT 0.05% sell (Finance Act 2026), exchange 0.00183%,
# SEBI 0.0001%, stamp 0.002% buy, GST 18% on brokerage + exchange + SEBI.
BROK, STT, TXN, SEBI, STAMP, GST = 20.0, 0.0005, 0.0000183, 0.000001, 0.00002, 0.18


def hand_cost(notional: float, is_buy: bool) -> float:
    base = BROK + notional * TXN + notional * SEBI
    side = notional * STAMP if is_buy else notional * STT
    return base + base * GST + side


def code(weight: float) -> str:
    return (
        "import pandas as pd\n"
        "class SignalEngine:\n"
        "    def generate(self, data_map):\n"
        f"        return {{c: pd.Series({weight}, index=df.index) for c, df in data_map.items()}}\n"
    )


@pytest.fixture
def env(tmp_path, monkeypatch):
    csv = (FIXTURES / "niftyfut_1d.csv").as_posix()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        + "".join(
            f'  - symbol: "{s}"\n    type: csv\n    path: "{csv}"\n    date_format: "%Y-%m-%d"\n'
            for s in (SYM, FIN, NXT)
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")


def run(weight, costs=None, capital=CAP, sym=SYM):
    r = run_backtest(code(weight), [sym], "2024-01-02", "2024-06-14", capital=capital,
                     source="local", costs=costs)
    assert r["ok"], r.get("error")
    return r


def entry(r):
    return r["trades"][0]


def final(r):
    return r["metrics"]["final_value"]


# ── routing table ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("sym, market", [
    ("NIFTY25DECFUT@NFO", "india_fno"),
    ("BANKNIFTY28NOV25FUT@NFO", "india_fno"),
    ("SENSEX25DECFUT@BFO", "india_fno"),
    ("CRUDEOIL25DECFUT@MCX", "india_fno"),
    ("nifty25decfut@nfo", "india_fno"),
    ("Crudeoil25DecFut@mcx", "india_fno"),
    ("M&M25DECFUT@NFO", "india_fno"),
    ("M&MFUT@NFO", "india_fno"),
    ("BAJAJ-AUTO25DECFUT@NFO", "india_fno"),
    ("NIFTYFUT@NSE", "india_equity"),           # NSE is not an F&O exchange
    ("NIFTY25DECFUT@BSE", "india_equity"),
    ("NIFTY25DECFUT@CDS", "india_equity"),
    ("NIFTY28NOV2524000CE@NFO", "india_equity"),  # options stay on india_equity
    ("NIFTY28NOV2524000PE@NFO", "india_equity"),
    ("SENSEX25DEC80000CE@BFO", "india_equity"),
    ("RELIANCE.NS", "india_equity"),
    ("RELIANCE@NSE", "india_equity"),
    ("M&M@NSE", "india_equity"),
])
def test_routing_table(sym, market):
    assert _detect_market(sym) == market


@pytest.mark.parametrize("sym", ["NIFTY25DECFUT", "NIFTY25DECFUT@XYZ", "FUT@", "@NFO", ""])
def test_routing_not_fno_without_fno_exchange(sym):
    assert matched_market(sym) != "india_fno"


def test_local_prefix_routes_to_fno():
    assert _detect_market("local:NIFTY25DECFUT@NFO") == "india_fno"


def test_fno_books_in_inr():
    assert code_currency(SYM) == "INR"


def test_select_market_engine_is_fno():
    assert isinstance(_select_market_engine("local", {}, [SYM]), IndiaFnoEngine)


def test_mixed_fno_and_equity_basket_prices_future_with_fno_rules():
    # Cross-market basket goes to CompositeEngine; the futures leg must not be
    # priced by IndiaEquityEngine (no lot multiplier, equity tariff).
    from vibe_bt.backtest.engines.composite import CompositeEngine

    comp = CompositeEngine({}, [SYM, "RELIANCE@NSE"])
    assert isinstance(comp._rule_for(SYM), IndiaFnoEngine)


# ── fno_root ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("sym, root", [
    ("NIFTY25DECFUT@NFO", "NIFTY"),
    ("NIFTY28NOV25FUT@NFO", "NIFTY"),
    ("NIFTY28NOV25FUT", "NIFTY"),
    ("NIFTYFUT@NFO", "NIFTY"),
    ("nifty25decfut@nfo", "NIFTY"),
    ("BANKNIFTY25DECFUT@NFO", "BANKNIFTY"),
    ("BANKNIFTY28NOV25FUT@NFO", "BANKNIFTY"),
    ("FINNIFTY25DECFUT@NFO", "FINNIFTY"),
    ("NIFTYNXT5025DECFUT@NFO", "NIFTYNXT50"),
    ("NIFTYNXT5028NOV25FUT@NFO", "NIFTYNXT50"),
    ("MIDCPNIFTY25DECFUT@NFO", "MIDCPNIFTY"),
    ("M&M25DECFUT@NFO", "M&M"),
    ("BAJAJ-AUTO28NOV25FUT@NFO", "BAJAJ-AUTO"),
    ("SENSEX25DECFUT@BFO", "SENSEX"),
    ("CRUDEOIL25DECFUT@MCX", "CRUDEOIL"),
])
def test_fno_root(sym, root):
    assert fno_root(sym) == root


def test_fallback_lot_table_is_exactly_the_four_nse_index_roots():
    # NSE circular NSE/FAOP/70616 (Jan 2026 series, verified Nov 2026).
    assert _FALLBACK_LOT_SIZES == {"NIFTY": 65, "BANKNIFTY": 30, "FINNIFTY": 60, "MIDCPNIFTY": 120}
    e = IndiaFnoEngine({})
    for root, lot in _FALLBACK_LOT_SIZES.items():
        assert e.get_contract_multiplier(f"{root}25DECFUT@NFO") == lot
    assert e._engine_diagnostics() == {}


@pytest.mark.parametrize("sym, lot", [
    ("FINNIFTY25DECFUT@NFO", 60),
    ("FINNIFTY28NOV25FUT@NFO", 60),
    ("finnifty25decfut@nfo", 60),
    ("MIDCPNIFTY25DECFUT@NFO", 120),
    ("MIDCPNIFTY28NOV25FUT@NFO", 120),
])
def test_nifty_prefix_roots_in_table_get_their_own_lot(sym, lot, caplog):
    e = IndiaFnoEngine({})
    with caplog.at_level(logging.WARNING, logger="vibe_bt.backtest.engines.india_fno"):
        assert e.get_contract_multiplier(sym) == lot  # its own lot, never NIFTY's 65
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert e._engine_diagnostics() == {}
    assert e.get_contract_multiplier("BANKNIFTY25DECFUT@NFO") == 30
    assert e.get_contract_multiplier("NIFTY28NOV25FUT@NFO") == 65


@pytest.mark.parametrize("sym, root", [
    ("NIFTYNXT5025DECFUT@NFO", "NIFTYNXT50"),
    ("NIFTYIT25DECFUT@NFO", "NIFTYIT"),
    ("NIFTY5025DECFUT@NFO", "NIFTY50"),
])
def test_nifty_prefix_roots_not_in_table_do_not_inherit_nifty_lot(sym, root, caplog):
    e = IndiaFnoEngine({})
    with caplog.at_level(logging.WARNING, logger="vibe_bt.backtest.engines.india_fno"):
        assert e.get_contract_multiplier(sym) == 1  # unknown root -> lot 1, never NIFTY's 65
    msgs = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(msgs) == 1 and root in msgs[0]
    assert e._engine_diagnostics()["pricing_assumptions"] == [
        {"product": root, "field": "lot_size", "value": 1}
    ]
    assert e.get_contract_multiplier("BANKNIFTY25DECFUT@NFO") == 30
    assert e.get_contract_multiplier("NIFTY28NOV25FUT@NFO") == 65


def test_unknown_root_warns_once_and_is_listed(caplog):
    e = IndiaFnoEngine({})
    assert e._engine_diagnostics() == {}
    with caplog.at_level(logging.WARNING, logger="vibe_bt.backtest.engines.india_fno"):
        for _ in range(3):
            e.get_contract_multiplier(NXT)
        e.get_contract_multiplier("CRUDEOIL25DECFUT@MCX")
        e.get_contract_multiplier(FIN)  # in the fallback table: no warning
    msgs = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert sum("NIFTYNXT50" in m for m in msgs) == 1
    assert sum("CRUDEOIL" in m for m in msgs) == 1
    assert not any("FINNIFTY" in m for m in msgs)
    assert len(msgs) == 2
    products = [a["product"] for a in e._engine_diagnostics()["pricing_assumptions"]]
    assert products == ["CRUDEOIL", "NIFTYNXT50"]


def test_known_roots_not_listed_in_pricing_assumptions():
    e = IndiaFnoEngine({"lot_sizes": {"FINNIFTY": 65, "NIFTYNXT50": 25}})
    assert e.get_contract_multiplier(FIN) == 65  # config beats the 60 fallback
    assert e.get_contract_multiplier(NXT) == 25
    assert e.get_contract_multiplier(SYM) == 65
    assert e.get_contract_multiplier("MIDCPNIFTY25DECFUT@NFO") == 120
    assert e._engine_diagnostics() == {}


# ── lot_sizes config ─────────────────────────────────────────────────────────

def test_lot_sizes_override_fallback_and_case_insensitive_key():
    e = IndiaFnoEngine({"lot_sizes": {"nifty": 50}})
    assert e.get_contract_multiplier(SYM) == 50
    assert e.get_contract_multiplier("BANKNIFTY25DECFUT@NFO") == 30  # fallback kept
    assert e.get_contract_multiplier(FIN) == 60
    assert e.get_contract_multiplier("MIDCPNIFTY25DECFUT@NFO") == 120


@pytest.mark.parametrize("lot", [0, -1, -75])
def test_lot_sizes_non_positive_rejected(lot):
    with pytest.raises(ValueError):
        IndiaFnoEngine({"lot_sizes": {"NIFTY": lot}})


def test_lot_sizes_non_numeric_str_rejected():
    with pytest.raises((ValueError, TypeError)):
        IndiaFnoEngine({"lot_sizes": {"NIFTY": "abc"}})


def test_lot_sizes_fractional_float_not_silently_truncated():
    # 75.9 must not quietly become 75 (AC: {ROOT:int}; bad values rejected or reported).
    with pytest.raises((ValueError, TypeError)):
        IndiaFnoEngine({"lot_sizes": {"NIFTY": 75.9}})


def test_lot_sizes_numeric_str_not_silently_coerced():
    with pytest.raises((ValueError, TypeError)):
        IndiaFnoEngine({"lot_sizes": {"NIFTY": "75"}})


def test_lot_sizes_none_or_empty_uses_fallback():
    for cfg in ({"lot_sizes": None}, {"lot_sizes": {}}):
        e = IndiaFnoEngine(cfg)
        assert e.get_contract_multiplier(SYM) == 65
        assert e.get_contract_multiplier("BANKNIFTY25DECFUT@NFO") == 30
        assert e.get_contract_multiplier(FIN) == 60
        assert e.get_contract_multiplier("MIDCPNIFTY25DECFUT@NFO") == 120


# ── margin_pct ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("m, lev", [(0.15, 1 / 0.15), (1, 1.0), (1.0, 1.0), (0.01, 100.0)])
def test_margin_pct_valid_sets_leverage(m, lev):
    e = IndiaFnoEngine({"margin_pct": m})
    assert e.default_leverage == pytest.approx(lev)


def test_margin_pct_default_is_015():
    e = IndiaFnoEngine({})
    assert e.margin_pct == 0.15
    assert e.default_leverage == pytest.approx(1 / 0.15)


@pytest.mark.parametrize("m", [0, 0.0, 1.0001, -0.1, -1, float("nan"), float("inf")])
def test_margin_pct_out_of_range_rejected(m):
    with pytest.raises(ValueError):
        IndiaFnoEngine({"margin_pct": m})


def test_margin_pct_overrides_caller_leverage():
    assert IndiaFnoEngine({"margin_pct": 0.5, "leverage": 10}).default_leverage == pytest.approx(2.0)


# ── lot rounding (unit) ──────────────────────────────────────────────────────

@pytest.mark.parametrize("raw, lots", [
    (3.99, 3), (4.0, 4), (4.0001, 4), (0.5, 0), (0.999999, 0), (1.0, 1), (0.0, 0), (-0.5, 0),
])
def test_round_size_floors_to_whole_lots(raw, lots):
    assert IndiaFnoEngine({}).round_size(raw, 20000.0) == lots


@pytest.mark.parametrize("equity, lots", [(780_000, 4), (779_999, 3), (195_000, 1), (194_999, 0)])
def test_sizing_formula_boundaries(equity, lots):
    # floor(equity * 1 * (1/0.15) / (20000 * 65)); 1 lot needs 195000 margin.
    e = IndiaFnoEngine({})
    raw = e._calc_raw_size(SYM, equity * e.default_leverage, 20000.0)
    assert e.round_size(raw, 20000.0) == lots
    assert math.floor(equity / 0.15 / (20000 * 65)) == lots


# ── costs (unit) ─────────────────────────────────────────────────────────────

def _eng(**over):
    e = IndiaFnoEngine({**{k: v for k, v in ZERO.items() if k != "slippage"}, **over})
    e._active_symbol = SYM
    return e


def test_default_costs_buy_and_sell_one_lot_by_hand():
    e = IndiaFnoEngine({})
    e._active_symbol = SYM
    n = 1 * 65 * 20000.0  # 1.3M notional
    assert (e.in_fno_stt, e.in_fno_stamp_duty) == (0.0005, 0.00002)
    # buy: 20 + 23.79 + 1.3 + 18% * 45.09 (8.1162) + stamp 26 = 79.2062
    assert e.calc_commission(1, 20000.0, 1, True) == pytest.approx(79.2062, abs=0.001)
    assert e.calc_commission(1, 20000.0, 1, True) == pytest.approx(hand_cost(n, True), abs=0.001)
    # sell: 20 + 23.79 + 1.3 + 8.1162 + STT 650 = 703.2062
    assert e.calc_commission(1, 20000.0, 1, False) == pytest.approx(703.2062, abs=0.001)
    assert e.calc_commission(1, 20000.0, 1, False) == pytest.approx(hand_cost(n, False), abs=0.001)


def test_stt_not_on_buy_stamp_not_on_sell():
    stt = _eng(in_fno_stt=0.0005)
    assert stt.calc_commission(1, 20000, 1, True) == 0       # open long = buy
    assert stt.calc_commission(1, 20000, -1, False) == 0     # close short = buy
    assert stt.calc_commission(1, 20000, 1, False) == pytest.approx(650)   # close long = sell
    assert stt.calc_commission(1, 20000, -1, True) == pytest.approx(650)   # open short = sell
    stamp = _eng(in_fno_stamp_duty=0.00002)
    assert stamp.calc_commission(1, 20000, 1, True) == pytest.approx(26)
    assert stamp.calc_commission(1, 20000, -1, False) == pytest.approx(26)
    assert stamp.calc_commission(1, 20000, 1, False) == 0
    assert stamp.calc_commission(1, 20000, -1, True) == 0


def test_gst_base_excludes_stt_and_stamp():
    e = _eng(in_fno_stt=0.0005, in_fno_stamp_duty=0.00002, in_fno_gst=0.18)
    assert e.calc_commission(1, 20000, 1, False) == pytest.approx(650)  # no GST on STT
    assert e.calc_commission(1, 20000, 1, True) == pytest.approx(26)    # no GST on stamp
    g = _eng(in_fno_brokerage=20, in_fno_exchange_txn=0.0000183, in_fno_sebi_fee=0.000001)
    # 20 + 23.79 + 1.3 = 45.09, plus 18% GST = 53.2062
    assert g.calc_commission(1, 20000, 1, True) == pytest.approx(53.2062)


def test_brokerage_flat_per_order_not_per_lot():
    e = _eng(in_fno_brokerage=20)  # GST stays at its 18% default
    assert e.calc_commission(1, 20000, 1, True) == pytest.approx(23.6)
    assert e.calc_commission(10, 20000, 1, True) == pytest.approx(23.6)


def test_cost_notional_uses_lot_size_of_active_symbol():
    e = _eng(in_fno_stt=0.0005)
    e._active_symbol = "BANKNIFTY25DECFUT@NFO"
    assert e.calc_commission(2, 50000, 1, False) == pytest.approx(1500)  # 2 * 30 * 50000 * 0.05%
    e._active_symbol = FIN
    assert e.calc_commission(2, 20000, 1, False) == pytest.approx(1200)  # 2 * 60 * 20000 * 0.05%
    e._active_symbol = "MIDCPNIFTY25DECFUT@NFO"
    assert e.calc_commission(1, 10000, 1, False) == pytest.approx(600)   # 1 * 120 * 10000 * 0.05%


def test_cost_override_keys():
    e = _eng(in_fno_brokerage=40, in_fno_gst=0.5)
    assert e.calc_commission(1, 20000, 1, True) == pytest.approx(60)


def test_zero_costs_are_zero():
    e = _eng()
    for d in (1, -1):
        for o in (True, False):
            assert e.calc_commission(3, 22000, d, o) == 0


# ── end to end ───────────────────────────────────────────────────────────────

def test_round_trip_costs_match_hand_calculation(env):
    r = run(1.0, NO_SLIP)
    buy, sell = r["trades"][0], r["trades"][-1]
    assert (buy["side"], sell["side"]) == ("buy", "sell")
    lots = buy["qty"]
    assert lots == 4
    n_buy = lots * 65 * buy["price"]
    n_sell = lots * 65 * sell["price"]
    costs = hand_cost(n_buy, True) + hand_cost(n_sell, False)
    assert sell["pnl"] == pytest.approx(lots * 65 * (sell["price"] - buy["price"]), abs=0.01)
    assert final(r) == pytest.approx(CAP + sell["pnl"] - costs, abs=0.01)


def test_short_round_trip_costs_flip_sides(env):
    r = run(-1.0, NO_SLIP)
    sell, buy = r["trades"][0], r["trades"][-1]
    assert (sell["side"], buy["side"]) == ("sell", "buy")
    lots = sell["qty"]
    assert lots == 4
    costs = hand_cost(lots * 65 * sell["price"], False) + hand_cost(lots * 65 * buy["price"], True)
    assert final(r) == pytest.approx(CAP + buy["pnl"] - costs, abs=0.01)


def test_cost_override_keys_end_to_end(env):
    base = final(run(1.0, NO_SLIP))
    # +80 brokerage on each of two orders, plus 18% GST on it
    assert final(run(1.0, {**NO_SLIP, "in_fno_brokerage": 100})) == pytest.approx(base - 2 * 80 * 1.18, abs=0.01)
    r = run(1.0, {**NO_SLIP, "in_fno_stt": 0})
    sell = r["trades"][-1]
    assert final(r) == pytest.approx(base + 4 * 65 * sell["price"] * 0.0005, abs=0.01)


def test_zero_cost_equity_at_least_default(env):
    assert final(run(1.0, ZERO)) >= final(run(1.0))


def test_lot_rounding_399_lots_floors_to_3(env):
    # weight 0.857: 0.857 * 1M / 0.15 / (22044.77 * 65) = 3.987 lots -> 3
    assert entry(run(0.857, NO_SLIP))["qty"] == 3


def test_lot_rounding_just_over_4_lots_is_4(env):
    # weight 0.86: 0.86 * 1M / 0.15 / (22044.77 * 65) = 4.001 lots -> 4 (other side of the floor)
    assert entry(run(0.86, NO_SLIP))["qty"] == 4


def test_half_a_lot_is_no_trade(env):
    # weight 0.124: 0.124 * 4.653 = 0.58 lots -> 0, nothing opens, no crash
    r = run(0.124, NO_SLIP)
    assert r["trades"] == []
    assert final(r) == pytest.approx(CAP)


def test_weight_zero_no_trades(env):
    r = run(0.0, NO_SLIP)
    assert r["trades"] == []
    assert final(r) == pytest.approx(CAP)


def test_weight_above_one_is_clipped(env):
    assert entry(run(2.0, NO_SLIP))["qty"] == entry(run(1.0, NO_SLIP))["qty"] == 4


def test_short_allowed_and_pnl_sign(env):
    r = run(-1.0, ZERO)
    assert entry(r)["side"] == "sell" and entry(r)["qty"] == 4
    exit_ = r["trades"][-1]
    assert exit_["price"] > entry(r)["price"]  # fixture trends up
    assert exit_["pnl"] == pytest.approx(-4 * 65 * (exit_["price"] - entry(r)["price"]))
    assert final(r) < CAP


def test_margin_pct_one_sizes_unlevered(env):
    # leverage 1: 5M / (22044.77 * 65) = 3.49 -> 3 lots
    assert entry(run(1.0, {**NO_SLIP, "margin_pct": 1}, capital=5_000_000))["qty"] == 3


def test_invalid_margin_pct_fails_run(env):
    r = run_backtest(code(1.0), [SYM], "2024-01-02", "2024-06-14", capital=CAP,
                     source="local", costs={"margin_pct": 0})
    assert not r["ok"]


def test_capital_too_small_for_one_lot(env):
    # one lot needs 22044.77*65*0.15 = 214,937 margin
    r = run(1.0, NO_SLIP, capital=200_000)
    assert r["trades"] == []
    assert final(r) == pytest.approx(200_000)
    assert r["metrics"]["unfilled_plan_rejections"] > 0  # the "warning" surfaced in metrics


def test_capital_one_lot_boundary_includes_entry_commission(env):
    # One lot at 22044.77: margin 214,936.51 + buy cost 84.89 (20 + txn 26.22 + SEBI 1.43
    # + GST 8.58 + stamp 28.66) = 215,021.40 cash needed.
    assert entry(run(1.0, NO_SLIP, capital=215_100))["qty"] == 1
    assert run(1.0, NO_SLIP, capital=215_000)["trades"] == []


def test_unknown_root_run_lists_pricing_assumption(env):
    r = run(1.0, NO_SLIP, sym=NXT)
    assert "NIFTYNXT50" in str(r["metrics"].get("pricing_assumptions"))
    # lot 1: floor(1M / 0.15 / 22044.77) = 302 contracts, not NIFTY's 4 lots
    assert entry(r)["qty"] == 302


def test_finnifty_run_uses_its_fallback_lot(env):
    r = run(1.0, NO_SLIP, sym=FIN)
    assert not r["metrics"].get("pricing_assumptions")
    # lot 60: floor(1M / 0.15 / (22044.77 * 60)) = floor(5.04) = 5 lots
    assert entry(r)["qty"] == 5
