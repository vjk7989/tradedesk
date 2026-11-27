"""Edge tests for OC-P7.3 walk-forward. All runs go through an injected fake `run`; no subprocesses."""
from __future__ import annotations

import functools
import json
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from bt_service import app as app_mod
from bt_service.walkforward import walk_forward

TOKEN = "wf-s3cr3t-" + "k" * 24
HDR = {"Authorization": f"Bearer {TOKEN}"}
JSON_HDR = {**HDR, "Content-Type": "application/json"}
MIB = 1024 * 1024


def _d(s: str) -> date:
    return date.fromisoformat(s)


def _days(kw) -> int:
    """Calendar days covered by a run call. runner `end` is inclusive, so a run over the
    half-open fold [s, e) is called with end = e - 1 day and covers (end - start) + 1 days."""
    return (_d(kw["end"]) - _d(kw["start"])).days + 1


def _run_span(fold_window) -> list[str]:
    """Run-call [start, end] expected for a reported half-open fold window [s, e)."""
    s, e = fold_window
    return [s, (_d(e) - timedelta(days=1)).isoformat()]


class Recorder:
    """Fake `run`. Classifies each call as train/test by its inclusive span (not by call order).

    train(params, kw) / test(params, kw) return the result dict. Every call is recorded.
    """

    def __init__(self, train_days, test_days, train=None, test=None):
        self.train_days, self.test_days = train_days, test_days
        self.train = train or (lambda p, kw: ok(1.0))
        self.test = test or (lambda p, kw: ok(1.0))
        self.calls: list[dict] = []

    def __call__(self, **kw):
        self.calls.append(kw)
        n = _days(kw)
        if n == self.train_days and n != self.test_days:
            return self.train(kw["signal_parameters"], kw)
        if n == self.test_days:
            return self.test(kw["signal_parameters"], kw)
        raise AssertionError(f"unexpected window {kw['start']}..{kw['end']}")

    def train_calls(self):
        return [c for c in self.calls if _days(c) == self.train_days]

    def test_calls(self):
        return [c for c in self.calls if _days(c) == self.test_days]


def ok(score=None, equity=None, metric="sharpe", **metrics):
    m = dict(metrics)
    if score is not None:
        m[metric] = score
    return {"ok": True, "metrics": m, "equity": equity if equity is not None else [], "trades": [], "warnings": []}


def wf(rec, start, end, train_days=20, test_days=5, candidates=({"n": 1},), **kw):
    return walk_forward("x", ["A"], start, end, train_days=train_days, test_days=test_days,
                        candidates=list(candidates), run=rec, **kw)


# ---------------------------------------------------------------- fold boundaries (AC 1)

def test_exact_fit_single_fold_and_last_test_end_equals_end():
    rec = Recorder(20, 5)
    res = wf(rec, "2024-03-01", "2024-03-26")
    assert res["ok"] is True and res["summary"]["folds"] == 1
    assert res["folds"][0]["test"] == ["2024-03-21", "2024-03-26"]
    assert len(rec.calls) == 2


def test_one_day_short_is_error_and_no_runs():
    rec = Recorder(20, 5)
    res = wf(rec, "2024-03-01", "2024-03-25")
    assert res == {"ok": False, "error": "range too short for one fold"}
    assert rec.calls == []


def test_range_shorter_than_train_plus_test_is_error():
    rec = Recorder(30, 10)
    res = wf(rec, "2024-01-01", "2024-01-20", train_days=30, test_days=10)
    assert res["ok"] is False and res["error"] == "range too short for one fold"
    assert rec.calls == []


@pytest.mark.parametrize("start,end", [("2024-05-05", "2024-05-05"), ("2024-06-01", "2024-05-01")])
def test_start_equal_or_after_end_is_error(start, end):
    rec = Recorder(20, 5)
    res = wf(rec, start, end)
    assert res["ok"] is False and "too short" in res["error"]
    assert rec.calls == []


def test_one_day_more_than_exact_fit_still_one_fold():
    rec = Recorder(20, 5)
    res = wf(rec, "2024-03-01", "2024-03-27")
    assert res["summary"]["folds"] == 1


def test_many_folds_contiguous_and_last_not_past_end():
    # 30 folds * (1 + 1) = 60 runs: exactly at the cap.
    start = _d("2024-01-01")
    end = start + timedelta(days=20 + 5 * 30 + 4)  # 4 spare days: not enough for fold 31
    rec = Recorder(20, 5)
    res = wf(rec, start.isoformat(), end.isoformat())
    assert res["ok"] is True and res["summary"]["folds"] == 30 and len(rec.calls) == 60
    folds = res["folds"]
    for a, b in zip(folds, folds[1:]):
        assert _d(b["train"][0]) - _d(a["train"][0]) == timedelta(days=5)
        assert b["test"][0] == a["test"][1]
    for f in folds:
        assert _d(f["train"][1]) - _d(f["train"][0]) == timedelta(days=20)
        assert f["train"][1] == f["test"][0]
        assert _d(f["test"][1]) - _d(f["test"][0]) == timedelta(days=5)
    assert _d(folds[-1]["test"][1]) <= end
    assert max(_d(c["end"]) for c in rec.calls) <= end


def test_leap_day_window():
    rec = Recorder(28, 5)
    res = wf(rec, "2024-02-01", "2024-03-05", train_days=28)
    assert res["folds"][0]["train"] == ["2024-02-01", "2024-02-29"]
    assert res["folds"][0]["test"] == ["2024-02-29", "2024-03-05"]


def test_non_leap_month_end():
    rec = Recorder(28, 5)
    res = wf(rec, "2023-01-31", "2023-03-05", train_days=28)
    assert res["folds"][0]["train"] == ["2023-01-31", "2023-02-28"]
    assert res["folds"][0]["test"] == ["2023-02-28", "2023-03-05"]


def test_year_boundary():
    rec = Recorder(20, 5)
    res = wf(rec, "2023-12-20", "2024-01-14")
    assert res["folds"][0]["train"] == ["2023-12-20", "2024-01-09"]
    assert res["folds"][0]["test"] == ["2024-01-09", "2024-01-14"]


def test_end_near_date_max_does_not_crash():
    """Loop probes t0+train+test past date.max -> OverflowError. Must fail closed, not raise."""
    rec = Recorder(20, 5)
    res = wf(rec, "9999-12-01", "9999-12-31")
    assert isinstance(res, dict) and res["ok"] in (True, False)


def test_huge_train_days_does_not_crash():
    rec = Recorder(10**6, 5)
    res = wf(rec, "2024-01-01", "2024-12-31", train_days=10**6)
    assert res["ok"] is False and rec.calls == []


# ---------------------------------------------------------------- leakage (AC 2)

def _realistic(start, end, base=100.0):
    """Runner semantics: `end` is INCLUSIVE (local_loader keeps bars < end+1day)."""
    d0, d1 = _d(start), _d(end)
    return [{"date": (d0 + timedelta(days=i)).isoformat(), "value": base + i} for i in range((d1 - d0).days + 1)]


def test_test_best_train_worst_never_chosen_multi_fold():
    cands = [{"n": "oos_hero"}, {"n": "mid"}, {"n": "train_hero"}]
    tr = {"oos_hero": -1.0, "mid": 0.2, "train_hero": 0.9}
    te = {"oos_hero": 50.0, "mid": 0.0, "train_hero": -0.5}
    rec = Recorder(20, 5, train=lambda p, kw: ok(tr[p["n"]]), test=lambda p, kw: ok(te[p["n"]]))
    res = wf(rec, "2024-01-01", "2024-02-10", candidates=cands)
    assert res["ok"] is True and res["summary"]["folds"] == 4
    assert all(f["chosen"] == {"n": "train_hero"} for f in res["folds"])
    assert all(f["train_score"] == 0.9 for f in res["folds"])
    assert res["summary"]["mean_test_sharpe"] == -0.5
    assert all(c["signal_parameters"]["n"] != "oos_hero" for c in rec.test_calls())


def test_selection_can_change_per_fold_from_train_only():
    cands = [{"n": "a"}, {"n": "b"}]

    def train(p, kw):
        early = _d(kw["start"]) < _d("2024-01-06")
        return ok((1.0 if p["n"] == "a" else 0.0) if early else (0.0 if p["n"] == "a" else 1.0))

    # test results would favour the opposite every time
    rec = Recorder(20, 5, train=train, test=lambda p, kw: ok(-1.0 if p["n"] == "a" else 9.0))
    res = wf(rec, "2024-01-01", "2024-01-31", candidates=cands)
    assert [f["chosen"]["n"] for f in res["folds"]] == ["a", "b"]


def test_every_call_recorded_test_runs_only_chosen_once_per_fold():
    cands = [{"n": i} for i in range(4)]
    rec = Recorder(20, 5, train=lambda p, kw: ok(float(p["n"] % 3)))  # n=2 is best; n=3 ties lower
    res = wf(rec, "2024-01-01", "2024-02-05", candidates=cands)
    nf = res["summary"]["folds"]
    assert nf == 3 and len(rec.calls) == nf * (len(cands) + 1)
    tests = rec.test_calls()
    assert len(tests) == nf
    for f in res["folds"]:
        window = [c for c in tests if [c["start"], c["end"]] == _run_span(f["test"])]
        assert len(window) == 1
        assert window[0]["signal_parameters"] == f["chosen"] == {"n": 2}
        trains = [c for c in rec.train_calls() if [c["start"], c["end"]] == _run_span(f["train"])]
        assert [c["signal_parameters"] for c in trains] == cands  # every candidate, once, in order
    # each fold's train runs happen before its test run
    for i in range(nf):
        block = rec.calls[i * 5:(i + 1) * 5]
        assert [_days(c) for c in block] == [20, 20, 20, 20, 5]


def test_passthrough_args_reach_every_run():
    rec = Recorder(20, 5)
    walk_forward("CODE", ["S1", "S2"], "2024-01-01", "2024-01-26", train_days=20, test_days=5,
                 candidates=[{"n": 1}], interval="1H", capital=123.0, costs={"c": 1}, source="local",
                 timeout_s=9, run=rec)
    for c in rec.calls:
        assert (c["code"], c["symbols"], c["interval"], c["capital"], c["costs"], c["source"], c["timeout_s"]) == (
            "CODE", ["S1", "S2"], "1H", 123.0, {"c": 1}, "local", 9)


def test_train_run_does_not_include_first_test_day():
    """run_backtest's `end` is inclusive (local_loader: index < end + 1 day). Train window is
    [t0, t0+train_days) per spec, so the train run's `end` must be strictly before the SAME
    fold's test start (folds overlap by design, so pair by fold, not by date order)."""
    rec = Recorder(20, 5)
    res = wf(rec, "2024-01-01", "2024-01-31")
    assert res["ok"] is True and res["summary"]["folds"] == 2
    for f in res["folds"]:
        trains = [c for c in rec.train_calls() if c["start"] == f["train"][0]]
        tests = [c for c in rec.test_calls() if c["start"] == f["test"][0]]
        assert len(trains) == 1 and len(tests) == 1
        tr, te = trains[0], tests[0]
        assert _d(tr["end"]) < _d(te["start"]), f"train {tr['start']}..{tr['end']} sees test day {te['start']}"
        assert _d(te["start"]) - _d(tr["end"]) == timedelta(days=1)  # no gap either
        assert _d(te["end"]) < _d(f["test"][1])  # test run stays inside [s, e)


def test_oos_equity_dates_strictly_increasing_with_inclusive_runner():
    rec = Recorder(20, 5, test=lambda p, kw: ok(1.0, _realistic(kw["start"], kw["end"])))
    res = wf(rec, "2024-01-01", "2024-01-31")
    dates = [p["date"] for p in res["oos_equity"]]
    assert dates == sorted(set(dates)), "consecutive test windows overlap on a shared boundary day"


# ---------------------------------------------------------------- ties / non-finite / failure (AC 3)

def test_ties_go_to_first_even_when_later_and_earlier_equal_best():
    cands = [{"n": 0}, {"n": 1}, {"n": 2}, {"n": 3}]
    sc = {0: 0.1, 1: 0.7, 2: 0.7, 3: 0.7}
    rec = Recorder(20, 5, train=lambda p, kw: ok(sc[p["n"]]))
    res = wf(rec, "2024-01-01", "2024-01-26", candidates=cands)
    assert res["folds"][0]["chosen"] == {"n": 1}


def test_tie_between_int_and_float_goes_to_first():
    cands = [{"n": "int"}, {"n": "float"}]
    rec = Recorder(20, 5, train=lambda p, kw: ok(1 if p["n"] == "int" else 1.0))
    res = wf(rec, "2024-01-01", "2024-01-26", candidates=cands)
    assert res["folds"][0]["chosen"] == {"n": "int"}


@pytest.mark.parametrize("bad", [
    {"ok": True, "metrics": {"sharpe": float("nan")}},
    {"ok": True, "metrics": {"sharpe": float("inf")}},
    {"ok": True, "metrics": {"sharpe": float("-inf")}},
    {"ok": True, "metrics": {"sharpe": None}},
    {"ok": True, "metrics": {}},
    {"ok": True, "metrics": {"total_return": 99.0}},
    {"ok": True, "metrics": {"sharpe": "9.9"}},
    {"ok": True, "metrics": {"sharpe": True}},
    {"ok": True, "metrics": None},
    {"ok": True},
    {"ok": False, "metrics": {"sharpe": 99.0}, "error": "boom"},
    {"metrics": {"sharpe": 99.0}},
])
def test_invalid_scores_skipped(bad):
    cands = [{"n": "bad"}, {"n": "good"}]
    rec = Recorder(20, 5, train=lambda p, kw: dict(bad) if p["n"] == "bad" else ok(-3.0))
    res = wf(rec, "2024-01-01", "2024-01-26", candidates=cands)
    assert res["ok"] is True
    assert res["folds"][0]["chosen"] == {"n": "good"} and res["folds"][0]["train_score"] == -3.0


def test_negative_best_is_still_chosen():
    cands = [{"n": 0}, {"n": 1}]
    rec = Recorder(20, 5, train=lambda p, kw: ok(-5.0 if p["n"] == 0 else -0.1))
    res = wf(rec, "2024-01-01", "2024-01-26", candidates=cands)
    assert res["folds"][0]["chosen"] == {"n": 1}


def test_all_fail_in_second_fold_clear_error_no_test_run():
    cands = [{"n": 0}, {"n": 1}]

    def train(p, kw):
        return ok(1.0) if kw["start"] == "2024-01-01" else {"ok": False, "error": "no data"}

    rec = Recorder(20, 5, train=train)
    res = wf(rec, "2024-01-01", "2024-01-31", candidates=cands)
    assert res["ok"] is False
    assert "fold 1" in res["error"] and "sharpe" in res["error"]
    assert res["error"] == "fold 1: no candidate produced a finite sharpe: no data"
    # TM2-38 (AC change): the completed fold 0 is kept; fold 1 never reached a test run, so it is absent.
    # Both candidates tie at 1.0 in fold 0; the strict ">" keeps the first, {"n": 0}.
    assert res["folds"] == [{
        "train": ["2024-01-01", "2024-01-21"],
        "test": ["2024-01-21", "2024-01-26"],
        "chosen": {"n": 0},
        "train_score": 1.0,
        "test_metrics": {"sharpe": 1.0},
    }]
    assert res["warnings"] == []
    assert "oos_equity" not in res and "summary" not in res
    assert len(rec.calls) == 3 + 2  # fold 0 complete, fold 1 trains only
    assert len(rec.test_calls()) == 1


def test_all_fail_first_fold_mentions_metric_name():
    rec = Recorder(20, 5, train=lambda p, kw: ok(float("nan"), metric="calmar"))
    res = wf(rec, "2024-01-01", "2024-01-26", metric="calmar")
    assert res["ok"] is False and "fold 0" in res["error"] and "calmar" in res["error"]
    assert rec.test_calls() == []


# ---------------------------------------------------------------- limits before any run (AC 4)

LIMIT_BASE = dict(code="x", symbols=["A"], start="2024-01-01", end="2024-02-20", train_days=20, test_days=5,
                  candidates=[{"n": 1}])


@pytest.mark.parametrize("kw,needle", [
    ({"candidates": []}, "candidates"),
    ({"candidates": [{"n": i} for i in range(11)]}, "candidates"),
    ({"candidates": [{"n": 1}, None]}, "candidates"),
    ({"candidates": [{"n": 1}, [("n", 2)]]}, "candidates"),
    ({"candidates": None}, "candidates"),
    ({"candidates": {"n": 1}}, "candidates"),
    ({"train_days": 19}, "train_days"),
    ({"train_days": 0}, "train_days"),
    ({"train_days": -20}, "train_days"),
    ({"train_days": 20.0}, "train_days"),
    ({"train_days": True}, "train_days"),
    ({"test_days": 4}, "test_days"),
    ({"test_days": 0}, "test_days"),
    ({"test_days": 5.5}, "test_days"),
    ({"metric": "sortino"}, "metric"),
    ({"metric": ""}, "metric"),
    ({"metric": "Sharpe"}, "metric"),
    ({"start": "2024/01/01"}, "ISO"),
    ({"end": None}, "ISO"),
])
def test_limits_rejected_with_zero_runs(kw, needle):
    calls = []
    res = walk_forward(**{**LIMIT_BASE, **kw, "run": lambda **k: calls.append(k) or ok(1.0)})
    assert res["ok"] is False and needle in res["error"]
    assert calls == []


@pytest.mark.parametrize("n", [1, 10])
def test_candidate_count_boundaries_accepted(n):
    # 10 candidates: 11 runs/fold; with a 1-fold range that is within the cap.
    calls = []
    res = walk_forward(**{**LIMIT_BASE, "end": "2024-01-26", "candidates": [{"n": i} for i in range(n)],
                          "run": lambda **k: calls.append(k) or ok(1.0)})
    assert res["ok"] is True and len(calls) == n + 1


def test_train20_test5_minimums_accepted():
    calls = []
    res = walk_forward(**{**LIMIT_BASE, "end": "2024-01-26", "run": lambda **k: calls.append(k) or ok(1.0)})
    assert res["ok"] is True and len(calls) == 2


@pytest.mark.parametrize("ncand,end,runs,allowed", [
    (3, (date(2024, 1, 1) + timedelta(days=20 + 5 * 15)).isoformat(), 60, True),   # 15 folds * 4
    (3, (date(2024, 1, 1) + timedelta(days=20 + 5 * 16)).isoformat(), 64, False),  # 16 folds * 4
    (1, (date(2024, 1, 1) + timedelta(days=20 + 5 * 30)).isoformat(), 60, True),   # 30 folds * 2
    (1, (date(2024, 1, 1) + timedelta(days=20 + 5 * 31)).isoformat(), 62, False),  # 31 folds * 2 (61 unreachable)
    (10, (date(2024, 1, 1) + timedelta(days=20 + 5 * 5)).isoformat(), 55, True),
    (10, (date(2024, 1, 1) + timedelta(days=20 + 5 * 6)).isoformat(), 66, False),
])
def test_run_cap_boundary(ncand, end, runs, allowed):
    calls = []
    res = walk_forward(**{**LIMIT_BASE, "end": end, "candidates": [{"n": i} for i in range(ncand)],
                          "run": lambda **k: calls.append(k) or ok(1.0)})
    if allowed:
        assert res["ok"] is True and len(calls) == runs
    else:
        assert res == {"ok": False, "error": "too many runs"} and calls == []


# ---------------------------------------------------------------- OOS chaining

def _eq(*vals, start="2024-02-01"):
    d0 = _d(start)
    return [{"date": (d0 + timedelta(days=i)).isoformat(), "value": v} for i, v in enumerate(vals)]


def _run_with_equities(eqs, start="2024-01-01", nfolds=None):
    nfolds = nfolds or len(eqs)
    end = (_d(start) + timedelta(days=20 + 5 * nfolds)).isoformat()
    order = iter(range(len(eqs)))
    rec = Recorder(20, 5, test=lambda p, kw: ok(1.0, eqs[next(order)]))
    return wf(rec, start, end)


def test_chain_three_folds_continuous():
    res = _run_with_equities([_eq(100.0, 120.0), _eq(50.0, 40.0, 60.0), _eq(10.0, 11.0)])
    vals = [p["value"] for p in res["oos_equity"]]
    assert len(vals) == 7
    assert vals[2] == pytest.approx(vals[1])  # fold1 first == fold0 last
    assert vals[5] == pytest.approx(vals[4])  # fold2 first == fold1 last
    assert vals == pytest.approx([100.0, 120.0, 120.0, 96.0, 144.0, 144.0, 158.4])


def test_first_fold_not_rescaled():
    res = _run_with_equities([_eq(1_000_000.0, 1_010_000.0)])
    assert [p["value"] for p in res["oos_equity"]] == [1_000_000.0, 1_010_000.0]


@pytest.mark.parametrize("first", [0, 0.0, None, float("nan")])
def test_fold_first_value_zero_or_missing_no_crash(first):
    eqs = [_eq(100.0, 110.0), _eq(first, 5.0, 6.0)]
    res = _run_with_equities(eqs)
    assert res["ok"] is True
    vals = [p["value"] for p in res["oos_equity"]]
    assert len(vals) == 5
    # Observed behaviour: no rescale for that fold (scale stays 1).
    assert vals[3:] == [5.0, 6.0]


def test_fold_first_point_missing_value_key_no_crash():
    eqs = [_eq(100.0, 110.0), [{"date": "2024-02-01"}, {"date": "2024-02-02", "value": 7.0}]]
    res = _run_with_equities(eqs)
    assert res["ok"] is True and len(res["oos_equity"]) == 4


def test_negative_first_value_no_crash():
    res = _run_with_equities([_eq(100.0, 110.0), _eq(-10.0, -5.0)])
    assert res["ok"] is True


def test_empty_equity_middle_fold_chains_to_previous_nonempty():
    res = _run_with_equities([_eq(100.0, 110.0), [], _eq(50.0, 55.0)])
    vals = [p["value"] for p in res["oos_equity"]]
    assert vals == pytest.approx([100.0, 110.0, 110.0, 121.0])


def test_all_equity_empty_or_missing():
    rec = Recorder(20, 5, test=lambda p, kw: {"ok": True, "metrics": {"sharpe": 1.0}})
    res = wf(rec, "2024-01-01", "2024-01-31")
    assert res["ok"] is True and res["oos_equity"] == []


def test_oos_equity_none_values_pass_through_and_serialise():
    """runner._num maps NaN/inf to None, so None is the realistic gap value."""
    res = _run_with_equities([_eq(100.0, None, 110.0), _eq(50.0, None, 55.0)])
    vals = [p["value"] for p in res["oos_equity"]]
    assert [v is None for v in vals] == [False, True, False, False, True, False]
    assert [v for v in vals if v is not None] == pytest.approx([100.0, 110.0, 110.0, 121.0])
    json.dumps(res, allow_nan=False)


# ---------------------------------------------------------------- summary math & metrics

def test_summary_mean_and_positive_folds_known_numbers():
    scores = iter([1.0, -2.0, 0.0, 3.5])
    rec = Recorder(20, 5, test=lambda p, kw: ok(next(scores)))
    res = wf(rec, "2024-01-01", "2024-02-10")
    assert res["summary"] == {"folds": 4, "mean_test_sharpe": 0.625, "positive_folds": 2, "scored_folds": 4}


def test_summary_rounds_to_6dp():
    scores = iter([1.0, 1.0, 2.0])
    rec = Recorder(20, 5, test=lambda p, kw: ok(next(scores)))
    res = wf(rec, "2024-01-01", "2024-02-05")
    assert res["summary"]["mean_test_sharpe"] == 1.333333


def test_summary_skips_non_finite_test_metric():
    scores = iter([2.0, float("nan"), 4.0])
    rec = Recorder(20, 5, test=lambda p, kw: ok(next(scores)))
    res = wf(rec, "2024-01-01", "2024-02-05")
    assert res["summary"] == {"folds": 3, "mean_test_sharpe": 3.0, "positive_folds": 2, "scored_folds": 2}


def test_summary_all_test_metrics_missing_mean_is_none():
    rec = Recorder(20, 5, test=lambda p, kw: {"ok": True, "metrics": {}, "equity": []})
    res = wf(rec, "2024-01-01", "2024-01-31")
    assert res["summary"] == {"folds": 2, "mean_test_sharpe": None, "positive_folds": 0, "scored_folds": 0}


@pytest.mark.parametrize("metric", ["sharpe", "total_return", "calmar"])
def test_each_metric_selects_on_its_own_key(metric):
    cands = [{"n": "a"}, {"n": "b"}]
    others = [m for m in ("sharpe", "total_return", "calmar") if m != metric]

    def train(p, kw):
        mine = 2.0 if p["n"] == "b" else 1.0
        return {"ok": True, "metrics": {metric: mine, **{o: (9.0 if p["n"] == "a" else 0.0) for o in others}}}

    rec = Recorder(20, 5, train=train, test=lambda p, kw: {"ok": True, "metrics": {metric: -0.25}})
    res = wf(rec, "2024-01-01", "2024-01-26", candidates=cands, metric=metric)
    assert res["ok"] is True and res["metric"] == metric
    assert res["folds"][0]["chosen"] == {"n": "b"}
    assert res["summary"] == {"folds": 1, f"mean_test_{metric}": -0.25, "positive_folds": 0,
                              "scored_folds": 1}


def test_metric_keys_exist_in_runner_metrics_csv_names():
    """The three allowed metrics must be real metrics.csv column names produced by the engine."""
    from pathlib import Path
    root = Path(app_mod.__file__).resolve().parents[1] / "vibe_bt"
    text = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in root.rglob("*.py"))
    for key in ("sharpe", "total_return", "calmar"):
        assert f'"{key}"' in text or f"'{key}'" in text, key


def test_test_run_failure_after_warnings_is_error():
    rec = Recorder(20, 5, test=lambda p, kw: {"ok": False, "warnings": ["w"]})
    res = wf(rec, "2024-01-01", "2024-01-26")
    assert res["ok"] is False and "test run failed" in res["error"]


def test_warnings_prefixed_with_fold():
    rec = Recorder(20, 5, train=lambda p, kw: {**ok(1.0), "warnings": ["tw"]},
                   test=lambda p, kw: {**ok(1.0), "warnings": ["sw"]})
    res = wf(rec, "2024-01-01", "2024-01-31")
    assert res["warnings"] == ["fold 0: tw", "fold 0: sw", "fold 1: tw", "fold 1: sw"]


# ---------------------------------------------------------------- route /walkforward

BODY = {
    "code": "x",
    "symbols": ["A"],
    "start": "2024-01-01",
    "end": "2024-01-31",
    "train_days": 20,
    "test_days": 5,
    "candidates": [{"n": 1}, {"n": 2}],
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BT_TOKEN", TOKEN)
    monkeypatch.setenv("BT_TIMEOUT_S", "77")
    monkeypatch.delenv("BT_MAX_CONCURRENCY", raising=False)
    monkeypatch.setattr(app_mod, "_sem", None)
    monkeypatch.setattr(app_mod, "BUSY_WAIT_S", 0.3)
    rec = Recorder(20, 5, train=lambda p, kw: ok(float(p["n"])),
                   test=lambda p, kw: ok(0.5, _eq(100.0, 101.0, start=kw["start"])))
    monkeypatch.setattr(app_mod, "walk_forward", functools.partial(walk_forward, run=rec))
    with TestClient(app_mod.app, raise_server_exceptions=False) as c:
        c.rec = rec
        yield c


def _no_secret(r):
    assert TOKEN not in r.text
    assert all(TOKEN not in v for v in r.headers.values())


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer nope"}, {"Authorization": f"bearer {TOKEN}"},
                                     {"Authorization": f"Bearer {TOKEN}x"}])
def test_route_401(client, headers):
    r = client.post("/walkforward", json=BODY, headers=headers)
    assert r.status_code == 401 and client.rec.calls == []
    _no_secret(r)


def test_route_unconfigured_token_503(client, monkeypatch):
    monkeypatch.setenv("BT_TOKEN", "short")
    r = client.post("/walkforward", json=BODY, headers={"Authorization": "Bearer short"})
    assert r.status_code == 503 and client.rec.calls == []


@pytest.mark.parametrize("extra", [{"timeout_s": 5}, {"run": "x"}, {"signal_parameters": {}}, {"token": TOKEN}])
def test_route_422_extra_fields(client, extra):
    r = client.post("/walkforward", json={**BODY, **extra}, headers=HDR)
    assert r.status_code == 422 and client.rec.calls == []
    _no_secret(r)


@pytest.mark.parametrize("field,val", [
    ("start", "2024-02-30"), ("end", "2023-02-29"), ("start", "2024/01/01"), ("start", "20240101"),
    ("end", "2024-01-01T00:00"), ("start", ""), ("end", 20240101), ("start", None),
])
def test_route_422_bad_dates(client, field, val):
    r = client.post("/walkforward", json={**BODY, field: val}, headers=HDR)
    assert r.status_code == 422 and client.rec.calls == []


@pytest.mark.parametrize("patch", [
    {"metric": "sortino"}, {"candidates": ["x"]}, {"candidates": "x"}, {"train_days": "abc"},
    {"capital": 0}, {"capital": -1},
])
def test_route_422_bad_fields(client, patch):
    r = client.post("/walkforward", json={**BODY, **patch}, headers=HDR)
    assert r.status_code == 422 and client.rec.calls == []


@pytest.mark.parametrize("missing", ["code", "symbols", "start", "end", "train_days", "test_days", "candidates"])
def test_route_422_missing_required(client, missing):
    body = {k: v for k, v in BODY.items() if k != missing}
    assert client.post("/walkforward", json=body, headers=HDR).status_code == 422


def test_route_200_end_to_end_with_fake_run(client):
    r = client.post("/walkforward", json=BODY, headers=HDR)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["metric"] == "sharpe" and body["summary"]["folds"] == 2
    assert all(f["chosen"] == {"n": 2} for f in body["folds"])
    assert len(client.rec.calls) == 6
    assert all(c["timeout_s"] == 77 for c in client.rec.calls)
    _no_secret(r)


@pytest.mark.parametrize("patch,needle", [
    ({"train_days": 19}, "train_days"), ({"test_days": 4}, "test_days"),
    ({"candidates": []}, "candidates"), ({"candidates": [{"n": i} for i in range(11)]}, "candidates"),
    ({"end": "2024-01-25"}, "too short"), ({"end": "2024-12-31", "candidates": [{"n": 1}] * 10}, "too many runs"),
])
def test_route_limits_200_ok_false_no_runs(client, patch, needle):
    r = client.post("/walkforward", json={**BODY, **patch}, headers=HDR)
    assert r.status_code == 200 and r.json()["ok"] is False and needle in r.json()["error"]
    assert client.rec.calls == []


def test_route_timeout_env_clamped(client, monkeypatch):
    monkeypatch.setenv("BT_TIMEOUT_S", "999999")
    assert client.post("/walkforward", json=BODY, headers=HDR).status_code == 200
    # per-run timeout = min(clamped BT_TIMEOUT_S=3600, remaining of the default 600 s budget)
    ts = [c["timeout_s"] for c in client.rec.calls]
    assert ts and all(590 < t <= 600 for t in ts)
    assert ts == sorted(ts, reverse=True)


def test_route_semaphore_released_after_exception(client, monkeypatch):
    def boom(**kw):
        raise RuntimeError(f"kaboom {TOKEN}")

    good = app_mod.walk_forward
    monkeypatch.setattr(app_mod, "walk_forward", boom)
    r = client.post("/walkforward", json=BODY, headers=HDR)
    assert r.status_code == 500
    _no_secret(r)
    assert "kaboom" not in r.text and "Traceback" not in r.text
    monkeypatch.setattr(app_mod, "walk_forward", good)
    r2 = client.post("/walkforward", json=BODY, headers=HDR)
    assert r2.status_code == 200, r2.text  # not 429


def test_route_semaphore_released_after_run_raises_inside_walk_forward(client, monkeypatch):
    def run(**kw):
        raise RuntimeError("engine exploded")

    monkeypatch.setattr(app_mod, "walk_forward", functools.partial(walk_forward, run=run))
    assert client.post("/walkforward", json=BODY, headers=HDR).status_code == 500
    monkeypatch.setattr(app_mod, "walk_forward", functools.partial(walk_forward, run=client.rec))
    assert client.post("/walkforward", json=BODY, headers=HDR).status_code == 200


def test_route_shares_semaphore_with_backtest(client, monkeypatch):
    """Walk-forward holds the same semaphore as /backtest for its whole run."""
    import threading

    gate, entered = threading.Event(), threading.Event()

    def slow(**kw):
        entered.set()
        gate.wait(5)
        return ok(1.0)

    monkeypatch.setattr(app_mod, "walk_forward", functools.partial(walk_forward, run=slow))
    monkeypatch.setattr(app_mod, "run_backtest", lambda **kw: {"ok": True})
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", client.post("/walkforward", json=BODY, headers=HDR)))
    t.start()
    try:
        assert entered.wait(5)
        r = client.post("/backtest", json={"code": "x", "symbols": ["A"], "start": "2024-01-01",
                                           "end": "2024-02-01"}, headers=HDR)
        assert r.status_code == 429
    finally:
        gate.set()
        t.join(10)
    assert out["r"].status_code == 200


def _padded(size):
    base = json.dumps({**BODY, "code": ""})
    body = json.dumps({**BODY, "code": "y" * (size - len(base))}).encode()
    assert len(body) == size
    return body


def test_route_body_over_1mib_413(client):
    r = client.post("/walkforward", content=_padded(MIB + 1), headers=JSON_HDR)
    assert r.status_code == 413 and client.rec.calls == []


def test_route_body_exactly_1mib_accepted(client):
    r = client.post("/walkforward", content=_padded(MIB), headers=JSON_HDR)
    assert r.status_code == 200


def test_route_huge_candidates_dict_413(client):
    body = json.dumps({**BODY, "candidates": [{"k" * 10: "v" * (MIB // 2)}] * 3}).encode()
    r = client.post("/walkforward", content=body, headers=JSON_HDR)
    assert r.status_code == 413 and client.rec.calls == []


def test_route_huge_train_days_no_500(client):
    r = client.post("/walkforward", json={**BODY, "train_days": 10**9}, headers=HDR)
    assert r.status_code in (200, 422) and client.rec.calls == []
    if r.status_code == 200:
        assert r.json()["ok"] is False


def test_route_get_405(client):
    assert client.get("/walkforward", headers=HDR).status_code == 405
