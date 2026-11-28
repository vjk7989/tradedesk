"""TM2-51 edge tests: walk-forward guards a malformed test-run `equity`.

A non-list equity, or a list with any non-dict item, adds exactly one `fold <i>: unexpected equity shape (<type>)`
warning, skips that fold's OOS curve, and adds no thin and no rescale warning for that fold. A valid empty list
keeps TM2-39's thin warning and (on later folds) the "equity not rescaled (first value None)" warning.
All runs go through an injected, deterministic fake `run`; no subprocesses.
"""
from __future__ import annotations

import copy
import re
from datetime import date, timedelta

import pytest

from bt_service.walkforward import walk_forward

TRAIN, TEST = 20, 5
D0 = date(2024, 1, 1)
N_FOLDS = 3
END = (D0 + timedelta(days=TRAIN + N_FOLDS * TEST)).isoformat()
FIRST_TEST = D0 + timedelta(days=TRAIN)
BARS = 12  # >= MIN_FOLD_BARS, so clean runs carry no thin warning
MISSING = object()  # sentinel: drop the `equity` key entirely

SHAPE = re.compile(r"^fold (\d+): unexpected equity shape \((\w+)\)$")
THIN_TEST = re.compile(r"^fold (\d+): thin test window ")
RESCALE = re.compile(r"^fold (\d+): equity not rescaled ")


def _fold_equity(fold: int, continuous: bool) -> list[dict]:
    # continuous: each fold starts where the previous ended (scale is exactly 1.0 in a clean run)
    base = 100.0 + fold * (BARS - 1) if continuous else 50.0 * (fold + 1)
    return [{"date": f"f{fold}-p{k:02d}", "value": base + k} for k in range(BARS)]


class Fake:
    def __init__(self, overrides: dict | None = None, continuous: bool = True):
        self.overrides = overrides or {}
        self.continuous = continuous
        self.calls = 0

    def __call__(self, **kw):
        self.calls += 1
        s, e = date.fromisoformat(kw["start"]), date.fromisoformat(kw["end"])
        if (e - s).days == TRAIN - 1:  # train run
            eq = [{"date": f"t{k}", "value": 1.0 + k} for k in range(BARS)]
            return {"ok": True, "metrics": {"sharpe": 1.0}, "equity": eq, "warnings": []}
        fold = (s - FIRST_TEST).days // TEST
        res = {"ok": True, "metrics": {"sharpe": 0.5 + fold, "total_return": 0.1}, "warnings": []}
        if fold in self.overrides:
            ov = self.overrides[fold]
            if ov is not MISSING:
                res["equity"] = copy.deepcopy(ov)
        else:
            res["equity"] = _fold_equity(fold, self.continuous)
        return res


def _wf(fake: Fake) -> dict:
    return walk_forward(
        "code", ["AAA"], D0.isoformat(), END,
        train_days=TRAIN, test_days=TEST, candidates=[{"n": 1}], run=fake,
    )


def _matching(warnings, pat):
    return [w for w in warnings if pat.match(w)]


@pytest.fixture(scope="module")
def baseline():
    out = _wf(Fake())
    assert out["ok"] is True
    assert len(out["folds"]) == N_FOLDS
    assert out["warnings"] == []
    assert len(out["oos_equity"]) == N_FOLDS * BARS
    return out


def _fold_points(out, fold):
    return [p for p in out["oos_equity"] if p["date"].startswith(f"f{fold}-")]


MALFORMED = [
    pytest.param(None, "NoneType", id="none"),
    pytest.param(MISSING, "NoneType", id="missing-key"),
    pytest.param({"date": "x", "value": 1.0}, "dict", id="dict"),
    pytest.param("abc", "str", id="str"),
    pytest.param(42, "int", id="int"),
    pytest.param(0, "int", id="zero"),
    pytest.param("", "str", id="empty-str"),
    pytest.param({}, "dict", id="empty-dict"),
    pytest.param([1, 2, 3], "list", id="short-int-list"),
    pytest.param([None] * 15, "list", id="long-none-list"),
    pytest.param(_fold_equity(0, True)[:5] + ["bad"] + _fold_equity(0, True)[5:], "list", id="mixed-list"),
]


# --- every malformed case: exactly one warning (the shape one), no thin, no rescale ---------------------

@pytest.mark.parametrize("fold", [0, 1, 2])
@pytest.mark.parametrize("bad,tname", MALFORMED)
def test_malformed_exactly_one_shape_warning(baseline, bad, tname, fold):
    out = _wf(Fake({fold: bad}))
    assert out["ok"] is True
    assert out["warnings"] == [f"fold {fold}: unexpected equity shape ({tname})"]
    assert len(_matching(out["warnings"], SHAPE)) == 1
    assert _matching(out["warnings"], THIN_TEST) == []
    assert _matching(out["warnings"], RESCALE) == []
    assert out["folds"] == baseline["folds"]
    assert out["summary"] == baseline["summary"]
    assert _fold_points(out, fold) == []
    assert len(out["oos_equity"]) == (N_FOLDS - 1) * BARS


# --- other folds unaffected -----------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [None, "abc", [1, 2, 3]], ids=["none", "str", "int-list"])
def test_malformed_fold0_other_folds_unaffected(baseline, bad):
    out = _wf(Fake({0: bad}))
    assert out["ok"] == baseline["ok"]
    assert out["folds"] == baseline["folds"]
    assert out["summary"] == baseline["summary"]
    assert out["folds"][0] == baseline["folds"][0]
    assert _fold_points(out, 0) == []
    assert not any(p["date"].startswith("f0-") for p in out["oos_equity"])
    for fold in (1, 2):
        got = _fold_points(out, fold)
        assert len(got) == BARS
        assert got == _fold_points(baseline, fold)
    assert out["oos_equity"] == [p for p in baseline["oos_equity"] if not p["date"].startswith("f0-")]


# --- malformed fold in the middle: later folds rescale against the last good value ----------------------

def test_malformed_middle_fold_later_rescale_against_last_good():
    clean = _wf(Fake(continuous=False))
    assert clean["warnings"] == []
    out = _wf(Fake({1: {"oops": 1}}, continuous=False))
    assert out["ok"] is True
    assert out["warnings"] == ["fold 1: unexpected equity shape (dict)"]
    assert out["folds"] == clean["folds"]
    assert out["summary"] == clean["summary"]

    f0 = _fold_points(out, 0)
    assert f0 == _fold_points(clean, 0)
    assert [p["value"] for p in f0] == [p["value"] for p in _fold_equity(0, False)]
    assert _fold_points(out, 1) == []

    last_good = f0[-1]["value"]
    raw2 = _fold_equity(2, False)
    scale = last_good / raw2[0]["value"]
    f2 = _fold_points(out, 2)
    assert [p["date"] for p in f2] == [p["date"] for p in raw2]
    assert [p["value"] for p in f2] == pytest.approx([p["value"] * scale for p in raw2])
    assert f2[0]["value"] == pytest.approx(last_good)
    # differs from the clean run, which rescaled fold 2 against fold 1's end
    assert f2 != _fold_points(clean, 2)


def test_two_malformed_folds_each_warn_once():
    out = _wf(Fake({0: None, 2: [1, {"date": "d", "value": 1.0}]}, continuous=False))
    assert out["ok"] is True
    assert out["warnings"] == [
        "fold 0: unexpected equity shape (NoneType)",
        "fold 2: unexpected equity shape (list)",
    ]
    # fold 1 is the first curve: not rescaled, raw values
    assert out["oos_equity"] == _fold_equity(1, False)


# --- missing key vs explicit None ----------------------------------------------------------------------

def test_missing_key_and_none_identical(baseline):
    a = _wf(Fake({1: MISSING}))
    b = _wf(Fake({1: None}))
    assert a == b
    assert a["warnings"] == ["fold 1: unexpected equity shape (NoneType)"]


# --- mixed list: all or nothing ------------------------------------------------------------------------

def test_mixed_list_skips_whole_curve(baseline):
    good = _fold_equity(1, True)
    mixed = good[:6] + [7] + good[6:]
    out = _wf(Fake({1: mixed}))
    assert out["warnings"] == ["fold 1: unexpected equity shape (list)"]
    assert _fold_points(out, 1) == []
    assert not any(p["date"] in {g["date"] for g in good} for p in out["oos_equity"])
    assert out["folds"] == baseline["folds"]


# --- [1,2,3]: shape only, no thin ----------------------------------------------------------------------

@pytest.mark.parametrize("fold", [0, 1])
def test_short_int_list_shape_only_no_thin(fold):
    out = _wf(Fake({fold: [1, 2, 3]}))
    assert out["warnings"] == [f"fold {fold}: unexpected equity shape (list)"]
    assert not any("thin" in w for w in out["warnings"])


# --- valid empty list / valid short list ---------------------------------------------------------------

def test_empty_list_fold0_matches_baseline_with_thin(baseline):
    out = _wf(Fake({0: []}))
    assert out["ok"] == baseline["ok"] is True
    assert out["folds"] == baseline["folds"]
    assert out["summary"] == baseline["summary"]
    assert _matching(out["warnings"], SHAPE) == []
    assert out["warnings"] == ["fold 0: thin test window (0 bars < 10)"]
    assert _fold_points(out, 0) == []
    # curve is continuous, so folds 1-2 match the clean run even without a fold-0 anchor
    assert out["oos_equity"] == [p for p in baseline["oos_equity"] if not p["date"].startswith("f0-")]


def test_empty_list_all_folds_oos_empty(baseline):
    out = _wf(Fake({0: [], 1: [], 2: []}))
    assert out["ok"] is True
    assert out["oos_equity"] == []
    assert out["folds"] == baseline["folds"]
    assert out["summary"] == baseline["summary"]
    assert out["warnings"] == [f"fold {i}: thin test window (0 bars < 10)" for i in range(N_FOLDS)]


def test_empty_list_later_fold_keeps_rescale_warning(baseline):
    out = _wf(Fake({1: []}))
    assert out["folds"] == baseline["folds"]
    assert out["summary"] == baseline["summary"]
    assert out["warnings"] == [
        "fold 1: thin test window (0 bars < 10)",
        "fold 1: equity not rescaled (first value None)",
    ]
    assert _matching(out["warnings"], SHAPE) == []


def test_valid_short_list_thin_no_shape(baseline):
    short = _fold_equity(1, True)[:3]
    out = _wf(Fake({1: short}))
    assert out["ok"] is True
    assert out["folds"] == baseline["folds"]
    assert out["warnings"] == ["fold 1: thin test window (3 bars < 10)"]
    assert _matching(out["warnings"], SHAPE) == []
    assert _fold_points(out, 1) == short  # scale is 1.0 on the continuous curve
