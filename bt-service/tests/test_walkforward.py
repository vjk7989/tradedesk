from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from bt_service import app as app_mod
from bt_service.walkforward import walk_forward

TOKEN = "t" * 32
HDR = {"Authorization": f"Bearer {TOKEN}"}

BASE = dict(
    code="x",
    symbols=["A"],
    start="2024-01-01",
    end="2024-02-20",
    train_days=20,
    test_days=5,
    candidates=[{"n": 1}],
)


def result(score, equity=None):
    return {"ok": True, "metrics": {"sharpe": score}, "equity": equity or [], "trades": [], "warnings": []}


def fake_run(candidates, train, test):
    """Train call per candidate, then one test call per fold. train/test: (params, fold) -> result."""
    calls = []
    per = len(candidates) + 1

    def run(**kw):
        fold = len(calls) // per
        calls.append(kw)
        params = kw["signal_parameters"]
        if len(calls) % per == 0:
            return test(params, fold)
        return train(params, fold)

    return run, calls


def test_fold_split_exact_fit():
    run, calls = fake_run([{"p": 1}], lambda p, f: result(1.0), lambda p, f: result(2.0))
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=[{"p": 1}], run=run)
    assert res["ok"] is True
    assert res["folds"][0]["train"] == ["2024-01-01", "2024-01-21"]
    assert res["folds"][0]["test"] == ["2024-01-21", "2024-01-26"]
    assert len(calls) == 2


def test_fold_split_one_day_short():
    run, calls = fake_run([{"p": 1}], lambda p, f: result(1.0), lambda p, f: result(1.0))
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-25", train_days=20, test_days=5,
                       candidates=[{"p": 1}], run=run)
    assert res == {"ok": False, "error": "range too short for one fold"}
    assert calls == []


def test_fold_split_steps_by_test_days():
    run, calls = fake_run([{"p": 1}], lambda p, f: result(1.0), lambda p, f: result(1.0))
    res = walk_forward("x", ["A"], "2024-01-01", "2024-02-05", train_days=20, test_days=5,
                       candidates=[{"p": 1}], run=run)
    assert res["ok"] is True
    assert [(f["train"], f["test"]) for f in res["folds"]] == [
        (["2024-01-01", "2024-01-21"], ["2024-01-21", "2024-01-26"]),
        (["2024-01-06", "2024-01-26"], ["2024-01-26", "2024-01-31"]),
        (["2024-01-11", "2024-01-31"], ["2024-01-31", "2024-02-05"]),
    ]
    assert len(calls) == 6


def test_selection_ignores_test_performance():
    cands = [{"name": "test_star"}, {"name": "train_star"}]
    train_scores = {"test_star": 0.1, "train_star": 0.9}
    test_scores = {"test_star": 99.0, "train_star": 0.2}
    run, calls = fake_run(
        cands,
        lambda p, f: result(train_scores[p["name"]]),
        lambda p, f: result(test_scores[p["name"]]),
    )
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=cands, run=run)
    fold = res["folds"][0]
    assert fold["chosen"] == {"name": "train_star"}
    assert fold["train_score"] == 0.9
    assert fold["test_metrics"]["sharpe"] == 0.2
    # The chosen candidate is what runs on the test window.
    assert calls[-1]["signal_parameters"] == {"name": "train_star"}
    assert calls[-1]["start"] == "2024-01-21"


def test_ties_go_to_first_candidate():
    cands = [{"n": 1}, {"n": 2}]
    run, calls = fake_run(cands, lambda p, f: result(0.5), lambda p, f: result(0.5))
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=cands, run=run)
    assert res["folds"][0]["chosen"] == {"n": 1}


def test_non_finite_scores_are_skipped():
    cands = [{"n": "fail"}, {"n": "nan"}, {"n": "inf"}, {"n": "ok"}]
    scores = {"nan": float("nan"), "inf": float("inf"), "ok": 0.4}
    run, calls = fake_run(
        cands,
        lambda p, f: {"ok": False, "error": "boom"} if p["n"] == "fail" else result(scores[p["n"]]),
        lambda p, f: result(0.0),
    )
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=cands, run=run)
    assert res["folds"][0]["chosen"] == {"n": "ok"}
    assert res["folds"][0]["train_score"] == 0.4


def test_fold_with_no_valid_candidate_fails():
    cands = [{"n": 1}, {"n": 2}]
    run, calls = fake_run(cands, lambda p, f: result(float("nan")), lambda p, f: pytest.fail("test run"))
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=cands, run=run)
    assert res["ok"] is False
    assert "fold 0" in res["error"] and "no candidate" in res["error"]
    assert len(calls) == 2


def test_failed_test_run_fails_closed():
    run, calls = fake_run([{"n": 1}], lambda p, f: result(1.0), lambda p, f: {"ok": False, "error": "timeout"})
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=[{"n": 1}], run=run)
    assert res["ok"] is False and "test run failed" in res["error"] and "timeout" in res["error"]


@pytest.mark.parametrize(
    "kw,msg",
    [
        ({"candidates": []}, "candidates"),
        ({"candidates": [{"n": i} for i in range(11)]}, "candidates"),
        ({"candidates": ["not-a-dict"]}, "candidates"),
        ({"train_days": 19}, "train_days"),
        ({"test_days": 4}, "test_days"),
    ],
)
def test_limits_checked_before_runs(kw, msg):
    run, calls = fake_run([{"n": 1}], lambda p, f: result(1.0), lambda p, f: result(1.0))
    res = walk_forward(**{**BASE, "run": run, **kw})
    assert res["ok"] is False and msg in res["error"]
    assert calls == []


def test_unknown_metric_rejected_before_runs():
    run, calls = fake_run([{"n": 1}], lambda p, f: result(1.0), lambda p, f: result(1.0))
    res = walk_forward(**{**BASE, "run": run, "metric": "sortino"})
    assert res["ok"] is False and "metric" in res["error"]
    assert calls == []


def test_too_many_runs_rejected_before_any_run():
    cands = [{"n": i} for i in range(10)]
    run, calls = fake_run(cands, lambda p, f: result(1.0), lambda p, f: result(1.0))
    res = walk_forward(**{**BASE, "candidates": cands, "run": run})
    assert res == {"ok": False, "error": "too many runs"}
    assert calls == []


def test_sixty_runs_allowed():
    cands = [{"n": i} for i in range(9)]
    run, calls = fake_run(cands, lambda p, f: result(1.0), lambda p, f: result(1.0))
    res = walk_forward(**{**BASE, "candidates": cands, "run": run})
    assert res["ok"] is True
    assert res["summary"]["folds"] == 6
    assert len(calls) == 60


def test_oos_equity_chains_and_scales():
    eq = {
        0: [{"date": "2024-01-21", "value": 100.0}, {"date": "2024-01-22", "value": 110.0}],
        1: [{"date": "2024-01-26", "value": 200.0}, {"date": "2024-01-27", "value": 220.0}],
    }
    test_scores = {0: 1.0, 1: 3.0}
    run, calls = fake_run([{"n": 1}], lambda p, f: result(1.0), lambda p, f: result(test_scores[f], eq[f]))
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-31", train_days=20, test_days=5,
                       candidates=[{"n": 1}], run=run)
    assert res["ok"] is True and len(res["folds"]) == 2
    assert [p["date"] for p in res["oos_equity"]] == ["2024-01-21", "2024-01-22", "2024-01-26", "2024-01-27"]
    values = [p["value"] for p in res["oos_equity"]]
    assert values[0] == pytest.approx(100.0)
    assert values[1] == pytest.approx(110.0)
    assert values[2] == pytest.approx(110.0)  # 200 rescaled to start at 110
    assert values[3] == pytest.approx(121.0)  # 220 rescaled to start at 110
    assert res["summary"] == {"folds": 2, "mean_test_sharpe": 2.0, "positive_folds": 2}


def test_metric_selects_requested_key():
    def train(p, f):
        return {"ok": True, "metrics": {"sharpe": 5.0, "calmar": 1.0}, "equity": [], "warnings": []}

    run, calls = fake_run([{"n": 1}], train, lambda p, f: {"ok": True, "metrics": {"calmar": 0.5}, "equity": []})
    res = walk_forward("x", ["A"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                       candidates=[{"n": 1}], metric="calmar", run=run)
    assert res["ok"] is True and res["metric"] == "calmar"
    assert res["folds"][0]["train_score"] == 1.0
    assert res["summary"]["mean_test_calmar"] == 0.5


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BT_TOKEN", TOKEN)
    monkeypatch.setenv("BT_TIMEOUT_S", "77")
    monkeypatch.delenv("BT_MAX_CONCURRENCY", raising=False)
    monkeypatch.setattr(app_mod, "_sem", None)
    calls = []

    def fake(**kw):
        calls.append(kw)
        return {"ok": True, "metric": "sharpe", "folds": [], "oos_equity": [], "summary": {}, "warnings": []}

    monkeypatch.setattr(app_mod, "walk_forward", fake)
    with TestClient(app_mod.app) as c:
        c.calls = calls
        yield c


BODY = {
    "code": "x",
    "symbols": ["A"],
    "start": "2024-01-01",
    "end": "2024-02-20",
    "train_days": 20,
    "test_days": 5,
    "candidates": [{"n": 1}],
}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN}])
def test_route_401(client, headers):
    assert client.post("/walkforward", json=BODY, headers=headers).status_code == 401
    assert client.calls == []


def test_route_422_extra_field(client):
    r = client.post("/walkforward", json={**BODY, "timeout_s": 5}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


@pytest.mark.parametrize("field,value", [("start", "2024-1-1"), ("end", "nope"), ("start", "2024-13-01")])
def test_route_422_bad_dates(client, field, value):
    r = client.post("/walkforward", json={**BODY, field: value}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


def test_route_422_bad_metric(client):
    r = client.post("/walkforward", json={**BODY, "metric": "sortino"}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


def test_route_happy_path_passes_args(client):
    r = client.post(
        "/walkforward",
        json={**BODY, "capital": 5000, "costs": {"a": 1}, "source": "local", "interval": "1H", "metric": "calmar"},
        headers=HDR,
    )
    assert r.status_code == 200 and r.json()["ok"] is True
    kw = client.calls[0]
    assert kw["code"] == "x" and kw["symbols"] == ["A"] and kw["start"] == "2024-01-01"
    assert kw["train_days"] == 20 and kw["test_days"] == 5 and kw["candidates"] == [{"n": 1}]
    assert kw["metric"] == "calmar" and kw["interval"] == "1H"
    assert kw["capital"] == 5000 and kw["costs"] == {"a": 1} and kw["source"] == "local"
    assert kw["timeout_s"] == 77 and "signal_parameters" not in kw


def test_route_ok_false_is_200(client, monkeypatch):
    monkeypatch.setattr(app_mod, "walk_forward", lambda **kw: {"ok": False, "error": "range too short for one fold"})
    r = client.post("/walkforward", json=BODY, headers=HDR)
    assert r.status_code == 200 and r.json()["ok"] is False
