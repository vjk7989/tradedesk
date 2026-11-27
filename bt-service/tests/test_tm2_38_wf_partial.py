from __future__ import annotations

from bt_service.walkforward import walk_forward


def _ok(score, warnings=None):
    return {"ok": True, "metrics": {"sharpe": score}, "equity": [], "trades": [], "warnings": warnings or []}


def _runner(fail_test_fold=None, fail_train_fold=None):
    """Two candidates; test run is every 3rd call. Fold k's chosen param is {'n': k+1} (higher wins)."""
    calls = []

    def run(**kw):
        calls.append(kw)
        fold, pos = divmod(len(calls) - 1, 3)
        p = kw["signal_parameters"]
        if pos == 2:
            if fold == fail_test_fold:
                return {"ok": False, "error": "boom", "warnings": ["tw"]}
            return _ok(1.0)
        if fold == fail_train_fold:
            return {"ok": False, "error": "no data"}
        return _ok(float(p["n"]) * (fold + 1), warnings=["w"] if pos == 0 else None)

    return run, calls


CANDS = [{"n": 1}, {"n": 2}]


def _wf(run, end):
    return walk_forward("x", ["A"], "2024-01-01", end, train_days=20, test_days=5, candidates=CANDS, run=run)


def test_test_failure_in_fold_2_keeps_folds_0_and_1():
    run, _ = _runner(fail_test_fold=2)
    res = _wf(run, "2024-02-05")
    assert res["ok"] is False
    assert res["error"].startswith("fold 2: test run failed: boom")
    assert [f["chosen"] for f in res["folds"]] == [{"n": 2}, {"n": 2}]
    assert [f["test_metrics"] for f in res["folds"]] == [{"sharpe": 1.0}] * 2
    assert res["folds"][0]["train_score"] == 2.0 and res["folds"][1]["train_score"] == 4.0
    assert "fold 0: w" in res["warnings"] and "fold 2: tw" in res["warnings"]
    assert "summary" not in res and "oos_equity" not in res


def test_no_finite_candidate_in_fold_1_keeps_fold_0():
    run, _ = _runner(fail_train_fold=1)
    res = _wf(run, "2024-02-05")
    assert res["ok"] is False
    assert res["error"].startswith("fold 1: no candidate produced a finite sharpe")
    assert len(res["folds"]) == 1 and res["folds"][0]["chosen"] == {"n": 2}


def test_fold_0_failure_returns_empty_folds():
    run, _ = _runner(fail_train_fold=0)
    res = _wf(run, "2024-02-05")
    assert res["ok"] is False and res["folds"] == []
    run, _ = _runner(fail_test_fold=0)
    res = _wf(run, "2024-02-05")
    assert res["ok"] is False and res["folds"] == []
    assert res["error"] == "fold 0: test run failed: boom"
