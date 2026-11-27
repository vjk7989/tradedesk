from pathlib import Path

import pytest

from bt_service import run_backtest
from vibe_bt.backtest.engines.india_fno import IndiaFnoEngine, fno_root
from vibe_bt.backtest.runner import _detect_market

FIXTURES = Path(__file__).parent / "fixtures"
SYM = "NIFTY25DECFUT@NFO"
ZERO = {
    "in_fno_brokerage": 0, "in_fno_stt": 0, "in_fno_exchange_txn": 0,
    "in_fno_sebi_fee": 0, "in_fno_stamp_duty": 0, "slippage": 0,
}


def code(weight: float) -> str:
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
        f'  - symbol: "{SYM}"\n'
        "    type: csv\n"
        f'    path: "{(FIXTURES / "niftyfut_1d.csv").as_posix()}"\n'
        '    date_format: "%Y-%m-%d"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")


def run(weight, costs=None, capital=1_000_000):
    r = run_backtest(code(weight), [SYM], "2024-01-02", "2024-06-14", capital=capital,
                     source="local", costs=costs)
    assert r["ok"], r.get("error")
    return r


def final(r):
    return r["metrics"]["final_value"]


def test_routing():
    assert _detect_market("NIFTY25DECFUT@NFO") == "india_fno"
    assert _detect_market("NIFTY28NOV25FUT@NFO") == "india_fno"
    assert _detect_market("CRUDEOIL25DECFUT@MCX") == "india_fno"
    assert _detect_market("RELIANCE.NS") == "india_equity"
    assert _detect_market("RELIANCE@NSE") == "india_equity"
    # TM-14: options (CE/PE on NFO/BFO) route to the india_options engine
    assert _detect_market("NIFTY28NOV2524000CE@NFO") == "india_options"


def test_fno_root():
    assert fno_root("NIFTY25DECFUT@NFO") == "NIFTY"
    assert fno_root("BANKNIFTY28NOV25FUT@NFO") == "BANKNIFTY"


def test_unknown_root_assumes_lot_one():
    e = IndiaFnoEngine({})
    assert e.get_contract_multiplier("NIFTY25DECFUT@NFO") == 65
    assert e.get_contract_multiplier("FOOFUT@NFO") == 1
    assert e._engine_diagnostics()["pricing_assumptions"][0]["product"] == "FOO"
    assert IndiaFnoEngine({"lot_sizes": {"foo": 10}}).get_contract_multiplier("FOOFUT@NFO") == 10


def test_bad_margin_pct():
    with pytest.raises(ValueError):
        IndiaFnoEngine({"margin_pct": 0})


def test_lot_rounding_down(env):
    # leverage 1/0.15, capital 1M: 6.67M / (~22045 * 65) = 4.65 -> 4 lots
    entry = run(1.0)["trades"][0]
    assert entry["qty"] == 4
    # lot 100: 6.67M / (~22045 * 100) = 3.02 -> 3 lots
    entry = run(1.0, {"lot_sizes": {"NIFTY": 100}})["trades"][0]
    assert entry["qty"] == 3


def test_margin_cap(env):
    r = run(1.0, {"margin_pct": 0.5})
    qty, price = r["trades"][0]["qty"], r["trades"][0]["price"]
    assert qty == 1  # 2M / (~22056 * 65) = 1.40 -> 1 lot
    assert qty * 65 * price * 0.5 <= 1_000_000
    assert (qty + 1) * 65 * price * 0.5 > 1_000_000
    # too small to afford one lot: nothing opens
    r = run(1.0, capital=100_000)
    assert r["trades"] == []


def test_costs_reduce_equity(env):
    free = final(run(1.0, ZERO))
    costed = final(run(1.0))
    assert costed < free


def test_short_pnl_sign(env):
    long_r, short_r = run(1.0, ZERO), run(-1.0, ZERO)
    assert final(long_r) > 1_000_000 > final(short_r)  # fixture trends up
    exit_trade = short_r["trades"][-1]
    assert exit_trade["pnl"] < 0
    assert exit_trade["pnl"] == pytest.approx(-long_r["trades"][-1]["pnl"])
    # 4 lots * 65 * points
    pts = exit_trade["price"] - short_r["trades"][0]["price"]
    assert exit_trade["pnl"] == pytest.approx(-4 * 65 * pts)


def test_stt_sell_side_only():
    e = IndiaFnoEngine({"in_fno_brokerage": 0, "in_fno_exchange_txn": 0, "in_fno_sebi_fee": 0,
                        "in_fno_stamp_duty": 0})  # STT left at its default
    e._active_symbol = SYM
    notional = 1 * 65 * 20000  # 1.3M
    assert e.in_fno_stt == 0.0005
    assert e.calc_commission(1, 20000, 1, True) == 0               # open long = buy
    assert e.calc_commission(1, 20000, -1, False) == 0             # close short = buy
    assert e.calc_commission(1, 20000, 1, False) == pytest.approx(650)  # close long = sell, 0.05%
    assert e.calc_commission(1, 20000, -1, True) == pytest.approx(notional * 0.0005)  # open short = sell
