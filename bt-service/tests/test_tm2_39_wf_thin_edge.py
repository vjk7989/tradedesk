"""TM2-39 edge tests: thin train/test windows warn, and warnings are the only thing that changes.

A run is "thin" when it reports fewer than MIN_FOLD_BARS (10) equity points. The train side is judged on
the winning candidate's run (one warning per fold), the test side on the test run. All runs go through an
injected, deterministic fake `run`; no subprocesses.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta

import pytest

from bt_service import walkforward as wf_mod
from bt_service.walkforward import MIN_FOLD_BARS, walk_forward

TRAIN, TEST = 20, 5
D0 = date(2024, 1, 1)  # a Monday
CANDS = [{"n": 0}, {"n": 1}, {"n": 2}]
WORDING = re.compile(r"^fold (\d+): thin (train|test) window \((\d+) bars < 10\)$")


def _end(n_folds: int, test_days: int = TEST, train_days: int = TRAIN) -> str:
    return (D0 + timedelta(days=train_days + n_folds * test_days)).isoformat()


def _eq(n: int, v0: float = 100.0) -> list[dict]:
    return [{"date": f"p{k:03d}", "value": v0 + k} for k in range(n)]


class Fake:
    """Deterministic run.

    train_bars / test_bars: int, or callable(fold, n) -> int | None | "missing"; None or "missing" means
    the response has no `equity` key at all. Train scores depend on fold and candidate; the winner varies.
    train_warn / test_warn: extra warnings each run reports (to check ordering).
    fail: None, ("test", fold) test run fails, ("train", fold) every train run fails.
    """

    def __init__(self, train_bars=20, test_bars=20, fail=None, train_warn=True, test_warn=True, score=None):
        self.train_bars, self.test_bars = train_bars, test_bars
        self.fail, self.train_warn, self.test_warn = fail, train_warn, test_warn
        self.score = score or (lambda i, n: ((n * 7 + i * 3) % 5) + n / 10)
        self.calls: list[dict] = []

    @staticmethod
    def _bars(spec, i, n):
        return spec(i, n) if callable(spec) else spec

    def __call__(self, **kw):
        self.calls.append(kw)
        s, e = date.fromisoformat(kw["start"]), date.fromisoformat(kw["end"])
        span = (e - s).days + 1
        n = kw["signal_parameters"]["n"]
        if span == TRAIN:
            i = (s - D0).days // TEST
            if self.fail == ("train", i):
                return {"ok": False, "error": "no data", "equity": [], "warnings": [f"tr{i}.{n} failed"]}
            res = {"ok": True, "metrics": {"sharpe": self.score(i, n)},
                   "warnings": [f"tr{i}.{n}"] if self.train_warn else []}
            bars = self._bars(self.train_bars, i, n)
        else:
            assert span == TEST, kw
            i = (s - D0).days // TEST - TRAIN // TEST
            if self.fail == ("test", i):
                return {"ok": False, "error": "boom", "equity": [], "warnings": [f"te{i} failed"]}
            res = {"ok": True, "metrics": {"sharpe": 0.5 + i, "total_return": 0.01 * (i + 1)},
                   "warnings": [f"te{i}"] if self.test_warn else []}
            bars = self._bars(self.test_bars, i, n)
        if bars not in (None, "missing"):
            res["equity"] = _eq(bars, 100.0 + i)
        return res


def _wf(run, n_folds=1, candidates=CANDS, **kw):
    kw.setdefault("train_days", TRAIN)
    kw.setdefault("test_days", TEST)
    return walk_forward("code", ["A"], D0.isoformat(),
                        _end(n_folds, kw["test_days"], kw["train_days"]),
                        candidates=list(candidates), run=run, **kw)


def _thin(res):
    return [w for w in res.get("warnings") or [] if " thin " in w]


# ------------------------------------------------------------- the constant and the wording

def test_constant_is_ten():
    assert MIN_FOLD_BARS == 10


def test_exact_wording_train_and_test():
    res = _wf(Fake(train_bars=3, test_bars=7))
    assert res["ok"] is True
    assert _thin(res) == ["fold 0: thin train window (3 bars < 10)", "fold 0: thin test window (7 bars < 10)"]
    for w in _thin(res):
        assert WORDING.match(w), w


def test_wording_reads_the_constant(monkeypatch):
    # The threshold and the number in the message both come from MIN_FOLD_BARS.
    monkeypatch.setattr(wf_mod, "MIN_FOLD_BARS", 5)
    res = _wf(Fake(train_bars=4, test_bars=5))
    assert _thin(res) == ["fold 0: thin train window (4 bars < 5)"]


# ------------------------------------------------------------- boundaries

@pytest.mark.parametrize("bars,warns", [(0, True), (1, True), (9, True), (10, False), (11, False), (500, False)])
def test_train_boundary(bars, warns):
    res = _wf(Fake(train_bars=bars, test_bars=20))
    assert res["ok"] is True
    assert _thin(res) == ([f"fold 0: thin train window ({bars} bars < 10)"] if warns else [])


@pytest.mark.parametrize("bars,warns", [(0, True), (1, True), (9, True), (10, False), (11, False), (500, False)])
def test_test_boundary(bars, warns):
    res = _wf(Fake(train_bars=20, test_bars=bars))
    assert res["ok"] is True
    assert _thin(res) == ([f"fold 0: thin test window ({bars} bars < 10)"] if warns else [])


def test_zero_bars_is_thin_not_an_error():
    # `equity: []` on an ok run is the thinnest case: it warns "(0 bars < 10)" and still scores.
    res = _wf(Fake(train_bars=0, test_bars=0), n_folds=2)
    assert res["ok"] is True and len(res["folds"]) == 2
    assert _thin(res) == [
        "fold 0: thin train window (0 bars < 10)", "fold 0: thin test window (0 bars < 10)",
        "fold 1: thin train window (0 bars < 10)", "fold 1: thin test window (0 bars < 10)",
    ]
    assert res["oos_equity"] == []


@pytest.mark.parametrize("side", ["train", "test"])
def test_missing_equity_key_is_not_counted(side):
    # Pinned (review LOW): a run with no `equity` key is not counted, so it does not warn, while `[]` does.
    spec = {"train_bars": 20, "test_bars": 20, f"{side}_bars": "missing"}
    res = _wf(Fake(**spec))
    assert res["ok"] is True
    assert _thin(res) == []


@pytest.mark.parametrize("value", [None, {}, "x" * 3, 5, (1, 2)])
def test_non_list_train_equity_is_not_counted(value):
    # Train equity is only used for the thin check, so any non-list value can be probed safely.
    class Odd(Fake):
        def __call__(self, **kw):
            r = super().__call__(**kw)
            if (date.fromisoformat(kw["end"]) - date.fromisoformat(kw["start"])).days + 1 == TRAIN:
                r["equity"] = value
            return r

    res = _wf(Odd(test_bars=20))
    assert res["ok"] is True
    assert _thin(res) == []


@pytest.mark.parametrize("value", [None, {}])
def test_falsy_non_list_test_equity_is_not_counted(value):
    # (A truthy non-list test equity is outside this task: the oos-equity code iterates it.)
    class Odd(Fake):
        def __call__(self, **kw):
            r = super().__call__(**kw)
            if (date.fromisoformat(kw["end"]) - date.fromisoformat(kw["start"])).days + 1 == TEST:
                r["equity"] = value
            return r

    res = _wf(Odd(train_bars=20))
    assert res["ok"] is True
    assert _thin(res) == [] and res["oos_equity"] == []


# ------------------------------------------------------------- one train warning per fold, judged on the winner

def test_one_train_warning_per_fold_with_many_candidates():
    cands = [{"n": k} for k in range(wf_mod.MAX_CANDIDATES)]
    res = _wf(Fake(train_bars=4, test_bars=20), n_folds=4, candidates=cands)
    assert res["ok"] is True
    assert _thin(res) == [f"fold {i}: thin train window (4 bars < 10)" for i in range(4)]


def test_train_judged_on_winner_only_thin_losers_do_not_warn():
    # Every losing candidate is thin; the winner (highest score) has 12 bars.
    fake = Fake(score=lambda i, n: float(n), train_bars=lambda i, n: 12 if n == 2 else 1, test_bars=20)
    res = _wf(fake, n_folds=2)
    assert [f["chosen"] for f in res["folds"]] == [{"n": 2}, {"n": 2}]
    assert _thin(res) == []


def test_train_judged_on_winner_with_its_own_count():
    fake = Fake(score=lambda i, n: float(n), train_bars=lambda i, n: 7 if n == 2 else 50, test_bars=20)
    res = _wf(fake)
    assert _thin(res) == ["fold 0: thin train window (7 bars < 10)"]


def test_failed_and_nan_candidates_never_judged():
    # Candidate 0 fails with `equity: []`, candidate 1 is ok but NaN; candidate 2 wins with 15 bars.
    class Mixed(Fake):
        def __call__(self, **kw):
            r = super().__call__(**kw)
            n = kw["signal_parameters"]["n"]
            if (date.fromisoformat(kw["end"]) - date.fromisoformat(kw["start"])).days + 1 == TRAIN:
                if n == 0:
                    return {"ok": False, "error": "e", "equity": []}
                if n == 1:
                    return {"ok": True, "metrics": {"sharpe": float("nan")}, "equity": []}
            return r

    res = _wf(Mixed(train_bars=15, test_bars=15))
    assert res["ok"] is True and res["folds"][0]["chosen"] == {"n": 2}
    assert _thin(res) == []


def test_fold_with_no_winner_gets_no_train_thin_warning():
    res = _wf(Fake(train_bars=2, test_bars=2, fail=("train", 1)), n_folds=3)
    assert res["ok"] is False
    assert res["error"] == "fold 1: no candidate produced a finite sharpe: no data"
    assert _thin(res) == ["fold 0: thin train window (2 bars < 10)", "fold 0: thin test window (2 bars < 10)"]


# ------------------------------------------------------------- ordering

def test_thin_warnings_ordered_after_each_sides_run_warnings():
    res = _wf(Fake(train_bars=1, test_bars=2), n_folds=2, candidates=[{"n": 0}, {"n": 1}])
    assert res["warnings"] == [
        "fold 0: tr0.0", "fold 0: tr0.1", "fold 0: thin train window (1 bars < 10)",
        "fold 0: te0", "fold 0: thin test window (2 bars < 10)",
        "fold 1: tr1.0", "fold 1: tr1.1", "fold 1: thin train window (1 bars < 10)",
        "fold 1: te1", "fold 1: thin test window (2 bars < 10)",
    ]


def test_thin_test_warning_precedes_rescale_warning():
    class ZeroStart(Fake):
        def __call__(self, **kw):
            r = super().__call__(**kw)
            if r.get("equity") and (date.fromisoformat(kw["end"]) - date.fromisoformat(kw["start"])).days + 1 == TEST:
                if kw["start"] != _end(0):  # every fold but the first starts at 0: not rescaled
                    r["equity"][0]["value"] = 0.0
            return r

    res = _wf(ZeroStart(train_bars=20, test_bars=3, train_warn=False, test_warn=False), n_folds=2)
    assert res["warnings"] == [
        "fold 0: thin test window (3 bars < 10)",
        "fold 1: thin test window (3 bars < 10)",
        "fold 1: equity not rescaled (first value 0.0)",
    ]


# ------------------------------------------------------------- survives failures and budget expiry

def test_train_warning_emitted_before_test_failure_and_survives_it():
    res = _wf(Fake(train_bars=4, test_bars=4, fail=("test", 0)))
    assert res["ok"] is False and res["error"] == "fold 0: test run failed: boom"
    assert res["folds"] == []
    # the failed test run itself is not judged (no thin test warning for it)
    assert res["warnings"] == ["fold 0: tr0.0", "fold 0: tr0.1", "fold 0: tr0.2",
                               "fold 0: thin train window (4 bars < 10)", "fold 0: te0 failed"]


def test_completed_folds_thin_warnings_survive_later_test_failure():
    res = _wf(Fake(train_bars=4, test_bars=4, fail=("test", 2), train_warn=False, test_warn=False), n_folds=4)
    assert res["ok"] is False and len(res["folds"]) == 2
    assert res["warnings"] == [
        "fold 0: thin train window (4 bars < 10)", "fold 0: thin test window (4 bars < 10)",
        "fold 1: thin train window (4 bars < 10)", "fold 1: thin test window (4 bars < 10)",
        "fold 2: thin train window (4 bars < 10)", "fold 2: te2 failed",
    ]


def _step_clock(n_ok: int):
    """Clock that reads 0 for the first n_ok calls and then jumps past any budget."""
    calls = {"n": 0}

    def clock():
        calls["n"] += 1
        return 0.0 if calls["n"] <= n_ok else 1e12

    return clock


def test_train_warning_emitted_before_budget_expiry_and_survives_it():
    # Reads: deadline, 3 train reads, then the pre-test read expires.
    fake = Fake(train_bars=6, test_bars=6, train_warn=False, test_warn=False)
    res = _wf(fake, clock=_step_clock(1 + len(CANDS)))
    assert res == {"ok": False, "error": "time budget exceeded", "folds": [],
                   "warnings": ["fold 0: thin train window (6 bars < 10)"]}
    assert len(fake.calls) == len(CANDS)  # no test run was made


def test_completed_folds_thin_warnings_survive_budget_expiry_mid_train():
    # Fold 0 completes (1 + 3 + 1 reads), then fold 1's second train read expires.
    fake = Fake(train_bars=6, test_bars=8, train_warn=False, test_warn=False)
    res = _wf(fake, n_folds=3, clock=_step_clock(1 + len(CANDS) + 1 + 1))
    assert set(res) == {"ok", "error", "folds", "warnings"}
    assert res["error"] == "time budget exceeded" and len(res["folds"]) == 1
    assert res["warnings"] == ["fold 0: thin train window (6 bars < 10)", "fold 0: thin test window (8 bars < 10)"]


@pytest.mark.parametrize("n_ok", range(1, 1 + 3 * (len(CANDS) + 1)))
def test_budget_warnings_are_a_prefix_of_the_full_run(n_ok):
    full = _wf(Fake(train_bars=3, test_bars=3), n_folds=3)
    cut = _wf(Fake(train_bars=3, test_bars=3), n_folds=3, clock=_step_clock(n_ok))
    assert cut["ok"] is False and cut["error"] == "time budget exceeded"
    assert cut["warnings"] == full["warnings"][:len(cut["warnings"])]
    assert cut["folds"] == full["folds"][:len(cut["folds"])]


# ------------------------------------------------------------- warnings only: nothing else moves

def _no_warnings(res):
    return {k: v for k, v in res.items() if k != "warnings"}


@pytest.mark.parametrize("thin_train", [0, 1, 9])
@pytest.mark.parametrize("metric", ["sharpe", "total_return"])
def test_thin_train_changes_only_warnings(thin_train, metric):
    class TR(Fake):
        def __call__(self, **kw):
            r = super().__call__(**kw)
            if r.get("ok"):
                r["metrics"].setdefault("total_return", r["metrics"]["sharpe"])
            return r

    fat = _wf(TR(train_bars=40, test_bars=20), n_folds=4, metric=metric)
    thin = _wf(TR(train_bars=thin_train, test_bars=20), n_folds=4, metric=metric)
    assert fat["ok"] is thin["ok"] is True
    assert json.dumps(_no_warnings(thin)) == json.dumps(_no_warnings(fat))
    assert len({json.dumps(f["chosen"]) for f in fat["folds"]}) > 1  # selection actually varies by fold
    assert _thin(fat) == [] and len(_thin(thin)) == 4
    assert [w for w in thin["warnings"] if w not in _thin(thin)] == fat["warnings"]


def test_thin_test_changes_only_warnings_and_its_own_equity():
    # Test-run bar count feeds oos_equity by design; scores, selection, folds, summary and ok do not move.
    fat = _wf(Fake(train_bars=20, test_bars=20), n_folds=4)
    thin = _wf(Fake(train_bars=20, test_bars=3), n_folds=4)
    for key in ("ok", "metric", "folds", "summary"):
        assert json.dumps(thin[key]) == json.dumps(fat[key]), key
    assert len(thin["oos_equity"]) == 4 * 3 and len(fat["oos_equity"]) == 4 * 20
    assert [w for w in thin["warnings"] if w not in _thin(thin)] == fat["warnings"]


@pytest.mark.parametrize("fail", [("test", 0), ("test", 2), ("train", 1), ("train", 3)])
def test_thin_failure_paths_change_only_warnings(fail):
    fat = _wf(Fake(train_bars=30, test_bars=30, fail=fail), n_folds=4)
    thin = _wf(Fake(train_bars=2, test_bars=2, fail=fail), n_folds=4)
    assert fat["ok"] is thin["ok"] is False
    assert thin["error"] == fat["error"]
    # completed folds are identical (their oos equity is not part of a failure result)
    assert json.dumps(thin["folds"]) == json.dumps(fat["folds"])
    assert set(thin) == set(fat) == {"ok", "error", "folds", "warnings"}
    assert [w for w in thin["warnings"] if w not in _thin(thin)] == fat["warnings"]


def test_thin_run_calls_identical():
    fat, thin = Fake(train_bars=30, test_bars=30), Fake(train_bars=2, test_bars=2)
    _wf(fat, n_folds=3)
    _wf(thin, n_folds=3)
    assert fat.calls == thin.calls  # no extra fetch or run because of thinness


# ------------------------------------------------------------- daily interval with short test windows

class DailyBars(Fake):
    """One equity point per weekday in the requested [start, end] range, like a daily-bar engine run."""

    def __call__(self, **kw):
        r = super().__call__(**kw)
        s, e = date.fromisoformat(kw["start"]), date.fromisoformat(kw["end"])
        days = [s + timedelta(days=k) for k in range((e - s).days + 1)]
        r["equity"] = [{"date": d.isoformat(), "value": 100.0} for d in days if d.weekday() < 5]
        return r


@pytest.mark.parametrize("offset", range(7))
@pytest.mark.parametrize("test_days", [5, 11])
def test_daily_short_test_window_always_warns(offset, test_days):
    # Documented behaviour (review LOW): on the daily interval a test window of test_days calendar days
    # holds at most 9 weekday bars while test_days <= 11 (MIN_TEST_DAYS = 5 holds at most 5), so every
    # fold warns "thin test window", whatever weekday the windows start on. (12 days can reach 10 bars.)
    start = D0 + timedelta(days=offset)
    res = walk_forward("code", ["A"], start.isoformat(), (start + timedelta(days=TRAIN + 3 * test_days)).isoformat(),
                       train_days=TRAIN, test_days=test_days, candidates=[{"n": 0}], run=_DailyAnySpan())
    assert res["ok"] is True and len(res["folds"]) == 3
    tests = [w for w in _thin(res) if " test " in w]
    assert [int(WORDING.match(w).group(1)) for w in tests] == [0, 1, 2]
    assert all(int(WORDING.match(w).group(3)) <= (5 if test_days == 5 else 9) for w in tests)


def test_daily_twelve_day_window_starting_monday_is_not_thin():
    run = _DailyAnySpan()
    start = date(2024, 1, 8) - timedelta(days=TRAIN)  # test window starts on Monday 2024-01-08
    res = walk_forward("code", ["A"], start.isoformat(), (start + timedelta(days=TRAIN + 12)).isoformat(),
                       train_days=TRAIN, test_days=12, candidates=[{"n": 0}], run=run)
    assert res["ok"] is True
    assert [w for w in _thin(res) if " test " in w] == []


class _DailyAnySpan:
    """Daily-bar fake for arbitrary train/test spans: weekday points only, constant score."""

    def __call__(self, **kw):
        s, e = date.fromisoformat(kw["start"]), date.fromisoformat(kw["end"])
        days = [s + timedelta(days=k) for k in range((e - s).days + 1)]
        return {"ok": True, "metrics": {"sharpe": 1.0},
                "equity": [{"date": d.isoformat(), "value": 100.0} for d in days if d.weekday() < 5],
                "warnings": []}


def test_daily_bars_fake_matches_weekday_counts():
    # Sanity of the daily fake: train [Mon 01-01, 01-21) holds 15 weekday bars (not thin); test
    # [Sun 01-21, 01-26) holds Mon-Thu, 4 bars.
    res = _wf(DailyBars(), n_folds=1)
    assert res["ok"] is True
    assert _thin(res) == ["fold 0: thin test window (4 bars < 10)"]
