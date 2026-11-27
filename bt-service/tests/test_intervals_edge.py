"""Edge cases for the 3m / 10m interval support (P7.2b)."""

import logging
import math

import numpy as np
import pandas as pd
import pytest

from bt_service import run_backtest
from vibe_bt.backtest import runner
from vibe_bt.backtest.loaders import ccxt_loader, india_broker_loader, local_loader
from vibe_bt.backtest.loaders import openalgo_loader as oa
from vibe_bt.backtest.metrics import _BARS_PER_DAY, _normalize_interval, calc_bars_per_year

SCHEMA = dict(codes=["AAPL.US"], start_date="2025-04-01", end_date="2025-04-02", source="local")
MINUTE_ORDER = ["1m", "3m", "5m", "10m", "15m"]

HOLD = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        return {c: pd.Series(1.0, index=df.index) for c, df in data_map.items()}
'''


def session_1m(days=("2025-04-01",), start="09:15", n=375, seed=0):
    """Deterministic 1m OHLCV bars covering an NSE session (09:15-15:29)."""
    rng = np.random.default_rng(seed)
    idx = pd.DatetimeIndex(
        [t for d in days for t in pd.date_range(f"{d} {start}", periods=n, freq="1min")]
    )
    close = 100 + np.cumsum(rng.normal(0, 0.1, len(idx)))
    open_ = close + rng.normal(0, 0.05, len(idx))
    high = np.maximum(open_, close) + rng.uniform(0, 0.1, len(idx))
    low = np.minimum(open_, close) - rng.uniform(0, 0.1, len(idx))
    vol = rng.integers(1, 1000, len(idx)).astype(float)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": vol}, index=idx
    )


# --- runner validation: format / case variants -----------------------------------

@pytest.mark.parametrize("iv", ["3m", "10m"])
def test_schema_accepts(iv):
    assert runner.BacktestConfigSchema(**SCHEMA, interval=iv).interval == iv


@pytest.mark.parametrize("iv", ["3M", "10M", " 3m ", "03m", "3min", "10min", "2m", "", "3"])
def test_schema_rejects_variants(iv):
    with pytest.raises(ValueError, match="unsupported interval"):
        runner.BacktestConfigSchema(**SCHEMA, interval=iv)


def test_one_M_stays_month_one_m_stays_minute():
    assert _normalize_interval("1M") == "1M"
    assert _normalize_interval("1m") == "1m"
    assert calc_bars_per_year("1M", "india_broker") == 12
    assert calc_bars_per_year("1m", "india_broker") == 252 * 375


def test_upper_M_multi_minute_consistent_with_existing_5M():
    # Only "1M" is a month; "nM" for n != 1 folds to minutes, as "5M" already did.
    # The runner schema rejects "3M"/"10M" outright, so this only matters to direct
    # metrics callers. Consistency check, not an endorsement of "3M" = 3 minutes.
    assert _normalize_interval("5M") == "5m"
    assert _normalize_interval("3M") == "3m"
    assert _normalize_interval("10M") == "10m"
    assert _normalize_interval(" 3m ") == "3m"


@pytest.mark.parametrize("iv", ["03m", "3min", "10min"])
def test_normalize_does_not_invent_aliases(iv):
    # Unknown spellings pass through untouched; they must not alias 3m/10m.
    assert _normalize_interval(iv) not in ("3m", "10m")


# --- _BARS_PER_DAY table ------------------------------------------------------

@pytest.mark.parametrize("iv", ["3m", "10m"])
def test_every_source_has_row(iv):
    assert set(_BARS_PER_DAY[iv]) == set(_BARS_PER_DAY["5m"]) == set(_BARS_PER_DAY["1m"])
    assert all(isinstance(v, int) and v > 1 for v in _BARS_PER_DAY[iv].values())


@pytest.mark.parametrize("source", sorted(_BARS_PER_DAY["1m"]))
def test_monotonic_and_rounded_up(source):
    row = [_BARS_PER_DAY[iv][source] for iv in MINUTE_ORDER]
    assert row == sorted(row, reverse=True) and len(set(row)) == len(row), row
    one = _BARS_PER_DAY["1m"][source]
    assert _BARS_PER_DAY["3m"][source] == math.ceil(one / 3)
    assert _BARS_PER_DAY["10m"][source] == math.ceil(one / 10)


def test_india_values_and_bars_per_year():
    assert _BARS_PER_DAY["3m"]["india_broker"] == 125
    assert _BARS_PER_DAY["10m"]["india_broker"] == 38
    assert calc_bars_per_year("3m", "india_broker") == 252 * 125
    assert calc_bars_per_year("10m", "india_broker") == 252 * 38


@pytest.mark.parametrize("source", ["yahoo", "binance", "INDIA_BROKER", " local "])
@pytest.mark.parametrize("iv", ["3m", "10m"])
def test_bars_per_year_never_defaults_to_one_per_day(source, iv):
    days = calc_bars_per_year("1D", source)
    assert calc_bars_per_year(iv, source) > days * 10


def test_unknown_source_still_defaults():
    assert calc_bars_per_year("3m", "nope") == 252


# --- annualisation spacing check ----------------------------------------------

def _bars(freq, n=200, start="2025-04-01 09:15"):
    idx = pd.date_range(start, periods=n, freq=freq)
    return {"X": pd.DataFrame({"close": 1.0}, index=idx)}


@pytest.mark.parametrize("iv,freq", [("3m", "3min"), ("10m", "10min")])
def test_spacing_accepts_true_data(iv, freq):
    warns = []
    out = runner._annualisation_bars(iv, "india_broker", _bars(freq), ["X"], warnings=warns)
    assert out == calc_bars_per_year(iv, "india_broker")
    assert warns == []


def test_spacing_accepts_3m_with_overnight_gaps():
    df = session_1m(days=("2025-04-01", "2025-04-02", "2025-04-03")).iloc[::3]
    warns = []
    out = runner._annualisation_bars("3m", "india_broker", {"X": df}, ["X"], warnings=warns)
    assert out == 252 * 125 and warns == []


@pytest.mark.parametrize(
    "declared,freq,matched",
    [("3m", "5min", "5m"), ("3m", "1min", "1m"), ("10m", "5min", "5m"),
     ("10m", "15min", "15m"), ("15m", "10min", "10m"), ("5m", "3min", "3m"),
     ("5m", "10min", "10m")],
)
def test_spacing_rejects_mismatch(declared, freq, matched):
    warns = []
    out = runner._annualisation_bars(declared, "india_broker", _bars(freq), ["X"], warnings=warns)
    assert out == calc_bars_per_year(matched, "india_broker")
    assert len(warns) == 1 and f"interval={declared}" in warns[0] and matched in warns[0]


def test_spacing_too_few_bars_keeps_declared():
    warns = []
    out = runner._annualisation_bars("3m", "india_broker", _bars("5min", n=3), ["X"], warnings=warns)
    assert out == 252 * 125 and warns == []


# --- local loader resampling --------------------------------------------------

@pytest.mark.parametrize("iv,n", [("3m", 3), ("10m", 10)])
def test_local_resample_ohlcv_aggregation(iv, n):
    df = session_1m()
    out = local_loader._resample_to_interval(df, iv, "X")
    for label, row in out.iterrows():
        chunk = df[(df.index >= label) & (df.index < label + pd.Timedelta(minutes=n))]
        assert not chunk.empty
        assert row["open"] == chunk["open"].iloc[0]
        assert row["high"] == chunk["high"].max()
        assert row["low"] == chunk["low"].min()
        assert row["close"] == chunk["close"].iloc[-1]
        assert row["volume"] == pytest.approx(chunk["volume"].sum())
    assert out["volume"].sum() == pytest.approx(df["volume"].sum())


@pytest.mark.parametrize("iv,n,bins", [("3m", 3, 125), ("10m", 10, 38)])
def test_local_resample_bins_aligned_to_session_open(iv, n, bins):
    df = session_1m()
    out = local_loader._resample_to_interval(df, iv, "X")
    assert out.index[0] == pd.Timestamp("2025-04-01 09:15"), (
        f"{iv} bins start at {out.index[0].time()}, not session open 09:15"
    )
    assert len(out) == bins
    assert (out.index.to_series().diff().dropna() == pd.Timedelta(minutes=n)).all()


@pytest.mark.parametrize("iv", ["3m", "10m"])
def test_local_resample_empty(iv):
    empty = session_1m().iloc[:0]
    assert local_loader._resample_to_interval(empty, iv, "X").empty


def test_local_resample_same_granularity_unchanged():
    df = session_1m().iloc[::3]
    df.index = pd.date_range("2025-04-01 09:15", periods=len(df), freq="3min")
    pd.testing.assert_frame_equal(local_loader._resample_to_interval(df, "3m", "X"), df)


def test_local_resample_refuses_upsample_5m_to_3m(caplog):
    df = session_1m().iloc[::5]
    df.index = pd.date_range("2025-04-01 09:15", periods=len(df), freq="5min")
    with caplog.at_level(logging.WARNING):
        out = local_loader._resample_to_interval(df, "3m", "X")
    pd.testing.assert_frame_equal(out, df)
    assert "cannot upsample" in caplog.text


@pytest.mark.parametrize("iv", ["3M", "3min"])
def test_local_resample_unknown_variant_returns_source(iv, caplog):
    df = session_1m()
    with caplog.at_level(logging.WARNING):
        out = local_loader._resample_to_interval(df, iv, "X")
    assert out is df and "unsupported interval" in caplog.text


# --- ccxt ---------------------------------------------------------------------

class FakeExchange:
    features = {}

    def __init__(self):
        self.timeframes_seen = []

    def fetch_ohlcv(self, symbol, timeframe, since=None, limit=None, **kw):
        self.timeframes_seen.append(timeframe)
        step = {"3m": 180_000, "1d": 86_400_000}.get(timeframe, 60_000)
        if since > 1743552000000:  # past 2025-04-02 00:00 UTC: done
            return []
        return [[since + i * step, 1.0, 2.0, 0.5, 1.5, 10.0] for i in range(5)]


@pytest.fixture
def ccxt_env(monkeypatch):
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    ex = FakeExchange()
    monkeypatch.setattr(ccxt_loader.DataLoader, "_get_exchange", lambda self, t="spot": ex)
    return ex


def test_ccxt_3m_requests_3m(ccxt_env):
    out = ccxt_loader.DataLoader().fetch(["BTC-USDT"], "2025-04-01", "2025-04-01", interval="3m")
    assert ccxt_env.timeframes_seen and set(ccxt_env.timeframes_seen) == {"3m"}
    assert "BTC-USDT" in out
    assert (out["BTC-USDT"].index.to_series().diff().dropna() == pd.Timedelta(minutes=3)).all()


def test_ccxt_10m_reported_unsupported_not_silent_daily(ccxt_env, caplog):
    loader = ccxt_loader.DataLoader()
    with caplog.at_level(logging.WARNING):
        try:
            out = loader.fetch(["BTC-USDT"], "2025-04-01", "2025-04-01", interval="10m")
        except ValueError as exc:  # a clear rejection is acceptable
            assert "10m" in str(exc)
            out = {}
    assert "1d" not in ccxt_env.timeframes_seen, "10m silently fetched daily bars"
    assert out == {}
    assert "10m" in caplog.text


def test_ccxt_maps_unchanged():
    assert ccxt_loader._INTERVAL_MAP["3m"] == "3m"
    assert "10m" not in ccxt_loader._INTERVAL_MAP
    for k, v in {"1m": "1m", "5m": "5m", "15m": "15m", "1H": "1h", "1D": "1d", "1M": "1M"}.items():
        assert ccxt_loader._INTERVAL_MAP[k] == v


# --- india_broker / openalgo --------------------------------------------------

class FakeSdk:
    def __init__(self):
        self.periods = []

    def get_historical_bars(self, symbol, exchange=None, period=None, limit=None):
        self.periods.append(period)
        t0 = int(pd.Timestamp("2025-04-01 09:15").timestamp())
        return {"status": "ok", "bars": [
            {"time": t0 + i * 180, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 1}
            for i in range(5)
        ]}


@pytest.mark.parametrize("iv", ["3m", "10m", " 3m "])
def test_india_broker_maps(monkeypatch, iv):
    sdk = FakeSdk()
    monkeypatch.setattr(india_broker_loader, "_resolve_broker", lambda: ("zerodha", sdk))
    out = india_broker_loader.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-01", interval=iv)
    assert sdk.periods == [iv.strip()] and "X.NS" in out


@pytest.mark.parametrize("iv", ["3M", "10M", "3min"])
def test_india_broker_rejects_variants(monkeypatch, iv):
    sdk = FakeSdk()
    monkeypatch.setattr(india_broker_loader, "_resolve_broker", lambda: ("zerodha", sdk))
    assert india_broker_loader.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-01", interval=iv) == {}
    assert sdk.periods == []


def test_openalgo_map():
    assert oa._INTERVAL_MAP["3m"] == "3m" and oa._INTERVAL_MAP["10m"] == "10m"


# --- end-to-end ---------------------------------------------------------------

@pytest.fixture
def local_1m(tmp_path, monkeypatch):
    df = session_1m(days=("2025-04-01", "2025-04-02", "2025-04-03"))
    csv = tmp_path / "x_1m.csv"
    df.rename_axis("date").reset_index().to_csv(csv, index=False, date_format="%Y-%m-%d %H:%M:%S")
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        '  - symbol: "AAPL.US"\n'
        "    type: csv\n"
        f'    path: "{csv.as_posix()}"\n'
        '    date_format: "%Y-%m-%d %H:%M:%S"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    monkeypatch.delenv("BT_KEEP_RUNS", raising=False)
    return df


@pytest.mark.parametrize("iv", ["3m", "10m"])
def test_run_backtest_local_1m_resampled(local_1m, iv):
    res = run_backtest(HOLD, ["AAPL.US"], "2025-04-01", "2025-04-03", interval=iv,
                       capital=100_000, source="local")
    assert res["ok"], res.get("error")
    assert res["metrics"]
    assert not any("declares bars spaced" in w for w in res["warnings"]), res["warnings"]


def test_run_backtest_rejects_3M(local_1m):
    res = run_backtest(HOLD, ["AAPL.US"], "2025-04-01", "2025-04-03", interval="3M",
                       capital=100_000, source="local")
    assert not res["ok"]
