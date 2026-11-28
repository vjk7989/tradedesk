"""TM2-39: walk-forward thin-fold warnings and warnings kept on the time-budget path (fake runner)."""
from __future__ import annotations

from bt_service.walkforward import MIN_FOLD_BARS, walk_forward

CANDS = [{"n": 1}, {"n": 2}]


def _eq(n):
    return [{"date": f"2024-01-{d + 1:02d}", "value": 100.0 + d} for d in range(n)]


def _runner(train_bars=20, test_bars=20):
    def run(**kw):
        is_test = kw["start"] >= "2024-01-21"
        n = test_bars if is_test else train_bars
        return {"ok": True, "metrics": {"sharpe": float(kw["signal_parameters"]["n"])}, "equity": _eq(n), "warnings": []}
    return run


def _wf(run, **kw):
    return walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                        candidates=CANDS, run=run, **kw)


def test_constant():
    assert MIN_FOLD_BARS == 10


def test_normal_fold_no_warnings():
    res = _wf(_runner())
    assert res["ok"] and res["warnings"] == []


def test_thin_train_one_warning():
    res = _wf(_runner(train_bars=5))
    assert res["ok"]
    assert res["warnings"] == ["fold 0: thin train window (5 bars < 10)"]


def test_thin_test_one_warning():
    res = _wf(_runner(test_bars=3))
    assert res["ok"]
    assert res["warnings"] == ["fold 0: thin test window (3 bars < 10)"]


def test_boundary_ten_is_not_thin():
    assert _wf(_runner(train_bars=10, test_bars=10))["warnings"] == []


def test_scores_unchanged_by_thinness():
    a, b = _wf(_runner()), _wf(_runner(train_bars=5, test_bars=3))
    assert a["folds"] == b["folds"] and a["summary"] == b["summary"]


def test_budget_path_keeps_warnings():
    t = iter([0, 0, 0, 10**6])
    res = _wf(_runner(train_bars=5), clock=lambda: next(t))
    assert res["ok"] is False and res["error"] == "time budget exceeded"
    assert res["warnings"] == ["fold 0: thin train window (5 bars < 10)"]
    assert set(res) == {"ok", "error", "folds", "warnings"}
