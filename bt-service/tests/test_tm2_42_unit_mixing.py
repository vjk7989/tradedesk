"""TM2-42 (P3-B): us- and ns-unit calendars behave identically in engines/base.py.

``evaluation_start_index`` and ``_align`` compare int64 epochs. ``asi8`` and
``view("i8")`` count in the index's own unit, so a ``datetime64[us]`` calendar
(pandas 3's native unit, and what a duckdb-backed source yields) read as if it
were ns would land in 1970 and, next to an ns source, match none of its bars.
Both functions now take ``.as_unit("ns").asi8``. These tests hold the result
fixed across units, timezones, boundary placements, mixed-unit panels, NaT and
one end-to-end CryptoEngine run, on pandas 2.3 and 3.x alike.

The expected positions are computed independently (``sum(dates < boundary)``
over plain Timestamps), never through the int64 path under test.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.engines.base import _align, evaluation_start_index
from vibe_bt.backtest.engines.crypto import CryptoEngine
from vibe_bt.backtest.loaders import local_loader

UNITS = ("ns", "us")
TZS = (None, "Asia/Kolkata", "UTC")
FIX = Path(__file__).parent / "fixtures" / "btc_1d.csv"


# ─── helpers ───


def _calendar(tz, unit, *, intraday=False):
    """Ten bars; daily at midnight, or 09:15 + 5-minute bars when intraday."""
    if intraday:
        stamps = pd.date_range("2024-01-03 09:15", periods=10, freq="5min")
    else:
        stamps = pd.date_range("2024-01-01", periods=10, freq="D")
    idx = pd.DatetimeIndex(stamps)
    if tz is not None:
        idx = idx.tz_localize(tz)
    return idx.as_unit(unit)


def _expected_start(boundary: str, dates: pd.DatetimeIndex) -> int:
    ts = pd.Timestamp(boundary)
    if ts.tz is None and dates.tz is not None:
        ts = ts.tz_localize(dates.tz)
    elif ts.tz is not None and dates.tz is None:
        ts = ts.tz_localize(None)
    return sum(1 for d in dates if d < ts)


def _start_or_error(boundary, dates):
    try:
        return evaluation_start_index({"evaluation_start_date": boundary}, dates)
    except ValueError as exc:
        return ("ValueError", str(exc))


def _frame(index, seed):
    rng = np.random.default_rng(seed)
    close = 100.0 + np.cumsum(rng.normal(0, 1, len(index)))
    return pd.DataFrame(
        {"open": close, "high": close + 1, "low": close - 1, "close": close, "volume": 1.0},
        index=index,
    )


def _signal(index, seed):
    rng = np.random.default_rng(seed + 100)
    return pd.Series(rng.choice([-1.0, 0.0, 0.5, 1.0], len(index)), index=index)


def _assert_align_equal(got, want):
    g_dates, *g_frames = got
    w_dates, *w_frames = want
    pd.testing.assert_index_equal(g_dates, w_dates)
    assert g_dates.unit == "ns"
    for g, w in zip(g_frames, w_frames):
        pd.testing.assert_frame_equal(g, w)


# ─── evaluation_start_index ───


# Daily calendar 2024-01-01 .. 2024-01-10 (midnight bars).
DAILY_BOUNDARIES = [
    "2023-12-01",            # before the range -> 0
    "2024-01-01",            # exactly on the first bar -> 0
    "2024-01-04",            # exactly on a bar inside -> 3
    "2024-01-04 12:00",      # between bars -> 4
    "2024-01-09",            # exactly on the second-to-last bar -> 8 (two bars left)
]
# 5-minute calendar 2024-01-03 09:15 .. 10:00 (wall clock of the calendar's tz).
INTRADAY_BOUNDARIES = [
    "2024-01-03",            # midnight, before the first bar -> 0
    "2024-01-03 09:15",      # exactly on the first bar -> 0
    "2024-01-03 09:30",      # exactly on a bar -> 3
    "2024-01-03 09:32:30",   # between bars -> 4
    "2024-01-03 09:55",      # exactly on the second-to-last bar -> 8 (two bars left)
]


@pytest.mark.parametrize("tz", TZS)
@pytest.mark.parametrize("intraday,boundary", (
    [(False, b) for b in DAILY_BOUNDARIES] + [(True, b) for b in INTRADAY_BOUNDARIES]
))
def test_evaluation_start_index_same_position_for_us_and_ns(tz, intraday, boundary):
    results = {}
    for unit in UNITS:
        dates = _calendar(tz, unit, intraday=intraday)
        assert dates.unit == unit
        results[unit] = evaluation_start_index({"evaluation_start_date": boundary}, dates)
        assert results[unit] == _expected_start(boundary, dates)
    assert results["us"] == results["ns"]


@pytest.mark.parametrize("tz", TZS)
def test_evaluation_start_index_on_bar_lands_on_that_bar(tz):
    for unit in UNITS:
        dates = _calendar(tz, unit)
        start = evaluation_start_index({"evaluation_start_date": "2024-01-05"}, dates)
        assert start == 4
        assert dates[start].strftime("%Y-%m-%d %H:%M") == "2024-01-05 00:00"


@pytest.mark.parametrize("tz", TZS)
@pytest.mark.parametrize("boundary", ["2024-01-10", "2024-01-10 00:00:01", "2024-02-01"])
def test_evaluation_start_index_late_boundary_same_error_for_us_and_ns(tz, boundary):
    """On the last bar leaves one bar; after the range leaves none. Same error either unit."""
    errors = {}
    for unit in UNITS:
        with pytest.raises(ValueError) as exc:
            evaluation_start_index({"evaluation_start_date": boundary}, _calendar(tz, unit))
        errors[unit] = str(exc.value)
    assert errors["us"] == errors["ns"]
    if boundary == "2024-01-10":
        assert "evaluation window would hold 1 bar(s) of 10" in errors["ns"]
    else:
        assert "is after the last loaded bar (2024-01-10)" in errors["ns"]


@pytest.mark.parametrize("unit", UNITS)
def test_evaluation_start_index_tz_aware_boundary_on_naive_calendar(unit):
    """A tz-aware boundary on a naive calendar keeps its wall clock, in either unit."""
    dates = _calendar(None, unit)
    assert evaluation_start_index(
        {"evaluation_start_date": "2024-01-04T00:00:00+05:30"}, dates
    ) == 3


@pytest.mark.parametrize("unit", UNITS)
def test_evaluation_start_index_us_calendar_is_not_read_as_1970(unit):
    """The bug shape: a us epoch read as ns sits in 1970, so every 2024 boundary is 'after'."""
    dates = _calendar("UTC", unit)
    # A 1970-epoch misread would put the whole calendar before 2023 and raise.
    assert evaluation_start_index({"evaluation_start_date": "2023-06-01"}, dates) == 0
    assert evaluation_start_index({"evaluation_start_date": "2024-01-03"}, dates) == 2


# ─── _align (engine path at base.py:298) ───


def _panels(tz, units, *, same_calendar):
    """Two symbols; B is a shifted calendar (searchsorted path) unless same_calendar."""
    a_idx = _calendar(tz, "ns")
    if same_calendar:
        b_idx = a_idx
    else:
        # 2024-01-03 12:00 .. 2024-01-10 12:00 (half-day offset), plus 2024-01-11.
        b_stamps = [f"2024-01-{d:02d} 12:00" for d in range(3, 11)] + ["2024-01-11 00:00"]
        b_idx = pd.DatetimeIndex(pd.to_datetime(b_stamps))
        if tz is not None:
            b_idx = b_idx.tz_localize(tz)
    data, sig = {}, {}
    for (code, idx, seed), unit in zip((("AAA", a_idx, 1), ("BBB", b_idx, 2)), units):
        idx = idx.as_unit(unit)
        data[code] = _frame(idx, seed)
        sig[code] = _signal(idx, seed)
    return data, sig


def _run_align(data, sig):
    return _align(data, sig, sorted(data))


@pytest.mark.parametrize("tz", TZS)
@pytest.mark.parametrize("same_calendar", [True, False])
@pytest.mark.parametrize("units", [("us", "us"), ("us", "ns"), ("ns", "us")])
def test_align_unit_mix_matches_all_ns(tz, same_calendar, units):
    want = _run_align(*_panels(tz, ("ns", "ns"), same_calendar=same_calendar))
    got = _run_align(*_panels(tz, units, same_calendar=same_calendar))
    _assert_align_equal(got, want)
    # Sanity: the merged calendar is the real 2024 one, not 1970.
    assert got[0][0].year == 2024
    expected_len = 10 if same_calendar else 10 + 9
    assert len(got[0]) == expected_len


@pytest.mark.parametrize("tz", TZS)
def test_align_signal_unit_differs_from_frame_unit(tz):
    """us frames with ns signals (and vice versa) align like the all-ns case."""
    want = _run_align(*_panels(tz, ("ns", "ns"), same_calendar=False))
    for frame_unit, sig_unit in (("us", "ns"), ("ns", "us")):
        data, sig = _panels(tz, (frame_unit, frame_unit), same_calendar=False)
        sig = {c: s.set_axis(s.index.as_unit(sig_unit)) for c, s in sig.items()}
        _assert_align_equal(_run_align(data, sig), want)


@pytest.mark.parametrize("tz", TZS)
def test_align_then_evaluation_start_same_for_mixed_units(tz):
    """The engine's order: _align builds the calendar, evaluation_start_index cuts it."""
    for boundary in ("2023-12-31", "2024-01-03", "2024-01-03 06:00", "2024-01-05 12:00"):
        starts = set()
        for units in (("ns", "ns"), ("us", "us"), ("us", "ns"), ("ns", "us")):
            dates = _run_align(*_panels(tz, units, same_calendar=False))[0]
            starts.add(evaluation_start_index({"evaluation_start_date": boundary}, dates))
        assert len(starts) == 1, (boundary, starts)
        assert starts.pop() == _expected_start(boundary, dates)


# ─── NaT in the calendar ───


def _nat_calendar(unit, where):
    stamps = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"]
    pos = {"lead": 0, "mid": 2, "tail": 4}[where]
    stamps = stamps[:pos] + [None] + stamps[pos:]
    return pd.DatetimeIndex(pd.to_datetime(stamps)).as_unit(unit)


@pytest.mark.parametrize("where", ["lead", "mid", "tail"])
@pytest.mark.parametrize("boundary", ["2023-12-01", "2024-01-02", "2024-01-02 12:00"])
def test_evaluation_start_index_nat_calendar_same_for_us_and_ns(where, boundary):
    """The engine accepts a NaT bar (no error); us and ns give the same index."""
    got = {u: _start_or_error(boundary, _nat_calendar(u, where)) for u in UNITS}
    assert got["us"] == got["ns"]
    assert isinstance(got["ns"], int)


def test_evaluation_start_index_leading_nat_pinned():
    """``_align`` sorts NaT first (iNaT is the smallest int64), so a leading NaT is
    the shape the engine actually produces. On the int64 path NaT sorts before every
    boundary, so it is never inside the evaluation window. Pinned for both units.

    Note: main's ``np.searchsorted(dates.values, ...)`` ordered NaT *last* (numpy's
    datetime64 order), which returned 0 for a pre-range boundary here.
    """
    for unit in UNITS:
        dates = _nat_calendar(unit, "lead")
        assert evaluation_start_index({"evaluation_start_date": "2023-12-01"}, dates) == 1
        assert evaluation_start_index({"evaluation_start_date": "2024-01-02"}, dates) == 2
        assert evaluation_start_index({"evaluation_start_date": "2024-01-02 12:00"}, dates) == 3


def test_align_nat_bar_same_for_us_and_ns():
    """A NaT bar in one symbol's frame is accepted and placed identically in either unit."""
    def build(unit):
        idx = pd.DatetimeIndex(pd.to_datetime(["2024-01-01", None, "2024-01-03"])).as_unit(unit)
        other = pd.DatetimeIndex(pd.to_datetime(["2024-01-01", "2024-01-02", "2024-01-03"]))
        other = other.as_unit(unit)
        data = {"AAA": _frame(idx, 1), "BBB": _frame(other, 2)}
        sig = {"AAA": _signal(idx, 1), "BBB": _signal(other, 2)}
        return _run_align(data, sig)

    want = build("ns")
    _assert_align_equal(build("us"), want)
    assert pd.isna(want[0][0])
    assert list(want[0][1:].strftime("%Y-%m-%d")) == ["2024-01-01", "2024-01-02", "2024-01-03"]


# ─── end to end: CryptoEngine on a real fixture, loader output cast to us vs ns ───


class _SmaSignals:
    def generate(self, data_map):
        out = {}
        for c, df in data_map.items():
            fast = df["close"].rolling(10).mean()
            slow = df["close"].rolling(30).mean()
            out[c] = (fast > slow).astype(float)
        return out


class _UnitLoader:
    """The real local CSV loader, with every frame's index cast to ``unit``."""

    def __init__(self, unit, tz=None):
        self.inner = local_loader.DataLoader()
        self.unit = unit
        self.tz = tz

    def fetch(self, codes, start, end, fields=None, interval="1D"):
        out = self.inner.fetch(codes, start, end, interval=interval, fields=fields)
        cast = {}
        for code, df in out.items():
            idx = df.index
            if self.tz is not None:
                idx = idx.tz_localize(self.tz) if idx.tz is None else idx.tz_convert(self.tz)
            cast[code] = df.set_axis(idx.as_unit(self.unit))
        return cast


@pytest.fixture
def local_btc(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        '  - symbol: "BTC-USDT"\n'
        "    type: csv\n"
        f'    path: "{FIX.as_posix()}"\n'
        '    date_format: "%Y-%m-%d"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(local_loader, "_CONFIG_PATH", cfg)
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    return tmp_path


def _e2e(tmp_path, unit, tz):
    config = {
        "codes": ["BTC-USDT"], "interval": "1D",
        "start_date": "2024-01-01", "end_date": "2024-08-01",
        "evaluation_start_date": "2024-03-01",
        "initial_cash": 100_000.0,
    }
    run_dir = tmp_path / f"run_{unit}_{tz or 'naive'}".replace("/", "_")
    run_dir.mkdir()
    eng = CryptoEngine(dict(config))
    loader = _UnitLoader(unit, tz)
    assert loader.fetch(["BTC-USDT"], "2024-01-01", "2024-08-01")["BTC-USDT"].index.unit == unit
    metrics = eng.run_backtest(config, loader, _SmaSignals(), run_dir, 365)
    equity = [(s.timestamp, s.capital, s.unrealized, s.equity, s.positions)
              for s in eng.equity_snapshots]
    trades = [repr(t) for t in eng.trades]
    return metrics, equity, trades, run_dir


def _artifact_text(run_dir, name):
    path = run_dir / "artifacts" / name
    return path.read_text(encoding="utf-8") if path.is_file() else None


@pytest.mark.parametrize("tz", [None, "UTC", "Asia/Kolkata"])
def test_end_to_end_us_loader_output_matches_ns(local_btc, tz):
    m_ns, eq_ns, tr_ns, dir_ns = _e2e(local_btc, "ns", tz)
    m_us, eq_us, tr_us, dir_us = _e2e(local_btc, "us", tz)

    assert tr_ns, "the SMA crossover should trade on the fixture"
    assert eq_ns, "equity snapshots expected"
    assert tr_us == tr_ns
    assert eq_us == eq_ns

    volatile = {"trace_started_at", "run_dir", "trace_id", "elapsed_s", "started_at"}
    def stable(m):
        return {k: v for k, v in (m or {}).items() if k not in volatile}
    assert stable(m_us).keys() == stable(m_ns).keys()
    for k, v in stable(m_ns).items():
        w = stable(m_us)[k]
        if isinstance(v, float) and np.isnan(v):
            assert isinstance(w, float) and np.isnan(w), k
        else:
            assert w == v, k

    for name in ("equity.csv", "trades.csv"):
        assert _artifact_text(dir_us, name) == _artifact_text(dir_ns, name), name

    # The evaluation boundary cut the warm-up in both runs: nothing before 2024-03-01.
    first = pd.Timestamp(eq_ns[0][0])
    if first.tz is not None:
        first = first.tz_localize(None)
    assert first >= pd.Timestamp("2024-03-01")
    assert pd.Timestamp(eq_us[0][0]) == pd.Timestamp(eq_ns[0][0])
