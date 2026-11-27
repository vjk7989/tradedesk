"""TM-15 edge tests (independent test writer).

Covers the two value-identical replacements:
- local_loader._resample_to_interval: ``target = pd.Timedelta(to_offset(rule).nanos, unit="ns")``
- IndiaOptionsEngine._upto_expiry: ``pd.Timedelta(1, unit="D")``
"""
import logging
import re
import subprocess
import sys
import warnings
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from vibe_bt.backtest.loaders import local_loader
from vibe_bt.backtest.loaders.local_loader import _RESAMPLE_RULES, _resample_to_interval

FIXTURES = Path(__file__).parent / "fixtures"
GENERIC_MSG = "'generic' unit for NumPy timedelta"
ALL_INTERVALS = list(_RESAMPLE_RULES)


def _rule_seconds(rule: str) -> int:
    """Parse '3min' / '1h' / '1D' by hand (no pandas) into seconds."""
    m = re.fullmatch(r"(\d+)(min|h|D)", rule)
    assert m, f"unexpected rule alias {rule!r}"
    n, unit = int(m.group(1)), m.group(2)
    return n * {"min": 60, "h": 3600, "D": 86400}[unit]


def _resample_strict(df, interval, symbol="EDGE", anchor=None):
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        warnings.simplefilter("error", FutureWarning)
        return _resample_to_interval(df, interval, symbol, anchor)


# ── target Timedelta: value and unit ────────────────────────────────────────

@pytest.mark.parametrize("interval", ALL_INTERVALS)
def test_target_equals_old_timedelta_value_and_ns_unit(interval):
    from pandas.tseries.frequencies import to_offset

    rule = _RESAMPLE_RULES[interval]
    secs = _rule_seconds(rule)
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        new = pd.Timedelta(to_offset(rule).nanos, unit="ns")
    independent = pd.Timedelta(secs * 10**9, unit="ns")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        old = pd.Timedelta(rule)  # the pre-fix expression (warns on this pandas)
    assert new == independent == old
    assert new.value == old.value == secs * 10**9
    # TM2-41 policy: the loader's target is ns. pd.Timedelta(rule) is ns on pandas 2.x
    # but us on pandas 3, so the old side is compared at ns (value already checked).
    assert new.unit == "ns"
    assert old.as_unit("ns") == new and old.as_unit("ns").unit == "ns"
    assert new.total_seconds() == secs
    # source loader code is actually using this expression
    import inspect
    src = inspect.getsource(local_loader._resample_to_interval)
    assert 'target = pd.Timedelta(to_offset(rule).nanos, unit="ns")' in src
    assert "target = pd.Timedelta(rule)" not in src


# ── frame builders ───────────────────────────────────────────────────────────

def _ohlcv(idx: pd.DatetimeIndex) -> pd.DataFrame:
    n = len(idx)
    base = pd.Series([100.0 + (i * 7 % 13) + i * 0.01 for i in range(n)], index=idx)
    return pd.DataFrame(
        {
            "open": base,
            "high": base + 2.0,
            "low": base - 2.0,
            "close": base + 0.5,
            "volume": pd.Series([(i % 5) + 1 for i in range(n)], index=idx, dtype="int64"),
        },
        index=idx,
    )


def _irregular_minute_index(tz=None) -> pd.DatetimeIndex:
    """1-minute bars with intraday gaps, an overnight gap and a weekend gap (Fri -> Mon)."""
    parts = [
        pd.date_range("2025-04-03 09:15", "2025-04-03 15:29", freq="min"),  # Thu
        pd.date_range("2025-04-04 09:15", "2025-04-04 11:02", freq="min"),  # Fri morning
        pd.date_range("2025-04-04 11:40", "2025-04-04 15:29", freq="min"),  # Fri after a hole
        pd.date_range("2025-04-07 09:15", "2025-04-07 12:00", freq="min"),  # Mon after weekend
    ]
    idx = parts[0].append(parts[1:])
    # a few isolated missing bars
    idx = idx.delete([3, 4, 50, 300])
    idx = pd.DatetimeIndex(idx, name="ts")
    if tz is not None:
        idx = idx.tz_localize(tz)
    return idx


def _expected(df: pd.DataFrame, interval: str, anchor_naive: pd.Timestamp | None) -> pd.DataFrame:
    """Independent expectation: bin start computed arithmetically, then groupby."""
    rule = _RESAMPLE_RULES[interval]
    secs = _rule_seconds(rule)
    step = pd.Timedelta(secs * 10**9, unit="ns")
    if rule in local_loader._SESSION_ANCHORED_RULES:
        if anchor_naive is not None:
            origin = anchor_naive if df.index.tz is None else anchor_naive.tz_localize(df.index.tz)
        else:
            first = df.index[0]
            origin = df.index[df.index.normalize() == first.normalize()].min()
    else:
        # pandas default origin="start_day": midnight of the first day (local wall clock)
        origin = df.index[0].normalize()
    k = (df.index - origin) // step
    starts = pd.DatetimeIndex([origin + int(x) * step for x in k], name=df.index.name)
    exp = df.groupby(starts).agg(
        open=("open", "first"), high=("high", "max"), low=("low", "min"),
        close=("close", "last"), volume=("volume", "sum"),
    )
    exp.index.name = df.index.name
    return exp


def _cmp(out: pd.DataFrame, exp: pd.DataFrame):
    pd.testing.assert_frame_equal(out, exp, check_freq=False)


# ── resampling on irregular data ─────────────────────────────────────────────

@pytest.mark.parametrize("tz", [None, "Asia/Kolkata", "UTC"])
@pytest.mark.parametrize("interval", ALL_INTERVALS)
def test_resample_irregular_gaps(interval, tz):
    df = _ohlcv(_irregular_minute_index(tz))
    anchor = pd.Timestamp("2000-01-03 09:15") if tz is None else None
    out = _resample_strict(df, interval, anchor=anchor)
    if _rule_seconds(_RESAMPLE_RULES[interval]) == 60:
        # median diff is 1 minute despite the gaps -> pass-through, same object
        assert out is df
        return
    exp = _expected(df, interval, anchor)
    _cmp(out, exp)
    assert out.index.tz == df.index.tz
    assert out.index.name == "ts"
    assert list(out.dtypes) == list(df.dtypes)
    assert out.index.is_monotonic_increasing
    # no bins for the weekend / gaps (dropna on OHLC)
    assert not out[["open", "high", "low", "close"]].isna().any().any()
    assert int(out["volume"].sum()) == int(df["volume"].sum())


@pytest.mark.parametrize("interval", ALL_INTERVALS)
def test_resample_single_row(interval):
    idx = pd.DatetimeIndex([pd.Timestamp("2025-04-03 10:17:30")], name="ts")
    df = _ohlcv(idx)
    out = _resample_strict(df, interval)
    # len < 2: no source granularity -> always resampled into one bin
    exp = _expected(df, interval, None)
    _cmp(out, exp)
    assert len(out) == 1
    assert out.iloc[0]["open"] == df.iloc[0]["open"]
    assert list(out.dtypes) == list(df.dtypes)


@pytest.mark.parametrize("tz", [None, "Asia/Kolkata"])
@pytest.mark.parametrize("interval", ALL_INTERVALS)
def test_resample_empty_frame_returned_unchanged(interval, tz):
    idx = pd.DatetimeIndex([], name="ts")
    if tz:
        idx = idx.tz_localize(tz)
    df = pd.DataFrame({c: pd.Series([], dtype="float64") for c in
                       ("open", "high", "low", "close", "volume")}, index=idx)
    assert _resample_strict(df, interval) is df


# ── equal-granularity pass-through / upsample refusal, per rule ──────────────

@pytest.mark.parametrize("tz", [None, "Asia/Kolkata", "UTC"])
@pytest.mark.parametrize("interval", ALL_INTERVALS)
def test_equal_granularity_passthrough(interval, tz):
    secs = _rule_seconds(_RESAMPLE_RULES[interval])
    step = pd.Timedelta(secs, unit="s")
    idx = pd.DatetimeIndex([pd.Timestamp("2025-04-01 09:15") + i * step for i in range(7)])
    # one big gap; median still equals the step
    idx = idx.delete(3).append(pd.DatetimeIndex([idx[-1] + 10 * step]))
    if tz:
        idx = idx.tz_localize(tz)
    df = _ohlcv(idx)
    assert _resample_strict(df, interval) is df


@pytest.mark.parametrize("interval", ALL_INTERVALS)
def test_upsample_refused(interval, caplog):
    secs = _rule_seconds(_RESAMPLE_RULES[interval])
    # source slightly coarser than the target (by 1 second): target < source
    step = pd.Timedelta(secs + 1, unit="s")
    idx = pd.DatetimeIndex([pd.Timestamp("2025-04-01 09:15") + i * step for i in range(5)])
    df = _ohlcv(idx)
    with caplog.at_level(logging.WARNING, logger=local_loader.logger.name):
        out = _resample_strict(df, interval)
    assert out is df
    assert any("cannot upsample" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("interval", ALL_INTERVALS)
def test_one_second_finer_source_is_resampled(interval):
    """Boundary: source just finer than target -> resampled, not passed through."""
    secs = _rule_seconds(_RESAMPLE_RULES[interval])
    step = pd.Timedelta(secs - 1, unit="s")
    idx = pd.DatetimeIndex([pd.Timestamp("2025-04-01 09:15") + i * step for i in range(6)], name="ts")
    df = _ohlcv(idx)
    out = _resample_strict(df, interval)
    assert out is not df
    _cmp(out, _expected(df, interval, None))


def test_unsupported_interval_logs_and_returns_source(caplog):
    df = _ohlcv(_irregular_minute_index())
    with caplog.at_level(logging.WARNING, logger=local_loader.logger.name):
        out = _resample_strict(df, "2h", symbol="ZZZ")
    assert out is df
    msgs = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("unsupported interval" in m and "'2h'" in m and "ZZZ" in m for m in msgs)


# ── india_options._upto_expiry boundary ──────────────────────────────────────

@pytest.mark.parametrize("tz", [None, "Asia/Kolkata", "UTC"])
def test_upto_expiry_boundary(tz):
    from vibe_bt.backtest.engines.india_options import IndiaOptionsEngine, OptionSpec

    spec = OptionSpec(root="NIFTY", expiry=date(2025, 4, 3), strike=100.0, kind="CE")
    idx = pd.DatetimeIndex([
        "2025-04-02 15:29",
        "2025-04-03 00:00",
        "2025-04-03 15:30",
        "2025-04-03 23:59:59.999",
        "2025-04-04 00:00",
        "2025-04-04 09:15",
    ])
    if tz:
        idx = idx.tz_localize(tz)
    frame = pd.DataFrame({"close": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]}, index=idx)
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        warnings.simplefilter("error", FutureWarning)
        out = IndiaOptionsEngine._upto_expiry(frame, spec)
    assert list(out.values) == [1.0, 2.0, 3.0, 4.0]
    assert out.index[-1] == idx[3]  # 23:59:59.999 on expiry included
    assert idx[4] not in out.index  # next-day midnight excluded
    assert out.index.tz == idx.tz


# ── end-to-end through the local loader ──────────────────────────────────────

def _service_code(weight):
    return (
        "import pandas as pd\n"
        "class SignalEngine:\n"
        "    def generate(self, data_map):\n"
        f"        return {{c: pd.Series({weight}, index=df.index) for c, df in data_map.items()}}\n"
    )


@pytest.fixture
def local_env(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        '  - symbol: "RELIANCE.NS"\n'
        "    type: csv\n"
        f'    path: "{(FIXTURES / "reliance_5m.csv").as_posix()}"\n'
        "    columns:\n      date: timestamp\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")


def _with_warning_capture(monkeypatch):
    """Make the child show DeprecationWarnings on stderr and record its stderr."""
    import bt_service.runner as svc_runner

    captured: list[str] = []
    real_run = subprocess.run

    def run(cmd, *a, **k):
        cmd = list(cmd)
        if cmd and cmd[0] == sys.executable:
            cmd[1:1] = ["-W", "always::DeprecationWarning"]
        proc = real_run(cmd, *a, **k)
        captured.append(proc.stderr or "")
        return proc

    monkeypatch.setattr(svc_runner.subprocess, "run", run)
    return captured


def _numpy_version() -> tuple[int, int]:
    import numpy as np

    major, minor = (int(re.match(r"\d+", p).group()) for p in np.__version__.split(".")[:2])
    return major, minor


# The 'generic' unit DeprecationWarning only exists in NumPy >= 2.5. uv.lock pins
# numpy 2.4.6 for Python < 3.12 (CI runs 3.11), where pd.Timedelta('3min') is silent.
def _pandas_major() -> int:
    return int(re.match(r"\d+", pd.__version__).group())


# pandas 3 no longer routes pd.Timedelta('3min') through a generic-unit NumPy timedelta,
# so the warning cannot appear there; the positive control is pandas-2 only (TM2-41).
@pytest.mark.skipif(_numpy_version() < (2, 5),
                    reason="NumPy < 2.5 does not emit the 'generic' unit DeprecationWarning")
@pytest.mark.skipif(_pandas_major() >= 3,
                    reason="pandas >= 3 no longer emits the 'generic' unit DeprecationWarning "
                           "for pd.Timedelta('3min'); positive control applies to pandas 2.x only")
def test_capture_mechanism_sees_generic_timedelta_warning():
    """Positive control: the same flags/isolation do surface the old warning text.

    Runs in a fresh `-I` child, so the parent's warnings registry / test order cannot hide it.
    """
    proc = subprocess.run(
        [sys.executable, "-I", "-W", "always::DeprecationWarning", "-c",
         "import pandas as pd; pd.Timedelta('3min')"],
        capture_output=True, text=True, timeout=60,
    )
    assert GENERIC_MSG in proc.stderr


@pytest.mark.parametrize("interval", ["15m", "1H"])
def test_e2e_local_run_backtest_no_generic_timedelta_warning(local_env, monkeypatch, interval):
    from bt_service import run_backtest

    captured = _with_warning_capture(monkeypatch)
    with warnings.catch_warnings(record=True) as rec:
        warnings.simplefilter("always")
        r = run_backtest(_service_code(0.5), ["RELIANCE.NS"], "2024-03-04", "2024-03-06",
                         interval=interval, capital=1_000_000, source="local",
                         costs={"slippage": 0})
    assert r["ok"], r.get("error")
    assert captured, "child process was not launched"
    assert not any(GENERIC_MSG in str(w.message) for w in rec)
    for err in captured:
        assert GENERIC_MSG not in err, err[-2000:]
