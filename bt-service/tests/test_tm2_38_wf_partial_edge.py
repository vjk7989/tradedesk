"""TM2-38 edge tests: a failed fold keeps the folds completed before it.

All runs go through an injected, deterministic fake `run`; no subprocesses. `_main_walk_forward` below is
a verbatim copy of `walk_forward` from main before TM2-38, used as the reference for every path that must
not change (success, time budget, error text).
"""
from __future__ import annotations

import copy
import functools
import json
import math
import time
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from bt_service import app as app_mod
from bt_service.walkforward import walk_forward
from bt_service.walkforward import _budget_s, _finite, _score, METRICS, MAX_CANDIDATES, MAX_DAYS, MAX_RUNS
from bt_service.walkforward import MIN_TEST_DAYS, MIN_TRAIN_DAYS


# ------------------------------------------------------------- main's walk_forward, copied verbatim

def _main_walk_forward(
    code, symbols, start, end, *, train_days, test_days, candidates, metric="sharpe", interval="1D",
    capital=1_000_000, costs=None, source="auto", timeout_s=120, run=None, clock=time.monotonic,
) -> dict:
    if metric not in METRICS:
        return {"ok": False, "error": f"metric must be one of {', '.join(METRICS)}"}
    if (
        isinstance(train_days, bool)
        or not isinstance(train_days, int)
        or not MIN_TRAIN_DAYS <= train_days <= MAX_DAYS
    ):
        return {"ok": False, "error": f"train_days must be an integer between {MIN_TRAIN_DAYS} and {MAX_DAYS}"}
    if (
        isinstance(test_days, bool)
        or not isinstance(test_days, int)
        or not MIN_TEST_DAYS <= test_days <= MAX_DAYS
    ):
        return {"ok": False, "error": f"test_days must be an integer between {MIN_TEST_DAYS} and {MAX_DAYS}"}
    if (
        not isinstance(candidates, (list, tuple))
        or not 1 <= len(candidates) <= MAX_CANDIDATES
        or not all(isinstance(c, dict) for c in candidates)
    ):
        return {"ok": False, "error": f"candidates must be a list of 1-{MAX_CANDIDATES} dicts"}
    try:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    except (TypeError, ValueError):
        return {"ok": False, "error": "start and end must be ISO dates (YYYY-MM-DD)"}

    train_span, test_span = timedelta(days=train_days), timedelta(days=test_days)
    windows = []
    t0 = d0
    while True:
        try:
            tr_e = t0 + train_span
            window_end = tr_e + test_span
        except OverflowError:
            break  # no window fits before date.max
        if window_end > d1:
            break
        windows.append((t0, tr_e, tr_e, window_end))
        t0 += test_span
    if not windows:
        return {"ok": False, "error": "range too short for one fold"}
    if len(windows) * (len(candidates) + 1) > MAX_RUNS:
        return {"ok": False, "error": "too many runs"}

    deadline = clock() + _budget_s()
    folds: list[dict] = []
    oos_equity: list[dict] = []
    warnings: list[str] = []
    prev_last: float | None = None
    for i, (tr_s, tr_e, te_s, te_e) in enumerate(windows):
        best_idx: int | None = None
        best_score: float | None = None
        first_error = None
        for idx, candidate in enumerate(candidates):
            remaining = deadline - clock()
            if remaining <= 0:
                return {"ok": False, "error": "time budget exceeded", "folds": folds}
            res = run(
                code=code,
                symbols=symbols,
                start=tr_s.isoformat(),
                end=(tr_e - timedelta(days=1)).isoformat(),
                interval=interval,
                capital=capital,
                costs=costs,
                source=source,
                timeout_s=min(timeout_s, remaining),
                signal_parameters=candidate,
            )
            warnings.extend(f"fold {i}: {w}" for w in (res.get("warnings") or []))
            if first_error is None and not res.get("ok"):
                first_error = res.get("error")
            score = _score(res, metric)
            if score is not None and (best_score is None or score > best_score):
                best_idx, best_score = idx, score
        if best_idx is None:
            detail = f": {first_error}" if first_error else ""
            return {"ok": False, "error": f"fold {i}: no candidate produced a finite {metric}{detail}"}

        chosen = candidates[best_idx]
        remaining = deadline - clock()
        if remaining <= 0:
            return {"ok": False, "error": "time budget exceeded", "folds": folds}
        test_res = run(
            code=code,
            symbols=symbols,
            start=te_s.isoformat(),
            end=(te_e - timedelta(days=1)).isoformat(),
            interval=interval,
            capital=capital,
            costs=costs,
            source=source,
            timeout_s=min(timeout_s, remaining),
            signal_parameters=chosen,
        )
        warnings.extend(f"fold {i}: {w}" for w in (test_res.get("warnings") or []))
        if not test_res.get("ok"):
            return {"ok": False, "error": f"fold {i}: test run failed: {test_res.get('error', 'unknown error')}"}

        test_metrics = test_res.get("metrics")
        if not isinstance(test_metrics, dict):
            test_metrics = {}
        folds.append(
            {
                "train": [tr_s.isoformat(), tr_e.isoformat()],
                "test": [te_s.isoformat(), te_e.isoformat()],
                "chosen": chosen,
                "train_score": best_score,
                "test_metrics": test_metrics,
            }
        )

        equity = test_res.get("equity") or []
        scale = 1.0
        if prev_last is not None:
            first = _finite(equity[0].get("value")) if equity else None
            if first:
                scale = prev_last / first
            else:
                warnings.append(f"fold {i}: equity not rescaled (first value {first!r})")
        for point in equity:
            value = point.get("value")
            scaled = _finite(value)
            oos_equity.append({"date": point.get("date"), "value": scaled * scale if scaled is not None else value})
        if oos_equity:
            last = _finite(oos_equity[-1]["value"])
            if last is not None:
                prev_last = last

    test_scores: list[float] = []
    for fold in folds:
        score = _finite(fold["test_metrics"].get(metric))
        if score is not None:
            test_scores.append(score)
    mean = round(sum(test_scores) / len(test_scores), 6) if test_scores else None
    return {
        "ok": True,
        "metric": metric,
        "folds": folds,
        "oos_equity": oos_equity,
        "summary": {
            "folds": len(folds),
            f"mean_test_{metric}": mean,
            "positive_folds": sum(1 for score in test_scores if score > 0),
            "scored_folds": len(test_scores),
        },
        "warnings": warnings,
    }


# ------------------------------------------------------------- fake run

TRAIN, TEST = 20, 5
D0 = date(2024, 1, 1)
K = 4  # folds in the full run
CANDS = [{"n": 0}, {"n": 1}, {"n": 2}]


def _end(n_folds: int) -> str:
    return (D0 + timedelta(days=TRAIN + n_folds * TEST)).isoformat()


def _train_start(i: int) -> str:
    return (D0 + timedelta(days=i * TEST)).isoformat()


def _test_start(i: int) -> str:
    return (D0 + timedelta(days=TRAIN + i * TEST)).isoformat()


class Fake:
    """Deterministic run. Scores vary by fold and candidate, so the chosen candidate differs between folds.

    fail: None, or (kind, fold) where kind is one of
      "train_error"  every train run of that fold fails with an error (and a warning),
      "train_nan"    every train run of that fold is ok but has a NaN metric (no error text),
      "test_error"   the test run of that fold fails with an error (and a warning),
      "test_noerr"   the test run of that fold fails with no "error" key.
    """

    def __init__(self, fail=None, eq0=None):
        self.fail = fail
        self.eq0 = eq0 or {}  # fold -> first equity value override (exercise rescale warnings)
        self.calls: list[dict] = []

    def __call__(self, **kw):
        self.calls.append(kw)
        s, e = date.fromisoformat(kw["start"]), date.fromisoformat(kw["end"])
        span = (e - s).days + 1
        n = kw["signal_parameters"]["n"]
        if span == TRAIN:
            i = (s - D0).days // TEST
            tag = f"train {kw['start']} n={n}"
            if self.fail == ("train_error", i):
                return {"ok": False, "error": f"no data for n={n}", "warnings": [f"{tag} failed"]}
            if self.fail == ("train_nan", i):
                return {"ok": True, "metrics": {"sharpe": float("nan")}, "warnings": [f"{tag} nan"]}
            score = ((n * 7 + i * 3) % 5) - 1.5 + n / 10
            return {"ok": True, "metrics": {"sharpe": score}, "warnings": [tag] if n == 1 else []}
        assert span == TEST, kw
        i = (s - D0).days // TEST - TRAIN // TEST
        tag = f"test {kw['start']} n={n}"
        if self.fail == ("test_error", i):
            return {"ok": False, "error": "boom: missing: ['X']", "warnings": [f"{tag} failed"]}
        if self.fail == ("test_noerr", i):
            return {"ok": False, "warnings": [f"{tag} failed"]}
        v0 = self.eq0.get(i, 100.0 + i)
        equity = [{"date": (s + timedelta(days=d)).isoformat(), "value": v0 * (1 + 0.01 * d * (n + 1))}
                  for d in range(span)]
        return {"ok": True, "metrics": {"sharpe": 0.25 * (i + 1) - n * 0.1, "total_return": 0.01 * i,
                                        "trade_count": float(n)},
                "equity": equity, "warnings": [tag, f"{tag} again"]}


def _run(fn, run, n_folds=K, **kw):
    return fn("code", ["A"], D0.isoformat(), _end(n_folds), train_days=TRAIN, test_days=TEST,
              candidates=kw.pop("candidates", CANDS), run=run, **kw)


FAIL_KINDS = ["train_error", "train_nan", "test_error", "test_noerr"]


def _expected_error(kind: str, i: int) -> str:
    return {
        "train_error": f"fold {i}: no candidate produced a finite sharpe: no data for n=0",
        "train_nan": f"fold {i}: no candidate produced a finite sharpe",
        "test_error": f"fold {i}: test run failed: boom: missing: ['X']",
        "test_noerr": f"fold {i}: test run failed: unknown error",
    }[kind]


# ------------------------------------------------------------- sanity of the fixture

def test_fixture_choices_differ_between_folds():
    res = _run(walk_forward, Fake())
    assert res["ok"] is True and len(res["folds"]) == K
    chosen = [f["chosen"]["n"] for f in res["folds"]]
    assert len(set(chosen)) > 1, chosen  # so a shifted or reordered fold list cannot pass by accident


# ------------------------------------------------------------- partial folds

@pytest.mark.parametrize("kind", FAIL_KINDS)
@pytest.mark.parametrize("i", range(K))
def test_failure_at_fold_i_keeps_exactly_folds_before_it(kind, i):
    cands = copy.deepcopy(CANDS)
    res = _run(walk_forward, Fake(fail=(kind, i)), candidates=cands)
    assert set(res) == {"ok", "error", "folds", "warnings"}
    assert res["ok"] is False
    assert res["error"] == _expected_error(kind, i)

    if i == 0:
        assert res["folds"] == []
    else:
        shorter = _run(walk_forward, Fake(), n_folds=i)
        assert shorter["ok"] is True
        # deep-equal to what a clean run over exactly those folds produces: no partial fold i
        assert res["folds"] == shorter["folds"]
        assert [f["train"][0] for f in res["folds"]] == [_train_start(j) for j in range(i)]
    # and the same as the first i folds of the full successful run
    full = _run(walk_forward, Fake())
    assert res["folds"] == full["folds"][:i]
    assert cands == CANDS  # candidates not mutated
    for f in res["folds"]:
        assert set(f) == {"train", "test", "chosen", "train_score", "test_metrics"}


@pytest.mark.parametrize("kind", FAIL_KINDS)
@pytest.mark.parametrize("i", range(K))
def test_error_text_and_ok_unchanged_from_main(kind, i):
    new = _run(walk_forward, Fake(fail=(kind, i)))
    old = _run(_main_walk_forward, Fake(fail=(kind, i)))
    assert old == {"ok": False, "error": _expected_error(kind, i)}
    assert {k: v for k, v in new.items() if k not in ("folds", "warnings")} == old


@pytest.mark.parametrize("kind", FAIL_KINDS)
@pytest.mark.parametrize("i", range(K))
def test_failure_makes_the_same_run_calls_as_main(kind, i):
    new_run, old_run = Fake(fail=(kind, i)), Fake(fail=(kind, i))
    _run(walk_forward, new_run)
    _run(_main_walk_forward, old_run)
    assert new_run.calls == old_run.calls  # stops at the same point; no extra runs to "finish" the fold


@pytest.mark.parametrize("kind", FAIL_KINDS)
@pytest.mark.parametrize("i", range(K))
def test_warnings_before_failure_preserved_in_order(kind, i):
    run = Fake(fail=(kind, i))
    res = _run(walk_forward, run)

    # Rebuild the expected list from the calls actually made, in call order.
    expected = []
    for kw in run.calls:
        s = date.fromisoformat(kw["start"])
        span = (date.fromisoformat(kw["end"]) - s).days + 1
        fold = (s - D0).days // TEST - (0 if span == TRAIN else TRAIN // TEST)
        replay = Fake(fail=run.fail)(**kw)
        expected += [f"fold {fold}: {w}" for w in replay.get("warnings") or []]
    assert res["warnings"] == expected
    assert expected, "fixture should emit warnings"

    # the completed folds' warnings are a prefix, identical to the shorter clean run's
    if i:
        shorter = _run(walk_forward, Fake(), n_folds=i)
        assert res["warnings"][:len(shorter["warnings"])] == shorter["warnings"]
    # the failing fold's own warnings (including those on the failed responses) are kept
    tail = [w for w in res["warnings"] if w.startswith(f"fold {i}: ")]
    assert tail
    if kind.startswith("test"):
        assert tail[-1] == f"fold {i}: test {_test_start(i)} n={res_chosen_n(i)} failed"
    else:
        assert tail[-len(CANDS):] == [
            f"fold {i}: train {_train_start(i)} n={c['n']} {'failed' if kind == 'train_error' else 'nan'}"
            for c in CANDS]
    # prefixes never go backwards and never pass the failing fold
    nums = [int(w.split(":", 1)[0].split()[1]) for w in res["warnings"]]
    assert nums == sorted(nums) and nums[-1] == i


def res_chosen_n(i: int) -> int:
    """Candidate the clean run picks in fold i (the failing test run is made with it)."""
    return _run(walk_forward, Fake())["folds"][i]["chosen"]["n"]


def test_rescale_warning_of_completed_fold_is_kept():
    # fold 1's equity starts at 0, so it is not rescaled; fold 2's test then fails.
    res = _run(walk_forward, Fake(fail=("test_error", 2), eq0={1: 0.0}))
    assert "fold 1: equity not rescaled (first value 0.0)" in res["warnings"]
    assert len(res["folds"]) == 2


# ------------------------------------------------------------- unchanged paths

class _WithTotalReturn(Fake):
    """Train runs also report total_return (= sharpe) so a total_return walk-forward succeeds."""

    def __call__(self, **kw):
        r = super().__call__(**kw)
        if r.get("ok"):
            r["metrics"].setdefault("total_return", r["metrics"]["sharpe"])
        return r


SUCCESS_CASES = {
    "plain": dict(make=Fake),
    "one_fold": dict(make=Fake, n_folds=1),
    "one_candidate": dict(make=Fake, candidates=[{"n": 2}]),
    "rescale_warning": dict(make=lambda: Fake(eq0={2: 0.0})),
    "other_metric": dict(make=_WithTotalReturn, metric="total_return"),
}


@pytest.mark.parametrize("case", SUCCESS_CASES)
def test_success_path_byte_identical_to_main(case):
    spec = dict(SUCCESS_CASES[case])
    make = spec.pop("make")
    new = _run(walk_forward, make(), **dict(spec))
    old = _run(_main_walk_forward, make(), **dict(spec))
    assert new["ok"] is True
    assert json.dumps(new) == json.dumps(old)
    assert repr(new) == repr(old)


def _step_clock(n_ok: int):
    """Clock that reads 0 for the first n_ok calls and then jumps past any budget."""
    calls = {"n": 0}

    def clock():
        calls["n"] += 1
        return 0.0 if calls["n"] <= n_ok else 1e12

    return clock


# deadline read + per fold (len(CANDS) train reads + 1 test read)
@pytest.mark.parametrize("n_ok", range(1, 1 + K * (len(CANDS) + 1)))
def test_budget_path_unchanged(n_ok):
    new = _run(walk_forward, Fake(), clock=_step_clock(n_ok))
    old = _run(_main_walk_forward, Fake(), clock=_step_clock(n_ok))
    assert new == old
    assert set(new) == {"ok", "error", "folds"}  # still folds only, no warnings key
    assert new["error"] == "time budget exceeded"
    completed = (n_ok - 1) // (len(CANDS) + 1)
    assert new["folds"] == _run(walk_forward, Fake())["folds"][:completed]


# ------------------------------------------------------------- serialisation

@pytest.mark.parametrize("kind", FAIL_KINDS)
@pytest.mark.parametrize("i", range(K))
def test_partial_result_is_strict_json(kind, i):
    res = _run(walk_forward, Fake(fail=(kind, i)))
    text = json.dumps(res, allow_nan=False)
    assert json.loads(text) == res
    assert all(math.isfinite(f["train_score"]) for f in res["folds"])


def test_route_returns_partial_folds(monkeypatch):
    token = "tm2-38-" + "k" * 30
    monkeypatch.setenv("BT_TOKEN", token)
    monkeypatch.delenv("BT_MAX_CONCURRENCY", raising=False)
    monkeypatch.setattr(app_mod, "_sem", None)
    monkeypatch.setattr(app_mod, "walk_forward", functools.partial(walk_forward, run=Fake(fail=("test_error", 2))))
    body = {"code": "x", "symbols": ["A"], "start": D0.isoformat(), "end": _end(K), "train_days": TRAIN,
            "test_days": TEST, "candidates": CANDS}
    with TestClient(app_mod.app, raise_server_exceptions=False) as c:
        r = c.post("/walkforward", json=body, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    direct = _run(walk_forward, Fake(fail=("test_error", 2)))
    assert r.json() == direct
    assert len(r.json()["folds"]) == 2
