"""Fix-round behaviours for OC-P7.3: inclusive run windows, error detail, rescale warnings, scored_folds."""
from __future__ import annotations

from bt_service.walkforward import walk_forward


def ok(score=1.0, equity=None):
    return {"ok": True, "metrics": {"sharpe": score}, "equity": equity or [], "warnings": []}


def wf(run, **kw):
    args = dict(code="x", symbols=["A"], start="2024-01-01", end="2024-01-26",
                train_days=20, test_days=5, candidates=[{"n": 1}], run=run)
    args.update(kw)
    return walk_forward(**args)


def scripted(test_equities):
    state = {"i": 0}

    def run(**kw):
        state["i"] += 1
        if state["i"] % 2 == 1:  # train
            return ok()
        return ok(equity=test_equities[state["i"] // 2 - 1])

    return run


def test_run_end_is_inclusive_fold_end_minus_one_day():
    calls = []

    def run(**kw):
        calls.append(kw)
        return ok()

    wf(run)
    assert calls[0]["start"] == "2024-01-01" and calls[0]["end"] == "2024-01-20"
    assert calls[1]["start"] == "2024-01-21" and calls[1]["end"] == "2024-01-25"


def test_all_candidates_fail_includes_first_error():
    def run(**kw):
        return {"ok": False, "error": "engine exploded"}

    res = wf(run)
    assert res["ok"] is False
    assert "fold 0" in res["error"] and "engine exploded" in res["error"]


def test_zero_first_equity_fold_gets_rescale_warning():
    run = scripted([
        [{"date": "2024-01-21", "value": 100.0}, {"date": "2024-01-22", "value": 110.0}],
        [{"date": "2024-01-26", "value": 0.0}, {"date": "2024-01-27", "value": 5.0}],
    ])
    res = wf(run, end="2024-01-31")
    assert res["ok"] is True and len(res["folds"]) == 2
    assert any("fold 1" in w and "not rescaled" in w for w in res["warnings"])


def test_empty_equity_fold_gets_rescale_warning():
    run = scripted([[{"date": "2024-01-21", "value": 100.0}], []])
    res = wf(run, end="2024-01-31")
    assert res["ok"] is True
    assert any("fold 1" in w and "not rescaled" in w for w in res["warnings"])


def test_summary_reports_scored_folds():
    state = {"i": 0}

    def run(**kw):
        state["i"] += 1
        if state["i"] % 2 == 1:
            return ok()
        return {"ok": True, "metrics": {}, "equity": []}

    res = wf(run, end="2024-01-31")
    assert res["summary"]["folds"] == 2
    assert res["summary"]["scored_folds"] == 0
    assert res["summary"]["mean_test_sharpe"] is None
