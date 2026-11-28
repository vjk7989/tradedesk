"""TM2-68: explicit ISO8601 ``filed`` parsing in ``fundamentals_loader._ffill_pit``.

Covers mixed date / date-time strings, the single drop warning, the never-raise
fallback for mixed tz-aware and naive strings, byte-identical all-ISO output
(pinned to hard-coded values), and no look-ahead for uniformly tz-suffixed
``filed`` (fixed by TM2-70).
"""

from __future__ import annotations

import logging
import math
import re

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.loaders import fundamentals_loader

LOGGER_NAME = fundamentals_loader.logger.name
UNITS = ["s", "ms", "us", "ns"]
_WARN_RE = re.compile(r"^_ffill_pit dropped (\d+) unparseable filed value\(s\); examples: (.*)$")


def _nan_aware(series: pd.Series) -> list:
    return [None if (isinstance(v, float) and math.isnan(v)) else v for v in series.tolist()]


def _drop_warnings(caplog) -> list[logging.LogRecord]:
    return [
        r
        for r in caplog.records
        if r.name == LOGGER_NAME and r.levelno == logging.WARNING and "_ffill_pit dropped" in r.getMessage()
    ]


def _run(caplog, filed, values, index):
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = fundamentals_loader._ffill_pit(pd.DataFrame({"filed": filed, "value": values}), index)
    return out, _drop_warnings(caplog)


# ── 1. Mixed date and date-time strings (TM2-60 example) ──────────────────────

_FF_DAYS = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09"]


@pytest.mark.parametrize(
    "filed",
    [
        ["2024-01-03", "2024-01-04 16:30", "2024-01-05", "2024-01-09"],
        ["2024-01-03", "2024-01-04T16:30:00", "2024-01-05 00:00", "2024-01-09"],
        ["2024-01-03 00:00", "2024-01-04 16:30", "2024-01-05", "2024-01-09T00:00:00"],
    ],
)
def test_mixed_date_and_datetime_strings_all_parse(caplog, filed):
    index = pd.DatetimeIndex(_FF_DAYS)
    out, warns = _run(caplog, filed, [1.0, 2.0, 3.0, 4.0], index)
    assert _nan_aware(out) == [None, 1.0, 2.0, 3.0, 3.0, 4.0]
    assert out.index.equals(index)
    assert warns == []


# ── 2. Unparseable values: dropped with exactly one warning ───────────────────

_IDX5 = pd.DatetimeIndex(["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"])


def test_unparseable_values_dropped_with_one_warning(caplog):
    filed = ["2024-01-03", "garbage", "2024-13-45", "x4", None, "2024-01-05"]
    out, warns = _run(caplog, filed, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], _IDX5)

    # Good rows (01-03 -> 1.0, 01-05 -> 6.0) are kept; bad and None rows dropped.
    assert _nan_aware(out) == [None, 1.0, 1.0, 6.0, 6.0]
    assert len(warns) == 1
    m = _WARN_RE.match(warns[0].getMessage())
    assert m, warns[0].getMessage()
    assert int(m.group(1)) == 3  # None is not counted
    examples = m.group(2).split(", ")
    assert 1 <= len(examples) <= 3
    assert examples == ["'garbage'", "'2024-13-45'", "'x4'"]


def test_more_than_three_bad_values_caps_examples(caplog):
    filed = ["2024-01-03", "a", "b", "c", "d", "e"]
    out, warns = _run(caplog, filed, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], _IDX5)
    assert _nan_aware(out) == [None, 1.0, 1.0, 1.0, 1.0]
    assert len(warns) == 1
    m = _WARN_RE.match(warns[0].getMessage())
    assert int(m.group(1)) == 5
    assert m.group(2).split(", ") == ["'a'", "'b'", "'c'"]
    # No data values beyond the 3 examples leak into the message.
    assert "'d'" not in warns[0].getMessage() and "'e'" not in warns[0].getMessage()


# ── 3. No warning when everything parses (nulls are not failures) ─────────────


@pytest.mark.parametrize("null", [None, np.nan, pd.NaT], ids=["None", "NaN", "NaT"])
def test_no_warning_when_all_parse_with_nulls(caplog, null):
    filed = ["2024-01-03", null, "2024-01-05 10:00"]
    out, warns = _run(caplog, filed, [1.0, 2.0, 3.0], _IDX5)
    assert _nan_aware(out) == [None, 1.0, 1.0, 3.0, 3.0]
    assert warns == []


@pytest.mark.parametrize("unit", UNITS)
def test_no_warning_for_datetime64_with_nat(caplog, unit):
    filed = pd.DatetimeIndex(["2024-01-03", None, "2024-01-05"]).as_unit(unit)
    out, warns = _run(caplog, filed, [1.0, 2.0, 3.0], _IDX5)
    assert _nan_aware(out) == [None, 1.0, 1.0, 3.0, 3.0]
    assert warns == []


def test_no_warning_for_clean_strings(caplog):
    out, warns = _run(caplog, ["2024-01-03", "2024-01-05"], [1.0, 2.0], _IDX5)
    assert _nan_aware(out) == [None, 1.0, 1.0, 2.0, 2.0]
    assert warns == []


# ── 4. Never raises on mixed tz-aware and naive strings ───────────────────────


def test_mixed_tz_naive_first_does_not_raise(caplog):
    filed = ["2024-01-03", "2024-01-04T16:30:00Z", "2024-01-05 10:00"]
    out, warns = _run(caplog, filed, [1.0, 2.0, 3.0], _IDX5)
    assert _nan_aware(out) == [None, 1.0, 1.0, 3.0, 3.0]  # naive rows kept
    assert len(warns) == 1
    m = _WARN_RE.match(warns[0].getMessage())
    assert int(m.group(1)) == 1
    assert m.group(2) == "'2024-01-04T16:30:00Z'"


def test_mixed_tz_aware_first_does_not_raise(caplog):
    filed = ["2024-01-04T16:30:00Z", "2024-01-03", "2024-01-05T00:00:00+05:30", "2024-01-08"]
    out, warns = _run(caplog, filed, [1.0, 2.0, 3.0, 4.0], _IDX5)
    # No tz value leaks onto any bar: 2.0 from 01-03, 4.0 from 01-08.
    assert _nan_aware(out) == [None, 2.0, 2.0, 2.0, 4.0]
    assert len(warns) == 1
    m = _WARN_RE.match(warns[0].getMessage())
    assert int(m.group(1)) == 2
    assert m.group(2) == "'2024-01-04T16:30:00Z', '2024-01-05T00:00:00+05:30'"


# ── 5. Byte-identical all-ISO behaviour (pinned) ──────────────────────────────

_PIN_IDX = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09", "2024-01-10"]
_PIN_FILED = ["2024-01-05", "2024-01-03", "2024-01-05", "2024-01-09"]  # unsorted, duplicate day
_PIN_VALUES = [3.0, 1.0, 3.5, 4.0]
_PIN_EXPECTED = [None, 1.0, 1.0, 3.5, 3.5, 4.0, 4.0]  # duplicate day keeps last (3.5)
_PIN_CSV = (
    ",value\n2024-01-02,\n2024-01-03,1.0\n2024-01-04,1.0\n2024-01-05,3.5\n"
    "2024-01-08,3.5\n2024-01-09,4.0\n2024-01-10,4.0\n"
)


@pytest.mark.parametrize("index_unit", ["us", "ns"])
@pytest.mark.parametrize("filed_unit", [None, *UNITS], ids=["iso-str", *UNITS])
def test_all_iso_output_pinned(caplog, filed_unit, index_unit):
    index = pd.DatetimeIndex(_PIN_IDX).as_unit(index_unit)
    filed = list(_PIN_FILED) if filed_unit is None else pd.DatetimeIndex(_PIN_FILED).as_unit(filed_unit)
    out, warns = _run(caplog, filed, list(_PIN_VALUES), index)
    assert _nan_aware(out) == _PIN_EXPECTED
    assert out.dtype == np.float64
    assert out.name == "value"
    assert out.index.equals(index)
    assert out.index.dtype == np.dtype(f"datetime64[{index_unit}]")
    assert out.to_csv() == _PIN_CSV
    assert warns == []


def test_empty_frame_output_pinned(caplog):
    index = pd.DatetimeIndex(_PIN_IDX)
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = fundamentals_loader._ffill_pit(pd.DataFrame({"filed": [], "value": []}, dtype=object), index)
    assert out.dtype == np.float64
    assert out.name is None
    assert out.index.equals(index)
    assert out.isna().all()
    assert _drop_warnings(caplog) == []


# ── 6. Uniformly tz-suffixed filed vs naive index (no look-ahead, TM2-70) ─────


@pytest.mark.parametrize(
    "filed",
    [
        ["2024-01-03T00:00:00Z", "2024-01-05T00:00:00Z"],
        ["2024-01-03T00:00:00+05:30", "2024-01-05T00:00:00+05:30"],
    ],
    ids=["Z", "+05:30"],
)
def test_all_tz_suffixed_filed_has_no_lookahead(caplog, filed):
    out, _ = _run(caplog, filed, [1.0, 2.0], _IDX5)
    # Correct PIT expectation: no value before its filed date.
    assert _nan_aware(out) == [None, 1.0, 1.0, 2.0, 2.0]
