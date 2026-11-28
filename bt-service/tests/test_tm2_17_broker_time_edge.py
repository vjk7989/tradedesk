"""TM2-17 adversarial edge tests: ISO8601 parse vs the old inferred parse.

Property under test: for every input, ``_bars_to_frame`` (new code path,
``format="ISO8601"``, run under ``simplefilter("error")``) yields the same final
frame (index after ``tz_localize(None)``, values, row set) as the OLD path
(``pd.to_datetime(..., errors="coerce")`` with format inference), which is
recomputed inline here under ``warnings.catch_warnings()``.

Findings on pandas 2.3.3 (see the individual tests for detail):

* Identical for every homogeneous column the brokers produce: ``+05:30``,
  ``+00:00``, ``Z``, naive, ``T`` or space separator, 3/6/9-digit fractions,
  date-only, leading whitespace, trailing whitespace on datetimes, empty/None/NaN,
  garbage, single row, all-bad.
* Date-only strings with trailing whitespace (``"2024-01-02 "``) became NaT
  under the first ISO8601 commit; fixed in round 1 (strings are stripped).
* Fix round 1 masks rows whose tz-awareness differs from the first non-null
  row, so offset/naive mixes are now dropped like the old path (no raise).
* **Regression, kept failing**: that awareness decision uses the first
  *string*, even ``""``, whitespace-only or garbage. A junk first row marks
  the column naive and NaT-s every offset row, so the loader returns ``None``.
* Divergent but heterogeneous columns that one broker response should not
  produce. These are ``xfail(strict=True)`` and documented: the old parse locked
  onto the first row's format and silently NaT-ed (so dropped) any row with a
  different shape; ISO8601 parses those rows. Mixed separators, optional
  fraction, date-only mixed with datetimes, per-row whitespace.
* The old path emitted the "Could not infer format" UserWarning when the first
  row was garbage, the whole column was garbage, or rows had trailing
  whitespace after an offset. The comparison still holds (same values), and the
  new path is silent.
"""

from __future__ import annotations

import re
import warnings
from typing import Optional

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.loaders import india_broker_loader as ibl

START, END = "2023-01-01", "2025-12-31"
_COLS = ibl._OUTPUT_COLUMNS


# --------------------------------------------------------------------------- helpers


def _bars(times: list) -> list[dict]:
    """One bar per ``time`` value, with distinct closes so row identity is visible."""
    return [
        {"time": t, "open": 100.0 + i, "high": 101.0 + i, "low": 99.0 + i, "close": 100.5 + i, "volume": 10 + i}
        for i, t in enumerate(times)
    ]


def _old_bars_to_frame(bars: list[dict], start_date: str, end_date: str) -> Optional[pd.DataFrame]:
    """Verbatim copy of ``_bars_to_frame`` from origin/main (inferred-format parse)."""
    if not bars:
        return None
    frame = pd.DataFrame(bars)
    if "time" not in frame.columns:
        return None
    ts = pd.to_numeric(frame["time"], errors="coerce")
    if ts.notna().any():
        index = pd.to_datetime(ts, unit="s", errors="coerce")
    else:
        index = pd.to_datetime(frame["time"], errors="coerce")
    frame = frame.drop(columns=["time"])
    frame.index = pd.DatetimeIndex(index).tz_localize(None)
    frame.index.name = "trade_date"
    for col in _COLS:
        if col not in frame.columns:
            frame[col] = 0.0 if col == "volume" else pd.NA
    frame = frame[_COLS].apply(pd.to_numeric, errors="coerce")
    frame = frame.dropna(subset=["open", "high", "low", "close"]).sort_index()
    lower = pd.Timestamp(start_date).normalize()
    upper = pd.Timestamp(end_date).normalize() + pd.Timedelta(1, "D")
    frame = frame[(frame.index >= lower) & (frame.index < upper)]
    return frame.astype(float) if not frame.empty else None


def _old(times: list):
    """Old result (frame/None, or the exception type), with warnings captured."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            out = _old_bars_to_frame(_bars(times), START, END)
        except Exception as exc:  # noqa: BLE001 — recorded for comparison
            out = type(exc)
    return out, caught


def _new(times: list):
    """New result under ``simplefilter("error")``: any warning is a failure."""
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            return ibl._bars_to_frame(_bars(times), START, END)
        except Exception as exc:  # noqa: BLE001 — recorded for comparison
            return type(exc)


_SUB_MICRO = re.compile(r"\.\d{7,}")


def _parse_unit(times: list) -> str:
    """Index unit both paths should yield on pandas 3 (the locked env).

    ``_bars_to_frame`` (old and new) does not ns-normalise: the index keeps
    whatever resolution ``pd.to_datetime`` infers. On pandas 3 that is ``us``
    unless a value carries sub-microsecond digits, which forces ``ns``.
    """
    return "ns" if any(isinstance(t, str) and _SUB_MICRO.search(t) for t in times) else "us"


def _assert_same(old, new, unit: str) -> None:
    if old is None or new is None or isinstance(old, type) or isinstance(new, type):
        assert old is new, f"old={old!r} new={new!r}"
        return
    # Pass-through of the parse unit (no ns normalisation on this path): assert
    # both sides explicitly so the comparison cannot pass merely because they share
    # a unit, and so a future ns normalisation of either side is caught here.
    assert old.index.unit == unit, (old.index.unit, unit)
    assert new.index.unit == unit, (new.index.unit, unit)
    pd.testing.assert_frame_equal(new, old, check_exact=True)
    assert new.index.tz is None
    assert new.index.dtype == old.index.dtype


def _check(times: list, *, old_may_warn: bool = False):
    old, caught = _old(times)
    if not old_may_warn:
        # Guard: if the old path had warned, its result might not be the baseline we think.
        assert not caught, [str(w.message) for w in caught]
    new = _new(times)
    _assert_same(old, new, _parse_unit(times))
    return new


def _idx(frame) -> list:
    return [] if frame is None else list(frame.index)


TS = pd.Timestamp


# ----------------------------------------------------------- identical: offsets / Z


@pytest.mark.parametrize(
    "times, wall",
    [
        (["2024-01-02T09:15:00+05:30", "2024-01-03T09:15:00+05:30"], "09:15"),
        (["2024-01-02 09:15:00+05:30", "2024-01-03 09:15:00+05:30"], "09:15"),
        (["2024-01-02T09:15:00+0530", "2024-01-03T09:15:00+0530"], "09:15"),
        (["2024-01-02T03:45:00+00:00", "2024-01-03T03:45:00+00:00"], "03:45"),
        (["2024-01-02T03:45:00Z", "2024-01-03T03:45:00Z"], "03:45"),
    ],
    ids=["ist_T", "ist_space", "ist_nocolon", "utc_offset", "zulu"],
)
def test_offsets_identical_and_keep_wall_clock(times, wall):
    new = _check(times)
    # tz_localize(None) keeps the wall clock of the given offset, it does NOT convert.
    assert [t.strftime("%H:%M") for t in new.index] == [wall, wall]


def test_ist_offset_no_dst_across_year():
    """+05:30 in Jan and Jul: IST has no DST, so wall clock is stable both ways."""
    times = ["2024-01-15T09:15:00+05:30", "2024-07-15T09:15:00+05:30", "2024-11-03T09:15:00+05:30"]
    new = _check(times)
    assert all(t.strftime("%H:%M") == "09:15" for t in new.index)


def test_utc_strings_are_not_converted_to_ist():
    """Both paths drop tz without conversion: 03:45Z stays 03:45, not 09:15 IST."""
    new = _check(["2024-01-02T03:45:00Z"])
    assert _idx(new) == [TS("2024-01-02 03:45")]
    # And the IST equivalent of that instant differs - documenting, not changing, behaviour.
    assert TS("2024-01-02T03:45:00Z").tz_convert("Asia/Kolkata").tz_localize(None) == TS("2024-01-02 09:15")


def test_tz_aware_python_and_pandas_objects_identical():
    """Non-string tz-aware values (SDK may hand back datetimes) take the same branch."""
    a = pd.Timestamp("2024-01-02 09:15", tz="Asia/Kolkata")
    b = pd.Timestamp("2024-01-03 09:15", tz="Asia/Kolkata")
    _check([a, b])
    _check([a.to_pydatetime(), b.to_pydatetime()])


# ---------------------------------------------------------------- identical: naive


@pytest.mark.parametrize(
    "times",
    [
        ["2024-01-02T09:15:00", "2024-01-03T09:15:00"],
        ["2024-01-02 09:15:00", "2024-01-03 09:15:00"],
        ["2024-01-02 09:15", "2024-01-03 09:15"],
        ["2024-01-02", "2024-01-03"],
    ],
    ids=["T", "space", "no_seconds", "date_only"],
)
def test_naive_identical(times):
    new = _check(times)
    assert len(new) == 2


@pytest.mark.parametrize(
    "times",
    [
        ["2024-01-02T09:15:00.123", "2024-01-03T09:15:00.456"],
        ["2024-01-02T09:15:00.123456", "2024-01-03T09:15:00.456789"],
        ["2024-01-02T09:15:00.123456789", "2024-01-03T09:15:00.000000001"],
        ["2024-01-02T09:15:00.123+05:30", "2024-01-03T09:15:00.456+05:30"],
        ["2024-01-02T03:45:00.123456789Z", "2024-01-03T03:45:00.987654321Z"],
    ],
    ids=["ms", "us", "ns", "ms_ist", "ns_zulu"],
)
def test_fractional_seconds_identical(times):
    new = _check(times)
    assert len(new) == 2


def test_nanosecond_precision_preserved():
    new = _check(["2024-01-02T09:15:00.123456789"])
    assert new.index[0] == TS("2024-01-02 09:15:00.123456789")


# ----------------------------------------------------------- identical: whitespace


@pytest.mark.parametrize(
    "times",
    [
        [" 2024-01-02T09:15:00", " 2024-01-03T09:15:00"],
        ["2024-01-02T09:15:00 ", "2024-01-03T09:15:00 "],
        [" 2024-01-02 09:15:00 ", " 2024-01-03 09:15:00 "],
        [" 2024-01-02", " 2024-01-03"],
    ],
    ids=["lead_dt", "trail_dt", "both_dt", "lead_date"],
)
def test_uniform_whitespace_identical(times):
    new = _check(times)
    assert len(new) == 2


def test_trailing_whitespace_after_offset_old_warned_but_values_match():
    """Old path emitted 'Could not infer format' here; values still match, new is silent."""
    times = ["2024-01-02T09:15:00+05:30 ", "2024-01-03T09:15:00+05:30 "]
    _, caught = _old(times)
    assert any("infer format" in str(w.message) for w in caught)
    new = _check(times, old_may_warn=True)
    assert _idx(new) == [TS("2024-01-02 09:15"), TS("2024-01-03 09:15")]


@pytest.mark.parametrize(
    "times",
    [
        ["2024-01-02 ", "2024-01-03 "],
        [" 2024-01-02 ", " 2024-01-03 "],
        ["2024-01-02\t", "2024-01-03\t"],
    ],
    ids=["trail_date", "both_date", "tab_date"],
)
def test_trailing_whitespace_date_only_identical(times):
    """Failed on the first commit, fixed in round 1 by stripping. Original finding:

    Old path: inferred ``%Y-%m-%d`` and parsed every row.
    New path: ISO8601 rejects the trailing whitespace after a date-only value,
    every row becomes NaT, the clip drops them all, and the loader returns
    ``None`` for the symbol, silently. A daily-bar feed with padded date strings
    is a plausible broker shape. (Trailing whitespace after a full datetime is
    accepted by ISO8601; only the date-only form breaks.)
    """
    _check(times)


# ---------------------------------------------------- identical: missing / garbage


@pytest.mark.parametrize(
    "bad",
    ["", None, np.nan, "not-a-date", "2024-13-45", "N/A", "null"],
    ids=["empty", "none", "nan", "garbage", "bad_month", "na", "null"],
)
def test_missing_and_garbage_rows_dropped_identically(bad):
    new = _check(["2024-01-02T09:15:00", bad, "2024-01-04T09:15:00"])
    assert _idx(new) == [TS("2024-01-02 09:15"), TS("2024-01-04 09:15")]
    assert list(new["close"]) == [100.5, 102.5]


def test_garbage_first_row_old_warned_values_match():
    times = ["garbage", "2024-01-02T09:15:00", "2024-01-03T09:15:00"]
    _, caught = _old(times)
    assert any("infer format" in str(w.message) for w in caught)
    new = _check(times, old_may_warn=True)
    assert _idx(new) == [TS("2024-01-02 09:15"), TS("2024-01-03 09:15")]


@pytest.mark.parametrize(
    "times",
    [["foo", "bar"], ["", None], [None, np.nan], ["", ""]],
    ids=["garbage", "empty_none", "none_nan", "empties"],
)
def test_all_bad_column_returns_none(times):
    _check(times, old_may_warn=True)
    assert _new(times) is None


def test_single_row_identical():
    new = _check(["2024-01-02T09:15:00+05:30"])
    assert _idx(new) == [TS("2024-01-02 09:15")]


def test_single_bad_row_returns_none():
    _check(["garbage"], old_may_warn=True)
    assert _new(["garbage"]) is None


def test_unsorted_input_sorted_identically():
    _check(["2024-01-03T09:15:00+05:30", "2024-01-02T09:15:00+05:30", "2024-01-04T09:15:00+05:30"])


# ------------------------------------------- divergent heterogeneous columns (xfail)

_HETERO_REASON = (
    "Old inferred parse locked onto row 0's format and silently NaT-ed (dropped) rows "
    "of any other shape; ISO8601 parses them. Heterogeneous shapes inside one broker "
    "response are not expected, so this is a documented behaviour change, not a "
    "blocker. strict=True so the test flips if pandas or the code converges."
)


@pytest.mark.xfail(strict=True, reason=_HETERO_REASON)
@pytest.mark.parametrize(
    "times",
    [
        ["2024-01-02T09:15:00", "2024-01-03 09:15:00"],
        ["2024-01-02 09:15:00", "2024-01-03T09:15:00"],
    ],
    ids=["T_then_space", "space_then_T"],
)
def test_mixed_separators_diverge(times):
    _check(times)


@pytest.mark.xfail(strict=True, reason=_HETERO_REASON)
def test_optional_fraction_diverges():
    # e.g. datetime.isoformat() omits ".ffffff" when microsecond == 0.
    _check(["2024-01-02T09:15:00", "2024-01-03T09:15:00.500000"])


@pytest.mark.xfail(strict=True, reason=_HETERO_REASON)
@pytest.mark.parametrize(
    "times",
    [["2024-01-02", "2024-01-03T09:15:00"], ["2024-01-02T09:15:00", "2024-01-03"]],
    ids=["date_then_dt", "dt_then_date"],
)
def test_date_only_mixed_with_datetime_diverges(times):
    _check(times)


@pytest.mark.xfail(strict=True, reason=_HETERO_REASON)
def test_per_row_whitespace_diverges():
    _check([" 2024-01-02T09:15:00", "2024-01-03T09:15:00 "])


@pytest.mark.parametrize(
    "times",
    [
        ["2024-01-02T09:15:00+05:30", "2024-01-03T09:15:00"],
        ["2024-01-02T09:15:00+0530", "2024-01-03T09:15:00"],
        ["2024-01-02T03:45:00Z", "2024-01-03T03:45:00"],
    ],
    ids=["ist", "ist_nocolon", "zulu"],
)
def test_offset_then_naive_row_dropped_like_old(times):
    """Fix round 1: the naive row is NaT-ed and dropped (old behaviour), no offset stamping."""
    new = _check(times)
    assert len(new) == 1 and list(new["close"]) == [100.5]


@pytest.mark.parametrize(
    "times",
    [
        ["2024-01-02T09:15:00", "2024-01-03T09:15:00+05:30"],
        ["2024-01-02T09:15:00", "2024-01-03T09:15:00+0530"],
        ["2024-01-02T03:45:00", "2024-01-03T03:45:00Z"],
    ],
    ids=["ist", "ist_nocolon", "zulu"],
)
def test_naive_then_offset_row_dropped_like_old_no_exception(times):
    """Fix round 1: the offset row is NaT-ed and dropped; no FutureWarning, no ValueError."""
    new = _check(times)
    assert not isinstance(new, type), f"raised {new!r}"
    assert len(new) == 1 and list(new["close"]) == [100.5]


# ------------------------------------------------------------- fix round 1 coverage


def test_fix_date_only_trailing_whitespace_mixed_rows_identical():
    # Uniform padding per column (per-row differences are the documented xfail divergence).
    for pad in (("", " "), (" ", " "), ("", "\t"), ("", "  ")):
        new = _check([f"{pad[0]}2024-01-0{d}{pad[1]}" for d in (2, 3, 4)])
        assert _idx(new) == [TS("2024-01-02"), TS("2024-01-03"), TS("2024-01-04")]


@pytest.mark.parametrize(
    "times",
    [
        [" 2024-01-02T09:15:00+05:30 ", " 2024-01-03T09:15:00+05:30 "],
        ["  2024-01-02T09:15:00+0530\t", "  2024-01-03T09:15:00+0530\t"],
        ["\t2024-01-02T03:45:00Z\n", "\t2024-01-03T03:45:00Z\n"],
    ],
    ids=["padded_all", "padded_nocolon", "zulu_tab_nl"],
)
def test_fix_padded_offset_strings_parse(times):
    new = _check(times, old_may_warn=True)
    assert len(new) == 2
    assert new.index[0].strftime("%H:%M") in ("09:15", "03:45")


@pytest.mark.parametrize("lead", [None, np.nan], ids=["none", "nan"])
@pytest.mark.parametrize(
    "rest",
    [
        ["2024-01-02T09:15:00+05:30", "2024-01-03T09:15:00+05:30"],
        ["2024-01-02T09:15:00", "2024-01-03T09:15:00"],
        ["2024-01-02T09:15:00+05:30", "2024-01-03T09:15:00"],
    ],
    ids=["aware", "naive", "aware_then_naive"],
)
def test_fix_leading_null_skipped_for_awareness(lead, rest):
    new = _check([lead] + rest)
    assert new.index[0] == TS("2024-01-02 09:15")


@pytest.mark.parametrize(
    "aware_row",
    ["2024-01-02T09:15:00+0530", "2024-01-02T09:15:00+05:30", "2024-01-02T03:45:00Z", "2024-01-02T09:15:00-0400"],
    ids=["nocolon", "colon", "zulu", "negative"],
)
def test_fix_suffix_forms_count_as_aware(aware_row):
    """Each form is aware: alongside another aware row both survive; alongside naive, naive drops."""
    # Second row has the same suffix (mixed offsets raise on both paths, tested separately).
    both = _check([aware_row, aware_row.replace("2024-01-02", "2024-01-03")])
    assert len(both) == 2
    mixed = _check([aware_row, "2024-01-03T09:15:00"])
    assert len(mixed) == 1


@pytest.mark.parametrize(
    "lead",
    ["", "   ", "garbage"],
    ids=["empty", "whitespace_only", "garbage"],
)
def test_fix_REGRESSION_junk_first_row_decides_awareness(lead):
    """KEPT FAILING ON PURPOSE (found in fix round 1).

    The awareness mask uses the first non-null *string*, and ``""``, ``"   "``
    (empty after strip) and ``"garbage"`` are strings with no tz suffix, so
    they count as "naive". Every +05:30 row after them is then masked to NaT
    and the loader returns None for the symbol. The old inferred parse skipped
    the junk row and parsed every offset row. An empty first ``time`` field is
    a plausible broker shape. Suggested fix: decide awareness from the first
    row that actually parses (or skip empty or unparseable strings).
    """
    new = _check([lead, "2024-01-02T09:15:00+05:30", "2024-01-03T09:15:00+05:30"], old_may_warn=True)
    assert len(new) == 2


def test_mixed_offsets_raise_on_both_paths():
    """+05:30 and +00:00 in one column: both paths raise ValueError (pre-existing)."""
    times = ["2024-01-02T09:15:00+05:30", "2024-01-03T03:45:00+00:00"]
    old, _ = _old(times)
    assert old is ValueError
    new = _new(times)
    # New path under simplefilter("error") trips the FutureWarning first.
    assert new in (ValueError, FutureWarning)
