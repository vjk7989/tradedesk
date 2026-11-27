"""TM2-31: walk-forward over india_options and composite baskets, on local fixtures (real runner).

Fixtures: tm2_31_ce_1d.csv (NIFTY25NOV24000CE, expires Tue 2025-11-25, last bar is the expiry bar),
tm2_31_und_1d.csv (NIFTY index, consistent with the option's premium), tm2_31_eq_1d.csv (equity).
Window 20 train / 5 test calendar days from 2025-10-27 gives two folds; fold 2 tests [11-21, 11-26),
which contains the expiry.
"""
from __future__ import annotations

import os
import pathlib

import pytest

from bt_service import run_backtest
from bt_service.walkforward import walk_forward

F = pathlib.Path(__file__).parent / "fixtures"
CE, UND, EQ = "NIFTY25NOV24000CE@NFO", "NIFTY@NSE", "RELIANCE.NS"
FILES = {CE: "tm2_31_ce_1d.csv", UND: "tm2_31_und_1d.csv", EQ: "tm2_31_eq_1d.csv"}
CANDS = [{"w": 0.1}, {"w": 0.3}, {"w": -0.2}]
CODE = (
    "import pandas as pd\n"
    "class SignalEngine:\n"
    "    def __init__(self, w=0.1):\n"
    "        self.w = w\n"
    "    def generate(self, data_map):\n"
    "        return {c: pd.Series(self.w, index=df.index) for c, df in data_map.items()}\n"
)
COSTS = {"slippage": 0}
MAPPED = {"slippage": 0, "underlying": {"NIFTY": UND}}


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("tm2_31")
    cfg = tmp / "config.yaml"
    cfg.write_text(
        "sources:\n" + "".join(
            f'  - symbol: "{s}"\n    type: csv\n    path: "{(F / f).as_posix()}"\n    date_format: "%Y-%m-%d"\n'
            for s, f in FILES.items()),
        encoding="utf-8")
    old = {k: os.environ.get(k) for k in ("BT_LOCAL_DATA_CONFIG", "BT_RUNS_DIR", "VIBE_TRADING_DATA_CACHE")}
    os.environ.update(BT_LOCAL_DATA_CONFIG=str(cfg), BT_RUNS_DIR=str(tmp / "runs"), VIBE_TRADING_DATA_CACHE="false")
    yield
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _wf(symbols, start, end, costs=COSTS):
    return walk_forward(CODE, symbols, start, end, train_days=20, test_days=5, candidates=CANDS,
                        metric="total_return", source="local", costs=costs)


@pytest.fixture(scope="module")
def ce_only(env):
    return _wf([CE], "2025-10-27", "2025-11-26")


FOLD_WINDOWS = [(["2025-10-27", "2025-11-16"], ["2025-11-16", "2025-11-21"]),
                (["2025-11-01", "2025-11-21"], ["2025-11-21", "2025-11-26"])]


def _check(res, expected):
    """expected: per fold (chosen, train_score, total_return, final_value, sharpe, trade_count, max_drawdown)."""
    assert res["ok"], res.get("error")
    assert res["warnings"] == []
    assert [(f["train"], f["test"]) for f in res["folds"]] == FOLD_WINDOWS
    for f, (chosen, ts, tr, fv, sh, tc, dd) in zip(res["folds"], expected):
        assert f["chosen"] == chosen
        assert f["train_score"] == pytest.approx(ts, rel=1e-9)
        m = f["test_metrics"]
        assert m["total_return"] == pytest.approx(tr, rel=1e-9)
        assert m["final_value"] == pytest.approx(fv, rel=1e-9)
        assert m["sharpe"] == pytest.approx(sh, rel=1e-9)
        assert m["trade_count"] == tc
        assert m["max_drawdown"] == pytest.approx(dd, rel=1e-9)
    # train always ends where test starts (half-open), tests chain without gaps or overlap
    assert all(f["train"][1] == f["test"][0] for f in res["folds"])
    assert res["folds"][0]["test"][1] == res["folds"][1]["test"][0]
    dates = [p["date"] for p in res["oos_equity"]]
    assert dates == sorted(set(dates))
    assert dates[0] > res["folds"][0]["train"][1]  # nothing from the train window leaks into oos equity
    assert dates[-1] == "2025-11-25"


def test_ce_expiry_settles_inside_fold_2(ce_only):
    _check(ce_only, [
        ({"w": 0.3}, 0.0767728422927274, -0.005656848677304094, 994343.1513226959, -4.607480710981868, 1.0, -0.00965190638084848),
        ({"w": 0.3}, 0.03747718441869252, -0.017051580531642574, 982948.4194683575, -17.407592598080214, 1.0, -0.01705158053164254),
    ])
    assert ce_only["summary"] == {"folds": 2, "mean_test_total_return": -0.011354, "positive_folds": 0, "scored_folds": 2}
    assert ce_only["oos_equity"][0] == {"date": "2025-11-17", "value": 1000000.0}
    assert ce_only["oos_equity"][-1]["value"] == pytest.approx(977388.0290018297, rel=1e-9)
    assert len(ce_only["oos_equity"]) == 7


def test_fold_2_test_is_self_contained_and_expiry_trade_is_in_it(env, ce_only):
    # The fold-2 test run on its own reproduces the fold's metrics: nothing is carried over from
    # fold 1, and the position opened in the window is settled on the expiry date (reason "expiry").
    r = run_backtest(CODE, [CE], "2025-11-21", "2025-11-25", source="local", costs=COSTS,
                     signal_parameters=ce_only["folds"][1]["chosen"])
    assert r["ok"], r.get("error")
    assert r["metrics"]["total_return"] == pytest.approx(ce_only["folds"][1]["test_metrics"]["total_return"], rel=1e-12)
    buy, sell = r["trades"]
    assert (buy["timestamp"], buy["side"], buy["reason"]) == ("2025-11-24", "buy", "signal")
    assert (sell["timestamp"], sell["side"], sell["reason"]) == ("2025-11-25", "sell", "expiry")
    assert sell["price"] == pytest.approx(352.33)  # no underlying mapped: option's last price on expiry bar
    assert sell["qty"] == 12.0 and sell["pnl"] == pytest.approx(-16348.8)


def test_option_with_mapped_underlying(env):
    res = _wf([CE, UND], "2025-10-27", "2025-11-26", MAPPED)
    _check(res, [
        ({"w": 0.3}, 0.07715079100252731, -0.006491409734664, 993508.590265336, -7.27729664407103, 2.0, -0.010143327180328121),
        ({"w": 0.3}, 0.03738606420531121, -0.013995393288190439, 986004.6067118095, -14.221514184214133, 2.0, -0.013995393288190477),
    ])


def test_equity_plus_option_composite(env):
    res = _wf([CE, EQ], "2025-10-27", "2025-11-26")
    _check(res, [
        ({"w": 0.3}, 0.09748994997066873, 0.00557798887768568, 1005577.9888776857, 6.0957481072202535, 2.0, -0.004316466246335109),
        ({"w": 0.3}, 0.058804962391188154, -0.015173909076693914, 984826.0909233061, -18.42038298553823, 2.0, -0.015173909076693934),
    ])
    assert res["summary"] == {"folds": 2, "mean_test_total_return": -0.004798, "positive_folds": 1, "scored_folds": 2}
    assert res["oos_equity"][-1]["value"] == pytest.approx(990319.4399049309, rel=1e-9)


def test_equity_option_and_mapped_underlying_composite(env):
    res = _wf([CE, EQ, UND], "2025-10-27", "2025-11-26", MAPPED)
    _check(res, [
        ({"w": 0.3}, 0.09786789868046863, 0.004743427820325774, 1004743.4278203258, 5.185989498426262, 3.0, -0.004721447821790144),
        ({"w": 0.3}, 0.05871384217780662, -0.01211772183324189, 987882.2781667581, -14.140595715062444, 3.0, -0.012117721833241871),
    ])
    assert res["oos_equity"][-1]["value"] == pytest.approx(992568.2264482211, rel=1e-9)


def test_train_window_mostly_before_option_data_still_runs(env):
    # Train [10-13, 11-02) holds 5 option bars, test [11-02, 11-07) holds 4: thin but valid, one fold.
    res = _wf([CE], "2025-10-13", "2025-11-07")
    assert res["ok"], res.get("error")
    assert len(res["folds"]) == 1
    f = res["folds"][0]
    assert f["chosen"] == {"w": 0.3}
    assert f["train_score"] == pytest.approx(0.046683559749225445, rel=1e-9)
    assert f["test_metrics"]["total_return"] == pytest.approx(-0.031747628097949065, rel=1e-9)
    assert f["test_metrics"]["trade_count"] == 1.0
    assert [p["date"] for p in res["oos_equity"]] == ["2025-11-03", "2025-11-04", "2025-11-05", "2025-11-06"]


def test_fold_with_no_option_data_is_a_clear_error_not_a_crash(env):
    res = _wf([CE], "2025-10-01", "2025-10-26")
    assert res["ok"] is False
    assert res["error"].startswith("fold 0: no candidate produced a finite total_return")
    assert "missing: ['NIFTY25NOV24000CE@NFO']" in res["error"]


def test_fold_after_expiry_has_no_option_data_and_reports_which_fold(env):
    # Range runs to 12-01, so a third fold tests [11-26, 12-01): the expired option has no bars there.
    # Nothing from the expired contract is carried into it; the fold fails by number, not with a traceback.
    res = _wf([CE], "2025-10-27", "2025-12-01")
    assert res["ok"] is False
    assert res["error"].startswith("fold 2: test run failed")
    assert "missing: ['NIFTY25NOV24000CE@NFO']" in res["error"]
