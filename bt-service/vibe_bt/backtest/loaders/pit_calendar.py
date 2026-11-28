"""Shared calendar normalisation for point-in-time (PIT) joins.

Every loader that compares source dates (SEC ``filed``, Tushare membership
dates, feed ``knowable_date``) against a caller's bar index must first put both
sides in one representation: **naive wall-clock in the market's own timezone**.
Joining tz-aware against naive values silently builds object-dtype, unsorted
unions (``ffill`` then carries values backwards) or compares UTC epochs with
naive dates (a day-boundary shift), so the rule is applied before every union,
merge, reindex or comparison and followed by :func:`assert_clean_datetime_index`.

Rule (same as ``tushare_fundamentals`` TM2-67):

* a naive index is taken as already market-local and returned unchanged;
* a tz-aware index is converted to the market timezone, then made naive;
* callers keep and return the caller's original index object.
"""

from __future__ import annotations

import pandas as pd


class PitCalendarError(RuntimeError):
    """Internal invariant violation while aligning PIT dates to a bar index."""


def market_calendar_index(index: pd.DatetimeIndex, market_tz: str) -> pd.DatetimeIndex:
    """Return ``index`` as naive market-local wall-clock timestamps.

    Naive input is returned as-is (identity), preserving its unit and name.
    """
    idx = pd.DatetimeIndex(index)
    if idx.tz is None:
        return idx
    return idx.tz_convert(market_tz).tz_localize(None)


def assert_clean_datetime_index(
    index: pd.Index, where: str, *, monotonic: bool = False
) -> None:
    """Raise :class:`PitCalendarError` if ``index`` is not a clean naive datetime index.

    Args:
        index: Index produced by a union / merge / reindex of date keys.
        where: Short description of the join, for the error message.
        monotonic: Also require a monotonic non-decreasing index (use where the
            join is forward-filled, so ``ffill`` can never run backwards).
    """
    if not isinstance(index, pd.DatetimeIndex):
        raise PitCalendarError(
            f"{where}: PIT join produced a {type(index).__name__} "
            f"(dtype={index.dtype}), expected a naive DatetimeIndex; "
            "tz-aware and naive dates were mixed"
        )
    if index.tz is not None:
        raise PitCalendarError(
            f"{where}: PIT join produced tz-aware index ({index.tz}); "
            "normalise to market-local naive before joining"
        )
    # NaT keys (accepted on main) are ignored for the ordering check.
    if monotonic and not index[~index.isna()].is_monotonic_increasing:
        raise PitCalendarError(f"{where}: PIT join index is not monotonic increasing")
