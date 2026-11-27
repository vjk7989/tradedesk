import pytest

from bt_service import run_backtest
from vibe_bt.backtest.engines.india_equity import IndiaEquityEngine
from tests.test_runner import FIXTURES, GOOD

ONLY_STAMP = {"in_exchange_txn": 0, "in_sebi_fee": 0, "in_stt": 0, "in_mis_stt": 0}
NOTIONAL = 100 * 100.0


def eng(**kw):
    return IndiaEquityEngine({**ONLY_STAMP, **kw})


def test_mis_buy_stamp_and_sell_zero():
    e = eng(interval="5m", product="MIS")
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(NOTIONAL * 0.00003)
    assert e.calc_commission(100, 100.0, 1, False) == 0.0


def test_cnc_and_daily_unchanged():
    assert eng(interval="5m", product="CNC").calc_commission(100, 100.0, 1, True) == pytest.approx(NOTIONAL * 0.00015)
    assert eng(interval="1D", product="MIS").calc_commission(100, 100.0, 1, True) == pytest.approx(NOTIONAL * 0.00015)


def test_override():
    e = eng(interval="5m", product="MIS", in_mis_stamp_duty=0.0001)
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(NOTIONAL * 0.0001)


@pytest.mark.parametrize("bad", [-0.1, -1, float("nan"), float("inf"), float("-inf")])
def test_invalid_raises(bad):
    with pytest.raises(ValueError, match="in_mis_stamp_duty"):
        IndiaEquityEngine({"interval": "5m", "product": "MIS", "in_mis_stamp_duty": bad})


def test_mis_round_trip_default_rates():
    e = IndiaEquityEngine({"interval": "5m", "product": "MIS"})
    # Buy 100 @ 2500: notional 250000
    #   exch 250000*0.0000297 = 7.425; sebi 250000*0.000001 = 0.25
    #   gst 0.18*(0+7.425+0.25) = 1.3815; stt 0; stamp 250000*0.00003 = 7.5
    buy = 7.425 + 0.25 + 1.3815 + 7.5
    # Sell 100 @ 2510: notional 251000
    #   exch 7.4547; sebi 0.251; gst 0.18*(7.4547+0.251) = 1.387026
    #   stt 251000*0.00025 = 62.75; stamp 0; dp 0
    sell = 7.4547 + 0.251 + 1.387026 + 62.75
    b = e.calc_commission(100, 2500.0, 1, True)
    s = e.calc_commission(100, 2510.0, 1, False)
    assert b == pytest.approx(buy)
    assert s == pytest.approx(sell)
    assert b + s == pytest.approx(buy + sell)


def _run(tmp_path, monkeypatch, costs):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        '  - symbol: "RELIANCE.NS"\n'
        "    type: csv\n"
        f'    path: "{(FIXTURES / "aapl.csv").as_posix()}"\n'
        '    date_format: "%Y-%m-%d"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    return run_backtest(GOOD, symbols=["RELIANCE.NS"], start="2024-01-02", end="2024-06-14",
                        source="local", costs=costs)


def test_runner_rejects_negative(tmp_path, monkeypatch):
    res = _run(tmp_path, monkeypatch, {"in_mis_stamp_duty": -1})
    assert res["ok"] is False
    assert "in_mis_stamp_duty" in res["error"]


def test_runner_control_ok(tmp_path, monkeypatch):
    assert _run(tmp_path, monkeypatch, {"in_mis_stamp_duty": 0.00003})["ok"]
