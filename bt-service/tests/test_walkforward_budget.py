"""Walk-forward total time budget (fix round 1). Fake clock and injected run; no subprocesses."""
from __future__ import annotations

import pytest

from bt_service.walkforward import _budget_s, walk_forward


def ok(score=1.0):
    return {"ok": True, "metrics": {"sharpe": score}, "equity": [], "warnings": []}


def advancing_clock(step):
    now = {"t": 0.0}

    def clock():
        value = now["t"]
        now["t"] += step
        return value

    return clock


@pytest.mark.parametrize("value,expected", [
    ("1", 30), ("30", 30), ("600", 600), ("99999", 3600), ("nope", 600), ("", 600),
])
def test_budget_env_clamped(monkeypatch, value, expected):
    monkeypatch.setenv("BT_WALKFORWARD_BUDGET_S", value)
    assert _budget_s() == expected


def test_each_run_timeout_capped_by_remaining_budget(monkeypatch):
    monkeypatch.setenv("BT_WALKFORWARD_BUDGET_S", "30")
    calls = []

    def run(**kw):
        calls.append(kw)
        return ok()

    res = walk_forward("x", ["A"], "2024-01-01", "2024-02-20", train_days=20, test_days=5,
                       candidates=[{"n": 1}], timeout_s=120, run=run, clock=advancing_clock(10))
    assert res["ok"] is False and res["error"] == "time budget exceeded"
    assert [c["timeout_s"] for c in calls] == [20, 10]
    assert len(res["folds"]) == 1


def test_budget_spent_before_first_run_returns_no_folds(monkeypatch):
    monkeypatch.setenv("BT_WALKFORWARD_BUDGET_S", "30")
    calls = []

    def run(**kw):
        calls.append(kw)
        return ok()

    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=[{"n": 1}], run=run, clock=advancing_clock(100))
    # TM2-39 Addendum: the budget return has the same shape as the other failures, warnings included.
    assert res == {"ok": False, "error": "time budget exceeded", "folds": [], "warnings": []}
    assert calls == []


def test_generous_budget_leaves_timeout_untouched(monkeypatch):
    monkeypatch.setenv("BT_WALKFORWARD_BUDGET_S", "600")
    calls = []

    def run(**kw):
        calls.append(kw)
        return ok()

    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=[{"n": 1}], timeout_s=9, run=run, clock=advancing_clock(0))
    assert res["ok"] is True
    assert {c["timeout_s"] for c in calls} == {9}
