"""TM2-51: walk-forward skips a malformed (non-list / non-dict-item) test equity instead of crashing."""
from __future__ import annotations

import pytest

from bt_service.walkforward import walk_forward

CANDS = [{"n": 1}, {"n": 2}]


def _eq(n=20):
    return [{"date": f"2024-01-{d + 1:02d}", "value": 100.0 + d} for d in range(n)]


def _runner(bad, bad_fold_start=None):
    def run(**kw):
        is_test = kw["start"] >= "2024-01-21"
        eq = bad if (is_test and (bad_fold_start is None or kw["start"] == bad_fold_start)) else _eq()
        return {"ok": True, "metrics": {"sharpe": float(kw["signal_parameters"]["n"])}, "equity": eq, "warnings": []}
    return run


def _wf(run):
    return walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                        candidates=CANDS, run=run)


@pytest.mark.parametrize("bad,name", [
    (None, "NoneType"), ({"a": 1}, "dict"), ("abc", "str"), (5, "int"), ([1, 2, 3], "list"),
])
def test_malformed_equity_warns_and_skips(bad, name):
    base = _wf(_runner(_eq()))
    res = _wf(_runner(bad))
    assert res["ok"]
    assert f"fold 0: unexpected equity shape ({name})" in res["warnings"]
    assert res["folds"] == base["folds"] and res["summary"] == base["summary"]
    assert res["oos_equity"] == []


def test_empty_list_is_valid_no_new_warning():
    res = _wf(_runner([]))
    assert res["ok"]
    assert not any("unexpected equity shape" in w for w in res["warnings"])


def test_other_folds_unaffected():
    def run(**kw):
        eq = _eq(20)
        if kw["start"] >= "2024-01-21":
            eq = "bad" if kw["start"] == "2024-01-21" else _eq(20)
        return {"ok": True, "metrics": {"sharpe": 1.0}, "equity": eq, "warnings": []}
    res = walk_forward("x", ["A"], "2024-01-01", "2024-02-10", train_days=20, test_days=5,
                       candidates=CANDS, run=run)
    assert res["ok"]
    assert res["warnings"].count("fold 0: unexpected equity shape (str)") == 1
    assert len(res["folds"]) > 1
    assert res["oos_equity"]
