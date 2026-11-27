"""TM-11 owner-side edge tests: every rewritten Timedelta site, called for real.

TM-11 rewrote 15 keyword-form ``pd.Timedelta(days=/hours=/seconds=)`` sites to
the explicit ``(value, unit)`` form. Each test below calls the function that
encloses one rewritten site (synthetic data, network/IO monkeypatched) under
``warnings.simplefilter("error", DeprecationWarning)`` and checks the result
against the OLD keyword form, evaluated here with warnings silenced
(``_old_td``). Clip boundaries are probed on both sides of the old bound
(``old_upper - 1s`` kept, ``old_upper`` dropped). Edges: leap days, year ends,
the IST/UTC midnight boundary, tz-aware vs naive input, NaT, empty input.

Modules are imported at top level on purpose: a missing module is a failure,
not a skip.
"""
import warnings
from contextlib import contextmanager

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.engines import options_portfolio
from vibe_bt.backtest.loaders import (
    _fundamental_schema,
    finnhub_loader,
    india_broker_loader,
    mootdx_loader,
    mt5_loader,
    nobitex,
    okx,
    rsshub_events,
    tencent_loader,
    tickerall_loader,
    tushare_fundamentals,
    wallex,
    yahoo_loader,
    yfinance_loader,
)

T = pd.Timestamp
IST = "Asia/Kolkata"


def _old_td(**kw) -> pd.Timedelta:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return pd.Timedelta(**kw)


@contextmanager
def _strict():
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        yield


def _epoch(ts) -> int:
    ts = T(ts)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return int(ts.value // 1_000_000_000)


def _same(new_fn, old_fn):
    """Run both; equal results, or the same exception type from both."""
    try:
        old = old_fn()
    except Exception as exc:  # noqa: BLE001
        with _strict(), pytest.raises(type(exc)):
            new_fn()
        return None
    with _strict():
        new = new_fn()
    if isinstance(old, float) and np.isnan(old):
        assert np.isnan(new)
    elif old is pd.NaT:
        assert new is pd.NaT
    else:
        assert new == old
    return new


# ── the constants themselves ──


def test_constants_match_keyword_form_exactly():
    assert pd.Timedelta(31557600, "s") == _old_td(days=365.25)
    assert pd.Timedelta(31557600, "s").value == _old_td(days=365.25).value
    assert pd.Timedelta(86399, "s") == _old_td(hours=23, minutes=59, seconds=59)
    assert pd.Timedelta(1, "D") - pd.Timedelta(1, "s") == _old_td(days=1) - _old_td(seconds=1)
    assert pd.Timedelta(365, "D") == _old_td(days=365)


# ── engines/options_portfolio.historical_volatility (365.25-day year) ──


def _old_hv(close, window=30, default_iv=0.3):
    spacing = pd.Series(close.index, index=close.index).diff().dt.total_seconds()
    mean_spacing = spacing.expanding().mean()
    bpy = _old_td(days=365.25).total_seconds() / mean_spacing.where(mean_spacing > 0)
    log_ret = np.log(close / close.shift(1))
    return (log_ret.rolling(window=window).std() * np.sqrt(bpy)).fillna(default_iv)


def _closes(index):
    rng = np.random.default_rng(7)
    return pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.01, len(index)))), index=index)


@pytest.mark.parametrize(
    "index",
    [
        pd.date_range("2024-02-01", "2024-03-31", freq="D"),  # spans 29 Feb
        pd.date_range("2023-12-20", "2024-01-20", freq="B"),  # year end, weekend gaps
        pd.date_range("2024-02-28 09:15", periods=80, freq="h"),  # intraday
        pd.date_range("2024-02-28", periods=60, freq="D", tz="UTC"),  # tz-aware
        pd.date_range("2024-02-28 18:30", periods=60, freq="D", tz=IST),  # IST
    ],
    ids=["leap-daily", "year-end-business", "hourly", "utc-aware", "ist-aware"],
)
def test_historical_volatility_none_bpy_matches_old(index):
    close = _closes(index)
    with _strict():
        got = options_portfolio.historical_volatility(close, window=5, bars_per_year=None)
    pd.testing.assert_series_equal(got, _old_hv(close, window=5), check_exact=True)


def test_historical_volatility_daily_bar_count_is_365_25():
    # One bar per calendar day: bars_per_year is exactly 365.25; window=2 gives
    # std of two returns, so hv = std * sqrt(365.25).
    close = pd.Series([100.0, 101.0, 99.0, 100.5], index=pd.date_range("2024-02-28", periods=4))
    with _strict():
        got = options_portfolio.historical_volatility(close, window=2, bars_per_year=None)
    lr = np.log(close / close.shift(1))
    assert got.iloc[2] == pytest.approx(lr.iloc[1:3].std() * np.sqrt(365.25), rel=0, abs=1e-15)


def test_historical_volatility_with_nat_in_index_matches_old():
    idx = pd.DatetimeIndex(["2024-02-27", "2024-02-28", pd.NaT, "2024-03-01", "2024-03-02", "2024-03-03"])
    close = pd.Series([100.0, 101.0, 102.0, 100.0, 99.0, 101.0], index=idx)
    with _strict():
        got = options_portfolio.historical_volatility(close, window=2, bars_per_year=None)
    pd.testing.assert_series_equal(got, _old_hv(close, window=2), check_exact=True)


@pytest.mark.parametrize("n", [0, 1])
def test_historical_volatility_empty_and_single_bar(n):
    close = pd.Series([100.0] * n, index=pd.date_range("2024-02-29", periods=n), dtype=float)
    with _strict():
        got = options_portfolio.historical_volatility(close, window=2, bars_per_year=None)
    pd.testing.assert_series_equal(got, _old_hv(close, window=2), check_exact=True)
    assert (got == 0.3).all()


# ── loaders/_fundamental_schema._lag_365d ──


def _old_lag(series):
    lagged = series.reindex(series.index - _old_td(days=365), method="ffill")
    lagged.index = series.index
    return lagged


def test_lag_365d_across_leap_year_matches_old():
    idx = pd.date_range("2023-01-01", "2025-03-05", freq="D")
    s = pd.Series(np.arange(len(idx), dtype=float), index=idx)
    with _strict():
        got = _fundamental_schema._lag_365d(s)
    pd.testing.assert_series_equal(got, _old_lag(s), check_exact=True)
    # 365 days before a leap-year date lands one calendar day later than "a year ago".
    assert got[T("2024-02-29")] == s[T("2023-03-01")]
    assert got[T("2024-12-31")] == s[T("2024-01-01")]
    assert got[T("2025-03-01")] == s[T("2024-03-01")]
    assert np.isnan(got[T("2023-12-31")])  # 2022-12-31 predates the series


def test_lag_365d_tz_aware_and_sparse_matches_old():
    idx = pd.DatetimeIndex(["2023-03-31", "2023-06-30", "2024-03-30", "2024-03-31"], tz=IST)
    s = pd.Series([1.0, 2.0, 3.0, 4.0], index=idx)
    with _strict():
        got = _fundamental_schema._lag_365d(s)
    pd.testing.assert_series_equal(got, _old_lag(s), check_exact=True)
    # 2024-03-30 - 365D = 2023-03-31 (leap year in between): exact hit.
    assert list(got.values[2:]) == [1.0, 1.0]


def test_lag_365d_empty_series():
    s = pd.Series([], index=pd.DatetimeIndex([]), dtype=float)
    with _strict():
        got = _fundamental_schema._lag_365d(s)
    assert got.empty
    pd.testing.assert_series_equal(got, _old_lag(s))


def test_lag_365d_nat_index_same_outcome_as_old():
    s = pd.Series([1.0, 2.0], index=pd.DatetimeIndex(["2024-02-29", pd.NaT]))
    _same(
        lambda: _fundamental_schema._lag_365d(s).tolist(),
        lambda: _old_lag(s).tolist(),
    )


# ── loaders/finnhub_loader._to_epoch_seconds (23:59:59 end) ──


def _old_epoch(date_str, end_of_day):
    ts = T(date_str).normalize()
    if end_of_day:
        ts = ts + _old_td(hours=23, minutes=59, seconds=59)
    return int(ts.value // 1_000_000_000)


@pytest.mark.parametrize(
    "date_str",
    [
        "2024-02-29",
        "2023-02-28",
        "2023-12-31",
        "1970-01-01",
        "1969-12-31",  # negative epoch: floor division
        "2024-02-29T23:59:59.999",  # normalize drops the time first
        "2024-02-29T00:00:00+05:30",  # IST midnight = previous UTC day 18:30
        "2024-02-29T23:30:00+05:30",
        "2024-02-29T00:00:00Z",
    ],
)
@pytest.mark.parametrize("end_of_day", [False, True])
def test_to_epoch_seconds_matches_old(date_str, end_of_day):
    with _strict():
        got = finnhub_loader._to_epoch_seconds(date_str, end_of_day=end_of_day)
    assert got == _old_epoch(date_str, end_of_day)


def test_to_epoch_seconds_exact_values():
    with _strict():
        assert finnhub_loader._to_epoch_seconds("1970-01-01", end_of_day=True) == 86399
        assert finnhub_loader._to_epoch_seconds("1970-01-01", end_of_day=False) == 0
        start = finnhub_loader._to_epoch_seconds("2024-02-29", end_of_day=False)
        end = finnhub_loader._to_epoch_seconds("2024-02-29", end_of_day=True)
        ist = finnhub_loader._to_epoch_seconds("2024-02-29T00:00:00+05:30", end_of_day=True)
    assert end - start == 86399
    assert start == _epoch("2024-02-29")
    assert ist == _epoch("2024-02-28T18:30:00") + 86399


def test_to_epoch_seconds_nat_same_as_old():
    _same(
        lambda: finnhub_loader._to_epoch_seconds("NaT", end_of_day=True),
        lambda: _old_epoch("NaT", True),
    )


# ── shared clip-boundary fixtures ──

END = "2024-02-29"
OLD_UPPER = T(END) + _old_td(days=1)  # 2024-03-01 00:00, exclusive
IN_LAST = OLD_UPPER - _old_td(seconds=1)  # 2024-02-29 23:59:59, inclusive
START = "2024-02-28"


def _bar(t, close=10.0):
    return {"open": close, "high": close + 1, "low": close - 1, "close": close, "volume": 5.0}


# ── loaders/india_broker_loader._bars_to_frame ──


def test_india_broker_bars_clip_at_old_upper_epoch():
    times = [T("2024-02-27 23:59:59"), T(START), IN_LAST, OLD_UPPER]
    bars = [{"time": _epoch(t), **_bar(t)} for t in times]
    with _strict():
        got = india_broker_loader._bars_to_frame(bars, START, END)
    assert list(got.index) == [T(START), IN_LAST]


def test_india_broker_bars_ist_iso_strings_wall_time():
    # tz-aware ISO input is reduced to its wall time; 23:59:59 IST on the end day stays.
    bars = [
        {"time": "2024-02-29T23:59:59+05:30", **_bar(0)},
        {"time": "2024-03-01T00:00:00+05:30", **_bar(0)},
    ]
    with _strict():
        got = india_broker_loader._bars_to_frame(bars, START, END)
    assert list(got.index) == [IN_LAST]


def test_india_broker_bars_ist_midnight_epoch_is_previous_utc_day():
    # 2024-03-01 00:00 IST is 2024-02-29 18:30 UTC -> inside the 29 Feb window.
    t = T("2024-03-01 00:00", tz=IST)
    bars = [{"time": _epoch(t), **_bar(0)}]
    with _strict():
        got = india_broker_loader._bars_to_frame(bars, START, END)
    assert list(got.index) == [T("2024-02-29 18:30")]


def test_india_broker_bars_nat_and_empty():
    bars = [{"time": "not-a-date", **_bar(0)}, {"time": "2024-02-29T10:00:00", **_bar(0)}]
    with _strict():
        assert india_broker_loader._bars_to_frame([], START, END) is None
        got = india_broker_loader._bars_to_frame(bars, START, END)
        assert india_broker_loader._bars_to_frame([{"time": _epoch(OLD_UPPER), **_bar(0)}], START, END) is None
    assert list(got.index) == [T("2024-02-29 10:00")]


# ── loaders/mootdx_loader.DataLoader._normalize_bars (1D - 1s, inclusive .loc) ──


def _mootdx_df(times):
    rows = [dict(datetime=t, **_bar(t)) for t in times]
    return pd.DataFrame(rows)


def test_mootdx_normalize_clip_matches_old_inclusive_end():
    old_end = T(END) + _old_td(days=1) - _old_td(seconds=1)
    assert old_end == IN_LAST
    times = [T("2024-02-27 15:00"), T(START), T("2024-02-29 15:00"), IN_LAST,
             IN_LAST + pd.Timedelta(500, "ms"), OLD_UPPER]
    with _strict():
        got = mootdx_loader.DataLoader._normalize_bars(_mootdx_df(times), START, END)
    assert list(got.index) == [T(START), T("2024-02-29 15:00"), IN_LAST]


def test_mootdx_normalize_year_end_and_index_variant():
    df = _mootdx_df([T("2023-12-31 15:00"), T("2024-01-01 00:00")]).set_index("datetime")
    with _strict():
        got = mootdx_loader.DataLoader._normalize_bars(df, "2023-12-31", "2023-12-31")
    assert list(got.index) == [T("2023-12-31 15:00")]


def test_mootdx_normalize_empty_none_and_out_of_window():
    with _strict():
        assert mootdx_loader.DataLoader._normalize_bars(None, START, END) is None
        assert mootdx_loader.DataLoader._normalize_bars(pd.DataFrame(), START, END) is None
        assert mootdx_loader.DataLoader._normalize_bars(_mootdx_df([OLD_UPPER]), START, END) is None


# ── loaders/mt5_loader._rates_to_frame ──


def _rates(times):
    return [dict(time=_epoch(t), tick_volume=3, **_bar(t)) for t in times]


def test_mt5_rates_clip_at_old_upper():
    with _strict():
        got = mt5_loader._rates_to_frame(_rates([T("2024-02-27 23:59:59"), T(START), IN_LAST, OLD_UPPER]), START, END)
    assert list(got.index) == [T(START), IN_LAST]


def test_mt5_rates_structured_array_and_empty():
    arr = np.array(
        [(_epoch(IN_LAST), 1.0, 2.0, 0.5, 1.5, 7), (_epoch(OLD_UPPER), 1.0, 2.0, 0.5, 1.5, 7)],
        dtype=[("time", "i8"), ("open", "f8"), ("high", "f8"), ("low", "f8"), ("close", "f8"), ("tick_volume", "i8")],
    )
    with _strict():
        got = mt5_loader._rates_to_frame(arr, START, END)
        assert mt5_loader._rates_to_frame(None, START, END) is None
        assert mt5_loader._rates_to_frame([], START, END) is None
        assert mt5_loader._rates_to_frame(_rates([OLD_UPPER]), START, END) is None
    assert list(got.index) == [IN_LAST]


# ── loaders/tickerall_loader._parse_candles ──


def test_tickerall_clip_at_old_upper():
    items = [dict(timestamp=_epoch(t), **_bar(t)) for t in [T("2024-02-27 23:59:59"), T(START), IN_LAST, OLD_UPPER]]
    with _strict():
        got = tickerall_loader._parse_candles({"candles": items}, START, END)
    assert list(got.index) == [T(START), IN_LAST]


def test_tickerall_ist_midnight_and_empty():
    t = T("2024-03-01 00:00", tz=IST)
    with _strict():
        got = tickerall_loader._parse_candles([dict(timestamp=_epoch(t), **_bar(0))], START, END)
        assert tickerall_loader._parse_candles([], START, END) is None
        assert tickerall_loader._parse_candles({}, START, END) is None
        assert tickerall_loader._parse_candles([dict(timestamp=_epoch(OLD_UPPER), **_bar(0))], START, END) is None
    assert list(got.index) == [T("2024-02-29 18:30")]


# ── loaders/yahoo_loader._rows_to_frame ──


def _yahoo_rows(times):
    return [dict(trade_date=_epoch(t), **_bar(t)) for t in times]


def test_yahoo_intraday_clip_at_old_upper():
    rows = _yahoo_rows([T("2024-02-27 23:59:59"), T(START), IN_LAST, OLD_UPPER])
    with _strict():
        got = yahoo_loader._rows_to_frame(rows, START, END, interval="1H")
    assert list(got.index) == [T(START), IN_LAST]


def test_yahoo_daily_normalized_clip():
    rows = _yahoo_rows([T("2024-02-29 14:30"), T("2024-03-01 14:30")])
    with _strict():
        got = yahoo_loader._rows_to_frame(rows, START, END, interval="1D")
    assert list(got.index) == [T("2024-02-29")]


def test_yahoo_tz_aware_window_and_empty():
    # A tz-aware window against the tz-naive UTC index: same outcome as the old bound.
    start, end = "2024-02-28T00:00:00+05:30", "2024-02-29T10:00:00+05:30"
    times = pd.DatetimeIndex([T("2024-02-29 18:29:59"), T("2024-02-29 18:30")])
    old_upper = T(end).normalize() + _old_td(days=1)

    def old():
        return list(times[(times >= T(start).normalize()) & (times < old_upper)])

    _same(
        lambda: list(yahoo_loader._rows_to_frame(_yahoo_rows(times), start, end, interval="1H").index),
        old,
    )
    with _strict():
        assert yahoo_loader._rows_to_frame([], START, END).empty


# ── loaders/yfinance_loader._to_yfinance_exclusive_end ──


@pytest.mark.parametrize(
    "end",
    ["2024-02-28", "2024-02-29", "2023-02-28", "2023-12-31", "1900-02-28", "2000-02-28",
     "2024-02-29T23:59:59", "2024-02-29T00:00:00+05:30", "2024-02-29T23:30:00+05:30"],
)
def test_yfinance_exclusive_end_matches_old(end):
    old = (T(end).normalize() + _old_td(days=1)).strftime("%Y-%m-%d")
    with _strict():
        assert yfinance_loader._to_yfinance_exclusive_end(end) == old


def test_yfinance_exclusive_end_exact_leap_values():
    with _strict():
        assert yfinance_loader._to_yfinance_exclusive_end("2024-02-29") == "2024-03-01"
        assert yfinance_loader._to_yfinance_exclusive_end("2023-02-28") == "2023-03-01"
        assert yfinance_loader._to_yfinance_exclusive_end("1900-02-28") == "1900-03-01"
        assert yfinance_loader._to_yfinance_exclusive_end("2023-12-31") == "2024-01-01"


def test_yfinance_exclusive_end_nat_same_as_old():
    _same(
        lambda: yfinance_loader._to_yfinance_exclusive_end("NaT"),
        lambda: (T("NaT").normalize() + _old_td(days=1)).strftime("%Y-%m-%d"),
    )


# ── loaders/rsshub_events._knowable_date ──


def _old_knowable(published, cutoff_hour):
    stamp = published.tz_localize(None) if published.tzinfo is not None else published
    base = stamp.normalize()
    if stamp.hour >= cutoff_hour:
        base = base + _old_td(days=1)
    return base


@pytest.mark.parametrize(
    "published",
    [
        T("2024-02-28 16:00"),
        T("2024-02-29 16:00"),
        T("2024-02-29 15:59:59"),
        T("2023-12-31 23:59:59"),
        T("2024-02-29 16:00", tz="UTC"),
        T("2024-02-29 23:30", tz=IST),  # = 18:00 UTC; wall time is kept
        T("2024-03-01 00:30", tz=IST),  # = 29 Feb 19:00 UTC; wall time 00:30 does not roll
        T("2024-03-10 23:00", tz="America/New_York"),  # DST change day
    ],
)
@pytest.mark.parametrize("cutoff", [0, 16, 23, 24])
def test_knowable_date_matches_old(published, cutoff):
    with _strict():
        got = rsshub_events._knowable_date(published, cutoff)
    assert got == _old_knowable(published, cutoff)
    assert got.tzinfo is None


def test_knowable_date_exact_rollovers():
    with _strict():
        assert rsshub_events._knowable_date(T("2024-02-28 16:00"), 16) == T("2024-02-29")
        assert rsshub_events._knowable_date(T("2024-02-29 16:00"), 16) == T("2024-03-01")
        assert rsshub_events._knowable_date(T("2024-02-29 15:59:59"), 16) == T("2024-02-29")
        assert rsshub_events._knowable_date(T("2023-12-31 20:00"), 16) == T("2024-01-01")
        assert rsshub_events._knowable_date(T("2024-02-29 23:30", tz=IST), 16) == T("2024-03-01")


def test_knowable_date_nat_same_as_old():
    _same(lambda: rsshub_events._knowable_date(pd.NaT, 16), lambda: _old_knowable(pd.NaT, 16))


# ── loaders/nobitex, wallex, okx: DataLoader.fetch end bound ──


def _capture_exchange(monkeypatch, module, fetch_attr):
    seen = []

    def fake_cached(*, fetch, **_kw):
        return fetch()

    def fake_one(self, session, symbol, *args, **kwargs):
        seen.append((symbol, args, kwargs))
        return pd.DataFrame({"close": [1.0]}, index=pd.DatetimeIndex([T(START)], name="trade_date"))

    monkeypatch.setattr(module, "cached_loader_fetch", fake_cached)
    monkeypatch.setattr(module.DataLoader, fetch_attr, fake_one)
    return seen


RANGES = [
    (START, END),
    ("2023-12-30", "2023-12-31"),
    ("2023-02-27", "2023-02-28"),
    ("2024-02-28T00:00:00+05:30", "2024-02-29T00:00:00+05:30"),  # tz-aware: true UTC instant
]


@pytest.mark.parametrize("start,end", RANGES)
@pytest.mark.parametrize("module", [nobitex, wallex], ids=["nobitex", "wallex"])
def test_udf_exchange_end_ts_matches_old(monkeypatch, module, start, end):
    seen = _capture_exchange(monkeypatch, module, "_fetch_one")
    with _strict():
        out = module.DataLoader().fetch(["USDT-TMN" if module is wallex else "BTC-IRT"], start, end, interval="1h")
    assert out
    (_sym, (resolution, start_ts, end_ts), _kw), = seen
    assert end_ts == int((T(end) + _old_td(days=1)).timestamp())
    assert start_ts == int(T(start).timestamp())
    assert end_ts - start_ts == 2 * 86400


@pytest.mark.parametrize("module", [nobitex, wallex], ids=["nobitex", "wallex"])
def test_udf_exchange_rejects_bad_interval_and_range(monkeypatch, module):
    seen = _capture_exchange(monkeypatch, module, "_fetch_one")
    with _strict():
        assert module.DataLoader().fetch(["X-IRT"], START, END, interval="7q") == {}
        with pytest.raises(ValueError):
            module.DataLoader().fetch(["X-IRT"], END, START)
    assert seen == []


@pytest.mark.parametrize("start,end", RANGES)
def test_okx_end_ts_ms_matches_old(monkeypatch, start, end):
    seen = _capture_exchange(monkeypatch, okx, "_fetch_candles")
    with _strict():
        out = okx.DataLoader().fetch(["BTC/USDT"], start, end, interval="1h")
    assert out
    (sym, (start_ts, end_ts, *_rest), _kw), = seen
    assert sym == "BTC-USDT"
    assert end_ts == int((T(end) + _old_td(days=1)).timestamp() * 1000)
    assert end_ts - start_ts == 2 * 86_400_000


# ── loaders/tencent_loader.DataLoader._fetch_one cursor walk ──


@pytest.mark.parametrize(
    "first,expected",
    [
        (T("2024-03-01"), "2024-02-29"),
        (T("2024-01-01"), "2023-12-31"),
        (T("2023-03-01"), "2023-02-28"),
        (T("2024-03-01 00:30"), "2024-02-29"),
    ],
)
def test_tencent_cursor_steps_back_one_day(monkeypatch, first, expected):
    old_next = (first - _old_td(days=1)).strftime("%Y-%m-%d")
    assert old_next == expected
    cursors = []

    def fake_page(self, code, start_date, cursor_end, forward_adjusted):
        cursors.append(cursor_end)
        if len(cursors) == 1:
            idx = pd.date_range(first, periods=tencent_loader._PAGE_SIZE, freq="D")
        else:
            idx = pd.date_range(end=T(cursor_end), periods=3, freq="D")
        return pd.DataFrame({"close": 1.0}, index=idx)

    monkeypatch.setattr(tencent_loader.DataLoader, "_request_page", fake_page)
    with _strict():
        df = tencent_loader.DataLoader()._fetch_one("sh600000", "2020-01-01", "2026-01-01")
    assert cursors == ["2026-01-01", old_next]
    assert df.index.is_monotonic_increasing and not df.index.duplicated().any()


def test_tencent_cursor_stops_before_start(monkeypatch):
    # first page starts on start_date's next day: next_end == start_date -> continue;
    # starting on start_date itself: next_end < start_date -> stop.
    calls = []

    def fake_page(self, code, start_date, cursor_end, forward_adjusted):
        calls.append(cursor_end)
        idx = pd.date_range("2024-02-29", periods=tencent_loader._PAGE_SIZE, freq="D")
        return pd.DataFrame({"close": 1.0}, index=idx)

    monkeypatch.setattr(tencent_loader.DataLoader, "_request_page", fake_page)
    with _strict():
        tencent_loader.DataLoader()._fetch_one("sh600000", "2024-02-29", "2026-01-01")
    assert calls == ["2026-01-01"]


def test_tencent_empty_first_page_returns_none(monkeypatch):
    monkeypatch.setattr(tencent_loader.DataLoader, "_request_page", lambda *a, **k: pd.DataFrame())
    with _strict():
        assert tencent_loader.DataLoader()._fetch_one("sh600000", START, END) is None


# ── loaders/tushare_fundamentals.enrich_price_frames_with_fundamentals (next_day) ──


def _provider(monkeypatch, rows):
    provider = tushare_fundamentals.TushareFundamentalProvider(api=object())
    monkeypatch.setattr(provider, "_query_pit_cut", lambda *a, **k: pd.DataFrame(rows))
    return provider


def _expected_visible(bars, ann):
    pit = T(ann) + _old_td(days=1)
    return [b.normalize() >= pit for b in bars]


@pytest.mark.parametrize("ann", ["20240228", "20240229", "20231231"])
def test_tushare_next_day_shift_matches_old(monkeypatch, ann):
    bars = pd.DatetimeIndex(
        ["2023-12-31 14:00", "2024-01-01 09:30", "2024-02-28 09:30", "2024-02-29 09:30",
         "2024-02-29 14:00", "2024-03-01 09:30"]
    )
    frame = pd.DataFrame({"close": range(len(bars))}, index=bars, dtype=float)
    provider = _provider(monkeypatch, {
        "ts_code": ["600000.SH"], "ann_date": [ann], "f_ann_date": [ann],
        "end_date": ["20231231"], "revenue": [42.0],
    })
    with _strict():
        out = tushare_fundamentals.enrich_price_frames_with_fundamentals(
            {"600000.SH": frame}, provider, {"balancesheet": ["revenue"]},
            as_of="2024-12-31", subdaily="next_day",
        )
    got = out["600000.SH"]["balancesheet_revenue"].notna().tolist()
    assert got == _expected_visible(bars, ann)
    pd.testing.assert_index_equal(out["600000.SH"].index, bars)


def test_tushare_daily_frame_not_shifted_and_reject_default(monkeypatch):
    daily = pd.DataFrame({"close": [1.0, 2.0]}, index=pd.DatetimeIndex(["2024-02-28", "2024-02-29"]))
    intraday = pd.DataFrame({"close": [1.0]}, index=pd.DatetimeIndex(["2024-02-29 09:30"]))
    provider = _provider(monkeypatch, {
        "ts_code": ["A"], "ann_date": ["20240229"], "f_ann_date": ["20240229"],
        "end_date": ["20231231"], "revenue": [1.0],
    })
    with _strict():
        out = tushare_fundamentals.enrich_price_frames_with_fundamentals(
            {"A": daily}, provider, {"balancesheet": ["revenue"]}, as_of="2024-12-31",
        )
        assert out["A"]["balancesheet_revenue"].notna().tolist() == [False, True]
        with pytest.raises(tushare_fundamentals.SubdailyPitError):
            tushare_fundamentals.enrich_price_frames_with_fundamentals(
                {"A": intraday}, provider, {"balancesheet": ["revenue"]}, as_of="2024-12-31",
            )


def test_tushare_empty_inputs(monkeypatch):
    provider = _provider(monkeypatch, {"ts_code": [], "ann_date": [], "f_ann_date": [], "end_date": [], "revenue": []})
    empty = pd.DataFrame({"close": []}, index=pd.DatetimeIndex([]))
    with _strict():
        assert tushare_fundamentals.enrich_price_frames_with_fundamentals(
            {}, provider, {"balancesheet": ["revenue"]}, as_of="2024-12-31", subdaily="next_day") == {}
        out = tushare_fundamentals.enrich_price_frames_with_fundamentals(
            {"A": empty}, provider, {"balancesheet": ["revenue"]}, as_of="2024-12-31", subdaily="next_day")
    assert out["A"].empty
