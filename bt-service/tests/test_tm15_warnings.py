"""TM-15: local_loader._resample_to_interval must not emit numpy generic-timedelta warnings."""
import warnings

import pandas as pd
import pytest

from vibe_bt.backtest.loaders import local_loader
from vibe_bt.backtest.loaders.local_loader import _RESAMPLE_RULES, _resample_to_interval

# Hand-written expected bar widths (minutes) per interval.
_MINUTES = {
    "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30,
    "1H": 60, "1h": 60, "4H": 240, "4h": 240, "1D": 1440, "1d": 1440,
}


def _frame(n_minutes=2 * 1440 + 30):
    idx = pd.date_range("2025-04-01 09:15", periods=n_minutes, freq="min")
    close = pd.Series(range(n_minutes), index=idx, dtype="float64") + 100.0
    return pd.DataFrame(
        {"open": close, "high": close + 1, "low": close - 1, "close": close + 0.5,
         "volume": 1.0},
        index=idx,
    )


def test_resample_rules_cover_all_intervals():
    assert set(_RESAMPLE_RULES) == set(_MINUTES)


@pytest.mark.parametrize("interval", list(_MINUTES))
def test_resample_no_warning_and_values(interval):
    df = _frame()
    anchor = pd.Timestamp("2000-01-03 09:15")
    minutes = _MINUTES[interval]
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        warnings.simplefilter("error", FutureWarning)
        out = _resample_to_interval(df, interval, "TEST", anchor)

    if minutes == 1:
        # equals source granularity: returned unchanged
        pd.testing.assert_frame_equal(out, df)
        return

    # Hand-computed expectation: floor timestamps to the bin start and aggregate.
    if minutes in (3, 10):
        # session-anchored bins: offset from 09:15 of the anchor day
        origin = pd.Timestamp("2025-04-01 09:15")
        mins = ((df.index - origin).total_seconds() // 60).astype("int64")
        k = mins // minutes
        starts = pd.DatetimeIndex([origin + pd.Timedelta(int(x) * minutes, unit="min") for x in k])
    else:
        starts = df.index.floor(f"{minutes}min")
    exp = df.groupby(starts).agg(
        open=("open", "first"), high=("high", "max"), low=("low", "min"),
        close=("close", "last"), volume=("volume", "sum"),
    )
    exp.index.name = df.index.name
    exp.index.freq = None
    out_cmp = out.copy()
    out_cmp.index.freq = None
    pd.testing.assert_frame_equal(out_cmp, exp, check_freq=False)
    assert out.dtypes.equals(df.dtypes)


def test_target_timedelta_is_ns_and_equal_for_every_rule():
    # The comparison path: a source median equal to / larger than the target.
    for interval, rule in _RESAMPLE_RULES.items():
        minutes = _MINUTES[interval]
        idx = pd.date_range("2025-04-01 09:15", periods=3, freq=f"{minutes}min")
        df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0,
                           "volume": 1.0}, index=idx)
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            # target == source: unchanged frame returned
            assert local_loader._resample_to_interval(df, interval, "T") is df
            # target < source (source twice as coarse): upsample refused, df returned
            idx2 = pd.date_range("2025-04-01 09:15", periods=3, freq=f"{minutes * 2}min")
            df2 = df.copy()
            df2.index = idx2
            assert local_loader._resample_to_interval(df2, interval, "T") is df2


def test_india_options_upto_expiry_no_warning_and_values():
    from datetime import date

    from vibe_bt.backtest.engines.india_options import IndiaOptionsEngine, OptionSpec

    spec = OptionSpec(root="NIFTY", expiry=date(2025, 4, 3), strike=100.0, kind="CE")
    idx = pd.to_datetime(
        ["2025-04-02 15:00", "2025-04-03 09:15", "2025-04-03 23:59", "2025-04-04 00:00"]
    )
    frame = pd.DataFrame({"close": [1.0, 2.0, float("nan"), 4.0]}, index=idx)
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        out = IndiaOptionsEngine._upto_expiry(frame, spec)
        tz_frame = frame.tz_localize("Asia/Kolkata")
        out_tz = IndiaOptionsEngine._upto_expiry(tz_frame, spec)
    # cutoff is expiry date + 1 day (midnight): rows strictly before 2025-04-04 00:00, NaN dropped
    assert list(out.index) == list(idx[:2]) and list(out.values) == [1.0, 2.0]
    assert list(out_tz.values) == [1.0, 2.0]
