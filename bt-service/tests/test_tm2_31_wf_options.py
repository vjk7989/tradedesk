"""TM2-31: walk-forward over india_options and composite baskets, on local fixtures (real runner).

Fixtures: tm2_31_ce_1d.csv (NIFTY25NOV24000CE, expires Tue 2025-11-25, last bar is the expiry bar),
tm2_31_und_1d.csv (NIFTY index, close = 24005 + premium, so expiry intrinsic stays consistent with the
premium), tm2_31_eq_1d.csv (equity, steady uptrend).

The CE falls from 300 to 244 (10-27..11-03) and then climbs to 360 before settling at 352.33 on expiry.
Window 20 train / 5 test calendar days from 2025-10-27 gives two folds:
  fold 1 trains on [10-27, 11-16): net down, so the small weight (w=0.1) loses least and wins;
  fold 2 trains on [11-01, 11-21): net up, so the large weight (w=0.3) wins, and its test window
  [11-21, 11-26) contains the expiry.

Speed: every backtest is a subprocess, so all walk-forwards run once, concurrently, in a module-scoped
fixture. The look-ahead variants use other strikes of the same expiry (identical bars up to a cutoff,
perturbed after it) so they share one data config and can run in the same pool.
"""
from __future__ import annotations

import csv
import pathlib
from concurrent.futures import ThreadPoolExecutor

import pytest

from bt_service import run_backtest
from bt_service.walkforward import walk_forward

F = pathlib.Path(__file__).parent / "fixtures"
CE, UND, EQ = "NIFTY25NOV24000CE@NFO", "NIFTY@NSE", "RELIANCE.NS"
# Look-ahead variants: same root, expiry and lot size; with no underlying mapped the strike is unused
# for a long position, so identical bars give identical results.
CE_P1, CE_P2 = "NIFTY25NOV24100CE@NFO", "NIFTY25NOV24200CE@NFO"
P1_CUTOFF, P2_CUTOFF = "2025-11-16", "2025-11-21"  # fold 1 / fold 2 train ends (exclusive)
FILES = {CE: "tm2_31_ce_1d.csv", UND: "tm2_31_und_1d.csv", EQ: "tm2_31_eq_1d.csv"}
SMALL, LARGE = {"w": 0.1}, {"w": 0.3}
CANDS = [LARGE, SMALL]  # the winner is not always the first or the last candidate
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
START, END = "2025-10-27", "2025-11-26"
FOLD_WINDOWS = [(["2025-10-27", "2025-11-16"], ["2025-11-16", "2025-11-21"]),
                (["2025-11-01", "2025-11-21"], ["2025-11-21", "2025-11-26"])]


def _perturb(src: pathlib.Path, dst: pathlib.Path, cutoff: str, factor: float) -> None:
    """Copy src, scaling OHLC of every bar on or after `cutoff` by `factor`."""
    with src.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        if r["date"] >= cutoff:
            for k in ("open", "high", "low", "close"):
                r[k] = f"{float(r[k]) * factor:.2f}"
    with dst.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def _wf(symbols, start=START, end=END, costs=COSTS, candidates=CANDS):
    return walk_forward(CODE, symbols, start, end, train_days=20, test_days=5, candidates=candidates,
                        metric="total_return", source="local", costs=costs)


SCENARIOS = {
    "ce": lambda: _wf([CE]),
    # P1: bars after fold 1's train end pumped up 50% (would favour w=0.3 if fold 1 could see them).
    "ce_p1": lambda: _wf([CE_P1]),
    # P2: bars after fold 2's train end crashed 60% (would favour w=0.1 if fold 2 could see them).
    "ce_p2": lambda: _wf([CE_P2]),
    "ce_eq": lambda: _wf([CE, EQ]),
    "ce_eq_und": lambda: _wf([CE, EQ, UND], costs=MAPPED),
    "thin": lambda: _wf([CE], "2025-10-13", "2025-11-07"),
    "empty": lambda: _wf([CE], "2025-10-01", "2025-10-26"),
    # One candidate keeps it cheap: fold 0 tests [11-21, 11-26), fold 1 tests [11-26, 12-01) after expiry.
    "after_expiry": lambda: _wf([CE], "2025-11-01", "2025-12-01", candidates=[LARGE]),
    # Fold 2's test window run on its own (end 11-25 is the inclusive form of the fold's half-open 11-26).
    "fold2_alone": lambda: run_backtest(CODE, [CE], "2025-11-21", "2025-11-25", source="local", costs=COSTS,
                                        signal_parameters=LARGE),
}


@pytest.fixture(scope="module")
def results(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("tm2_31")
    paths = {s: F / f for s, f in FILES.items()}
    paths[CE_P1], paths[CE_P2] = tmp / "ce_p1.csv", tmp / "ce_p2.csv"
    _perturb(F / FILES[CE], paths[CE_P1], P1_CUTOFF, 1.5)
    _perturb(F / FILES[CE], paths[CE_P2], P2_CUTOFF, 0.4)
    cfg = tmp / "config.yaml"
    cfg.write_text(
        "sources:\n" + "".join(
            f'  - symbol: "{s}"\n    type: csv\n    path: "{p.as_posix()}"\n    date_format: "%Y-%m-%d"\n'
            for s, p in paths.items()),
        encoding="utf-8")
    mp = pytest.MonkeyPatch()
    mp.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    mp.setenv("BT_RUNS_DIR", str(tmp / "runs"))
    mp.setenv("VIBE_TRADING_DATA_CACHE", "false")
    try:
        with ThreadPoolExecutor(max_workers=len(SCENARIOS)) as pool:  # runs are subprocesses
            futures = {k: pool.submit(fn) for k, fn in SCENARIOS.items()}
            out = {k: f.result() for k, f in futures.items()}
        yield out
    finally:
        mp.undo()


def _check(res, expected):
    """expected: per fold (chosen, train_score, total_return, final_value, sharpe, trade_count, max_drawdown)."""
    assert res["ok"], res.get("error")
    # Pins current behaviour: thin folds emit no warning (follow-up: walkforward thin-fold warning).
    assert res["warnings"] == []
    assert [(f["train"], f["test"]) for f in res["folds"]] == FOLD_WINDOWS
    assert len(res["folds"]) == len(expected)
    for f, (chosen, ts, tr, fv, sh, tc, dd) in zip(res["folds"], expected):
        assert f["chosen"] == chosen
        assert f["train_score"] == pytest.approx(ts, rel=1e-6)
        m = f["test_metrics"]
        assert m["total_return"] == pytest.approx(tr, rel=1e-6)
        assert m["final_value"] == pytest.approx(fv, rel=1e-6)
        assert m["sharpe"] == pytest.approx(sh, rel=1e-6)
        assert m["trade_count"] == tc
        assert m["max_drawdown"] == pytest.approx(dd, rel=1e-6)
    # train always ends where test starts (half-open), tests chain without gaps or overlap
    assert all(f["train"][1] == f["test"][0] for f in res["folds"])
    assert res["folds"][0]["test"][1] == res["folds"][1]["test"][0]
    dates = [p["date"] for p in res["oos_equity"]]
    assert dates == sorted(set(dates))
    assert dates[0] > res["folds"][0]["train"][1]  # nothing from the train window leaks into oos equity
    assert dates[-1] == "2025-11-25"


def test_selection_discriminates_between_folds(results):
    # Fold 1 trains on a falling premium (w=0.1 loses least), fold 2 on a rising one (w=0.3 gains most).
    res = results["ce"]
    _check(res, [
        (SMALL, -0.006764764659, 0.011082146622549915, 1011082.14662255, 23.587802165718607, 1.0, 0.0),
        (LARGE, 0.09620341287062018, 0.005447064364884069, 1005447.064364884, 2.8658715368885455, 1.0,
         -0.0073351897696574565),
    ])
    assert res["summary"] == {"folds": 2, "mean_test_total_return": 0.008265, "positive_folds": 2, "scored_folds": 2}
    assert res["oos_equity"][0] == {"date": "2025-11-17", "value": 1000000.0}
    # chained: fold 2's equity is rescaled to start where fold 1 ended
    assert res["oos_equity"][-1]["value"] == pytest.approx(1011082.14662255 * 1.005447064364884, rel=1e-6)
    assert len(res["oos_equity"]) == 7


def test_fold_1_choice_ignores_bars_after_its_train_end(results):
    # Same bars up to 11-14, every bar from 11-17 on scaled x1.5. Fold 1 (train [10-27, 11-16)) and its
    # train score are unchanged; the pump is visible to fold 1's test and to fold 2's train, so the
    # perturbation is real and would have moved the score had fold 1 seen it.
    base, pert = results["ce"]["folds"], results["ce_p1"]["folds"]
    assert results["ce_p1"]["ok"], results["ce_p1"].get("error")
    assert pert[0]["chosen"] == base[0]["chosen"] == SMALL
    assert pert[0]["train_score"] == base[0]["train_score"]
    assert pert[0]["test_metrics"]["total_return"] != base[0]["test_metrics"]["total_return"]
    assert pert[1]["train_score"] == pytest.approx(0.28713217208909003, rel=1e-6)  # vs 0.0962 unperturbed


def test_fold_2_choice_ignores_bars_after_its_train_end(results):
    # Same bars up to 11-20, every bar from 11-21 on scaled x0.4. Fold 1 is untouched entirely; fold 2's
    # choice and train score are unchanged while its test window sees the crash.
    base, pert = results["ce"]["folds"], results["ce_p2"]["folds"]
    assert results["ce_p2"]["ok"], results["ce_p2"].get("error")
    # fold 1 is identical except the benchmark label, which names the (variant) symbol
    want = {k: v for k, v in base[0]["test_metrics"].items() if k != "benchmark_label"}
    assert {k: v for k, v in pert[0]["test_metrics"].items() if k != "benchmark_label"} == want
    assert {k: v for k, v in pert[0].items() if k != "test_metrics"} == {
        k: v for k, v in base[0].items() if k != "test_metrics"}
    assert pert[1]["chosen"] == base[1]["chosen"] == LARGE
    assert pert[1]["train_score"] == base[1]["train_score"]
    assert pert[1]["test_metrics"]["total_return"] != base[1]["test_metrics"]["total_return"]


def test_fold_2_test_is_self_contained_and_expiry_trade_is_in_it(results):
    # Fold 2's test run on its own reproduces the fold's metrics: nothing is carried over from fold 1,
    # and the position opened in the window is settled on the expiry date (reason "expiry").
    r = results["fold2_alone"]
    assert r["ok"], r.get("error")
    assert results["ce"]["folds"][1]["chosen"] == LARGE
    assert r["metrics"]["total_return"] == pytest.approx(
        results["ce"]["folds"][1]["test_metrics"]["total_return"], rel=1e-12)
    buy, sell = r["trades"]
    assert (buy["timestamp"], buy["side"], buy["reason"]) == ("2025-11-24", "buy", "signal")
    assert (sell["timestamp"], sell["side"], sell["reason"]) == ("2025-11-25", "sell", "expiry")
    assert buy["price"] == 345.0  # 11-24 open
    assert sell["price"] == 352.33  # no underlying mapped: option's last price on the expiry bar
    assert sell["qty"] == 13.0  # lots of 65
    assert sell["pnl"] == pytest.approx((352.33 - 345.0) * 13 * 65, abs=1e-6)  # 6193.85


def test_equity_plus_option_composite(results):
    res = results["ce_eq"]
    _check(res, [
        (LARGE, 0.0005172137009412658, 0.04457567742263957, 1044575.6774226397, 32.67480367961975, 2.0, 0.0),
        (LARGE, 0.11753119084311558, 0.007324735819832728, 1007324.7358198327, 3.7952534010029897, 2.0,
         -0.0068447138350601795),
    ])
    assert res["summary"] == {"folds": 2, "mean_test_total_return": 0.02595, "positive_folds": 2, "scored_folds": 2}
    assert res["oos_equity"][-1]["value"] == pytest.approx(1052226.918303583, rel=1e-6)


def test_equity_option_and_mapped_underlying_composite(results):
    # Also covers the mapped underlying (settlement at intrinsic against NIFTY@NSE); here fold 1 picks
    # w=0.1 and fold 2 w=0.3.
    res = results["ce_eq_und"]
    _check(res, [
        (SMALL, -0.00021509557251842004, 0.01471562205975152, 1014715.6220597514, 32.66228141019182, 3.0, 0.0),
        (LARGE, 0.11787945189944371, 0.01098011529284526, 1010980.1152928453, 6.625183853538007, 3.0,
         -0.0030819409617191197),
    ])
    assert res["oos_equity"][-1]["value"] == pytest.approx(1025857.3165794188, rel=1e-6)


def test_train_window_mostly_before_option_data_still_runs(results):
    # Train [10-13, 11-02) holds 5 option bars, test [11-02, 11-07) holds 4: thin but valid, one fold.
    res = results["thin"]
    assert res["ok"], res.get("error")
    # Pins current behaviour: no thin-data warning (follow-up: walkforward thin-fold warning).
    assert res["warnings"] == []
    assert len(res["folds"]) == 1
    f = res["folds"][0]
    assert f["chosen"] == SMALL
    assert f["train_score"] == pytest.approx(-0.01714485350539996, rel=1e-6)
    assert f["test_metrics"]["total_return"] == pytest.approx(0.004399351070000002, rel=1e-6)
    assert f["test_metrics"]["trade_count"] == 1.0
    assert [p["date"] for p in res["oos_equity"]] == ["2025-11-03", "2025-11-04", "2025-11-05", "2025-11-06"]


def test_fold_with_no_option_data_is_a_clear_error_not_a_crash(results):
    res = results["empty"]
    assert res["ok"] is False
    assert res["error"].startswith("fold 0: no candidate produced a finite total_return")
    assert "missing: ['NIFTY25NOV24000CE@NFO']" in res["error"]


def test_fold_after_expiry_has_no_option_data_and_reports_which_fold(results):
    # Fold 1 tests [11-26, 12-01): the expired option has no bars there. Nothing from the expired
    # contract is carried into it; the fold fails by number, not with a traceback in place of a result.
    res = results["after_expiry"]
    assert res["ok"] is False
    assert res["error"].startswith("fold 1: test run failed")
    assert "missing: ['NIFTY25NOV24000CE@NFO']" in res["error"]
    # The completed fold 0 is kept in the failed result (was dropped before; fixed by TM2-38).
    # Fold 0 here has the same windows and sole candidate as fold 2 of the "ce" scenario, so it
    # reuses that scenario's golden values and must equal that fold exactly.
    assert len(res["folds"]) == 1
    f = res["folds"][0]
    assert (f["train"], f["test"]) == FOLD_WINDOWS[1]
    assert f["chosen"] == LARGE
    assert f["train_score"] == pytest.approx(0.09620341287062018, rel=1e-6)
    m = f["test_metrics"]
    assert m["total_return"] == pytest.approx(0.005447064364884069, rel=1e-6)
    assert m["final_value"] == pytest.approx(1005447.064364884, rel=1e-6)
    assert m["sharpe"] == pytest.approx(2.8658715368885455, rel=1e-6)
    assert m["trade_count"] == 1.0
    assert m["max_drawdown"] == pytest.approx(-0.0073351897696574565, rel=1e-6)
    assert f == results["ce"]["folds"][1]
    assert res["warnings"] == []
    assert "oos_equity" not in res and "summary" not in res
