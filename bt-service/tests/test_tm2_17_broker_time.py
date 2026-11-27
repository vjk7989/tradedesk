"""TM2-17: explicit ISO8601 parse in india_broker_loader must be warning-free and value-identical."""
import warnings

import pandas as pd
import pytest

from vibe_bt.backtest.loaders.india_broker_loader import _bars_to_frame


def _bar(i=0):
    return {"open": 1.0 + i, "high": 2.0 + i, "low": 0.5 + i, "close": 1.5 + i, "volume": 10}


def _run(times):
    bars = [{"time": t, **_bar(i)} for i, t in enumerate(times)]
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        return _bars_to_frame(bars, "2024-01-01", "2024-12-31")


def _legacy(times):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return pd.DatetimeIndex(pd.to_datetime(pd.Series(times), errors="coerce")).tz_localize(None)


@pytest.mark.parametrize(
    "times",
    [
        ["2024-03-01T09:15:00", "2024-03-01T09:16:00"],  # naive ISO
        ["2024-03-01T09:15:00+05:30", "2024-03-01T09:16:00+05:30"],  # IST offset
        ["2024-03-01T03:45:00Z", "2024-03-01T03:46:00Z"],  # UTC Z
        ["2024-03-01 09:15:00", "2024-03-01 09:16:00"],  # space separator
        ["2024-03-01", "2024-03-04"],  # date only
        ["2024-03-01T09:15:00.500", "2024-03-01T09:16:00.250"],  # fractional
    ],
)
def test_identical_index_no_warning(times):
    out = _run(times)
    assert out is not None
    expected = _legacy(times)
    assert list(out.index) == list(expected)
    assert out.index.tz is None


def test_bad_strings_become_nat_and_are_dropped():
    out = _run(["not-a-date", "2024-02-29T10:00:00"])
    assert out is not None and len(out) == 1
    assert out.index[0] == pd.Timestamp("2024-02-29 10:00:00")
