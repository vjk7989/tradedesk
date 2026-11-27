"""TM2-41 (P3-A): loader datetime units are pinned to ns under the installed pandas.

Owner policy: normalise to ns at the loader boundary so pandas 2.3 and 3.x behave the
same (the engine compares int64 ns epochs). Every expected value here is computed with
the standard library (datetime/zoneinfo), not pandas, so a unit change cannot hide a
value change.

Run under pandas 3 with:
    uv run --with "pandas>=3,<4" python -m pytest -q tests/test_tm2_41_units.py
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from vibe_bt.backtest.loaders import ccxt_loader, local_loader
from vibe_bt.backtest.loaders.base import RESAMPLED_INTERVALS, resample_bars

UTC = timezone.utc
NS_PER_S = 10**9
INPUT_UNITS = ["s", "ms", "us", "ns"]


def _epoch_ns(dt: datetime) -> int:
    """Exact ns epoch of an aware datetime (stdlib only, no float rounding)."""
    delta = dt - datetime(1970, 1, 1, tzinfo=UTC)
    return (delta.days * 86400 + delta.seconds) * NS_PER_S + delta.microseconds * 1000


def _naive_epoch_ns(dt: datetime) -> int:
    """ns epoch of a naive wall-clock datetime (pandas treats naive as UTC wall)."""
    return _epoch_ns(dt.replace(tzinfo=UTC))


def _assert_ns(index: pd.Index, tz=None) -> None:
    assert isinstance(index, pd.DatetimeIndex)
    assert index.unit == "ns"
    if tz is None:
        assert index.tz is None
        assert index.dtype == "datetime64[ns]"
    else:
        assert str(index.tz) == str(tz)
        assert index.dtype == pd.DatetimeTZDtype(unit="ns", tz=tz)
        assert str(index.dtype) == f"datetime64[ns, {tz}]"


# ── ccxt_loader._TIMEFRAME_DELTA ─────────────────────────────────────────────

_EXPECTED_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400,
    "1d": 86400, "1w": 7 * 86400, "1M": 31 * 86400,
}


def test_timeframe_delta_keys_unchanged():
    assert set(ccxt_loader._TIMEFRAME_DELTA) == set(_EXPECTED_SECONDS)


@pytest.mark.parametrize("key", sorted(_EXPECTED_SECONDS))
def test_timeframe_delta_is_ns_and_value_unchanged(key):
    delta = ccxt_loader._TIMEFRAME_DELTA[key]
    assert isinstance(delta, pd.Timedelta)
    assert delta.unit == "ns"
    assert delta.value == _EXPECTED_SECONDS[key] * NS_PER_S
    assert delta.to_pytimedelta() == timedelta(seconds=_EXPECTED_SECONDS[key])
    # Arithmetic with an ns stamp stays ns (no silent unit change downstream).
    stamp = pd.Timestamp("2024-01-01").as_unit("ns")
    moved = stamp + delta
    assert moved.unit == "ns"
    assert moved.value == stamp.value + _EXPECTED_SECONDS[key] * NS_PER_S


def test_every_timeframe_delta_is_ns():
    units = {k: v.unit for k, v in ccxt_loader._TIMEFRAME_DELTA.items()}
    assert set(units.values()) == {"ns"}, units


# ── base.resample_bars ───────────────────────────────────────────────────────

_DAYS = [date(2024, 1, 1) + timedelta(days=i) for i in range(75)]  # Mon 1 Jan .. 15 Mar
_TRADING = [d for d in _DAYS if d.weekday() < 5]


def _period_key(d: date, interval: str):
    if interval == "1W":  # W-SUN: Monday..Sunday, i.e. the ISO week
        iso = d.isocalendar()
        return (iso[0], iso[1])
    assert interval == "1M"
    return (d.year, d.month)


def _expected_stamps(days: list[date], interval: str, tz: str | None) -> list[int]:
    """Last trading day of each period, as ns epochs (stdlib only)."""
    groups: dict = defaultdict(list)
    for d in days:
        groups[_period_key(d, interval)].append(d)
    out = []
    for key in sorted(groups):
        last = max(groups[key])
        wall = datetime(last.year, last.month, last.day)
        out.append(_epoch_ns(wall.replace(tzinfo=ZoneInfo(tz))) if tz else _naive_epoch_ns(wall))
    return out


def _expected_closes(days: list[date], closes: list[float], interval: str) -> list[float]:
    groups: dict = defaultdict(list)
    for d, c in zip(days, closes):
        groups[_period_key(d, interval)].append((d, c))
    return [max(groups[k])[1] for k in sorted(groups)]


def _daily_frame(days, unit: str, tz: str | None, *, nat_at: int | None = None) -> pd.DataFrame:
    stamps: list = [pd.Timestamp(d.isoformat()) for d in days]
    if nat_at is not None:
        stamps.insert(nat_at, pd.NaT)
    index = pd.DatetimeIndex(stamps, name="trade_date").as_unit(unit)
    if tz:
        index = index.tz_localize(tz)
    n = len(index)
    closes = [100.0 + i for i in range(n)]
    frame = pd.DataFrame(
        {
            "open": [c - 0.5 for c in closes],
            "high": [c + 1.0 for c in closes],
            "low": [c - 1.0 for c in closes],
            "close": closes,
            "volume": [1000.0] * n,
        },
        index=index,
    )
    frame.attrs["quote_currency"] = "USD"
    return frame


@pytest.mark.parametrize("interval", sorted(RESAMPLED_INTERVALS))
@pytest.mark.parametrize("unit", INPUT_UNITS)
def test_resample_bars_naive_output_is_ns_and_values_unchanged(interval, unit):
    frame = _daily_frame(_TRADING, unit, None)
    out = resample_bars(frame, interval)
    _assert_ns(out.index)
    assert out.index.name == "trade_date"
    assert list(out.index.asi8) == _expected_stamps(_TRADING, interval, None)
    assert list(out["close"]) == _expected_closes(_TRADING, list(frame["close"]), interval)
    assert out.attrs == {"quote_currency": "USD"}


@pytest.mark.parametrize("tz", ["UTC", "Asia/Kolkata", "America/New_York"])
@pytest.mark.parametrize("interval", sorted(RESAMPLED_INTERVALS))
@pytest.mark.parametrize("unit", INPUT_UNITS)
def test_resample_bars_tz_aware_output_is_ns_tz_preserved_values_unchanged(tz, interval, unit):
    frame = _daily_frame(_TRADING, unit, tz)
    out = resample_bars(frame, interval)
    _assert_ns(out.index, tz)
    assert list(out.index.asi8) == _expected_stamps(_TRADING, interval, tz)
    assert list(out["close"]) == _expected_closes(_TRADING, list(frame["close"]), interval)


@pytest.mark.parametrize("tz", [None, "Asia/Kolkata"])
@pytest.mark.parametrize("interval", sorted(RESAMPLED_INTERVALS))
@pytest.mark.parametrize("unit", ["us", "ns"])
def test_resample_bars_drops_nat_row_and_output_is_ns(tz, interval, unit):
    frame = _daily_frame(_TRADING, unit, tz, nat_at=7)
    assert frame.index.isna().sum() == 1
    out = resample_bars(frame, interval)
    _assert_ns(out.index, tz)
    assert not out.index.isna().any()
    assert list(out.index.asi8) == _expected_stamps(_TRADING, interval, tz)
    # The NaT row's close is excluded from every period.
    real_closes = [c for i, c in enumerate(frame["close"]) if i != 7]
    assert list(out["close"]) == _expected_closes(_TRADING, real_closes, interval)


@pytest.mark.parametrize("tz", [None, "Asia/Kolkata"])
@pytest.mark.parametrize("interval", sorted(RESAMPLED_INTERVALS))
def test_resample_bars_empty_ns_frame_stays_empty_ns(tz, interval):
    frame = _daily_frame(_TRADING, "ns", tz).iloc[:0]
    out = resample_bars(frame, interval)
    assert out.empty
    _assert_ns(out.index, tz)


@pytest.mark.xfail(
    strict=True,
    reason="TM2-41 gap: resample_bars returns an empty frame unchanged (early return before "
           "the ns pin), so a non-ns empty input keeps its unit. Loaders never pass one today.",
)
def test_resample_bars_empty_non_ns_frame_is_pinned_to_ns():
    frame = _daily_frame(_TRADING, "us", None).iloc[:0]
    _assert_ns(resample_bars(frame, "1W").index)


# ── local_loader: _resample_to_interval and full fetch ───────────────────────

def _minute_frame(start: datetime, minutes: int, unit: str) -> pd.DataFrame:
    stamps = [pd.Timestamp(start + timedelta(minutes=i)) for i in range(minutes)]
    index = pd.DatetimeIndex(stamps, name="trade_date").as_unit(unit)
    closes = [float(i) for i in range(minutes)]
    return pd.DataFrame(
        {"open": closes, "high": [c + 1 for c in closes], "low": [c - 1 for c in closes],
         "close": closes, "volume": [1.0] * minutes},
        index=index,
    )


@pytest.mark.parametrize("unit", INPUT_UNITS)
@pytest.mark.parametrize("interval,step", [("5m", 5), ("15m", 15), ("1h", 60)])
def test_resample_to_interval_output_is_ns_and_values_unchanged(unit, interval, step):
    start = datetime(2024, 3, 4, 0, 0)
    frame = _minute_frame(start, 180, unit)
    out = local_loader._resample_to_interval(frame, interval, "BTCUSDT")
    _assert_ns(out.index)
    assert out.index.name == "trade_date"
    expected = [_naive_epoch_ns(start + timedelta(minutes=m)) for m in range(0, 180, step)]
    assert list(out.index.asi8) == expected
    assert list(out["close"]) == [float(m + step - 1) for m in range(0, 180, step)]
    assert list(out["volume"]) == [float(step)] * (180 // step)


def _write_config(tmp_path, monkeypatch, entries: list[tuple[str, str]]) -> None:
    lines = ["sources:"]
    for symbol, path in entries:
        lines += [f'  - symbol: "{symbol}"', "    type: csv", f'    path: "{path}"']
    cfg = tmp_path / "config.yaml"
    cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    # _CONFIG_PATH is read from the env at import time; point it at this config.
    monkeypatch.setattr(local_loader, "_CONFIG_PATH", cfg)
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")


def _csv(tmp_path, name: str, stamps: list[str]) -> str:
    rows = ["date,open,high,low,close,volume"]
    for i, s in enumerate(stamps):
        rows.append(f"{s},{10 + i},{11 + i},{9 + i},{10.5 + i},{100 + i}")
    path = tmp_path / name
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return path.as_posix()


_NAIVE_DAILY = ["2024-01-02", "2024-01-03", "not-a-date", "2024-01-04", "2024-01-05"]
_AWARE_INTRADAY = [
    "2024-01-02T09:15:00+05:30", "2024-01-02T09:20:00+05:30", "",
    "2024-01-02T09:25:00+05:30", "2024-01-02T09:30:00+05:30",
]


def test_local_fetch_naive_daily_with_bad_date_is_ns_and_values_unchanged(tmp_path, monkeypatch):
    _write_config(tmp_path, monkeypatch, [("AAPL", _csv(tmp_path, "a.csv", _NAIVE_DAILY))])
    out = local_loader.DataLoader().fetch(["AAPL"], "2024-01-01", "2024-01-31", interval="1D")
    frame = out["AAPL"]
    _assert_ns(frame.index)
    good = [s for s in _NAIVE_DAILY if s != "not-a-date"]
    assert list(frame.index.asi8) == [_naive_epoch_ns(datetime.fromisoformat(s)) for s in good]
    assert list(frame["close"]) == [10.5, 11.5, 13.5, 14.5]  # the unparseable row is dropped


@pytest.mark.parametrize("symbol,wall_tz", [("BTCUSDT", "UTC"), ("RELIANCE.NS", "Asia/Kolkata")])
def test_local_fetch_tz_aware_with_nat_is_ns_wall_clock_and_values_unchanged(
    tmp_path, monkeypatch, symbol, wall_tz
):
    _write_config(tmp_path, monkeypatch, [(symbol, _csv(tmp_path, "b.csv", _AWARE_INTRADAY))])
    out = local_loader.DataLoader().fetch([symbol], "2024-01-01", "2024-01-31", interval="5m")
    frame = out[symbol]
    # tz-aware input becomes a naive wall clock in the market tz, pinned to ns.
    _assert_ns(frame.index)
    good = [s for s in _AWARE_INTRADAY if s]
    expected = [
        _naive_epoch_ns(
            datetime.fromisoformat(s).astimezone(ZoneInfo(wall_tz)).replace(tzinfo=None)
        )
        for s in good
    ]
    assert list(frame.index.asi8) == expected
    assert list(frame["close"]) == [10.5, 11.5, 13.5, 14.5]


def test_local_fetch_resampled_interval_is_ns(tmp_path, monkeypatch):
    stamps = [f"2024-03-04 {h:02d}:{m:02d}:00" for h in range(0, 2) for m in range(60)]
    _write_config(tmp_path, monkeypatch, [("BTCUSDT", _csv(tmp_path, "c.csv", stamps))])
    out = local_loader.DataLoader().fetch(["BTCUSDT"], "2024-03-04", "2024-03-04", interval="15m")
    frame = out["BTCUSDT"]
    _assert_ns(frame.index)
    start = datetime(2024, 3, 4)
    assert list(frame.index.asi8) == [
        _naive_epoch_ns(start + timedelta(minutes=m)) for m in range(0, 120, 15)
    ]


@pytest.mark.parametrize("timestamp_basis", ["utc", "session_date"])
def test_normalize_columns_index_is_ns(tmp_path, timestamp_basis):
    path = _csv(tmp_path, "d.csv", _NAIVE_DAILY)
    frame = local_loader._read_csv(path, dict(local_loader._DEFAULT_COLUMNS), None,
                                   timestamp_basis, "UTC")
    _assert_ns(frame.index)
    good = [s for s in _NAIVE_DAILY if s != "not-a-date"]
    assert list(frame.index.asi8) == [_naive_epoch_ns(datetime.fromisoformat(s)) for s in good]


def test_normalize_columns_empty_csv_index_is_ns(tmp_path):
    path = _csv(tmp_path, "e.csv", [])
    frame = local_loader._read_csv(path, dict(local_loader._DEFAULT_COLUMNS), None, "utc", "UTC")
    assert frame is not None and frame.empty
    _assert_ns(frame.index)


def test_normalize_columns_all_nat_csv_index_is_ns(tmp_path):
    path = _csv(tmp_path, "f.csv", ["", "garbage"])
    frame = local_loader._read_csv(path, dict(local_loader._DEFAULT_COLUMNS), None, "utc", "UTC")
    assert frame is not None and frame.empty
    _assert_ns(frame.index)
