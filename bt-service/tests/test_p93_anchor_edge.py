"""Edge cases for P9.3: session-anchored 3m/10m resampling in the local loader."""

import numpy as np
import pandas as pd
import pytest

from bt_service import run_backtest
from vibe_bt.backtest.engines._market_hooks import matched_market
from vibe_bt.backtest.loaders import local_loader as ll

T = pd.Timestamp
TEN = pd.Timedelta("10min")


def _frame(idx, seed=0):
    """Deterministic, valid OHLCV bars with distinct values per row."""
    rng = np.random.default_rng(seed)
    n = len(idx)
    close = 100 + np.cumsum(rng.normal(0, 0.5, n))
    open_ = close + rng.normal(0, 0.2, n)
    high = np.maximum(open_, close) + rng.uniform(0.01, 0.5, n)
    low = np.minimum(open_, close) - rng.uniform(0.01, 0.5, n)
    vol = rng.integers(1, 1000, n).astype(float)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": vol},
        index=pd.DatetimeIndex(idx, name="trade_date"),
    )


def _run(df, iv, symbol):
    return ll._resample_to_interval(df, iv, symbol, ll._session_anchor(symbol, matched_market(symbol)))


def _on_grid(t, hh, mm, step=TEN):
    return (t - t.normalize() - pd.Timedelta(hours=hh, minutes=mm)) % step == pd.Timedelta(0)


def _mins(start, n):
    return pd.date_range(start, periods=n, freq="1min")


# --- AC: NSE 09:15 grid regardless of where the file starts ------------------

@pytest.mark.parametrize("start,first_bin", [
    ("2025-04-01 09:16", "2025-04-01 09:15"),
    ("2025-04-01 09:24", "2025-04-01 09:15"),
    ("2025-04-01 09:25", "2025-04-01 09:25"),  # boundary: exactly on a bin edge
    ("2025-04-01 09:15", "2025-04-01 09:15"),
    ("2025-04-01 09:14", "2025-04-01 09:05"),  # pre-open bar falls in the bin before the open
])
def test_nse_start_minute_bins_on_0915_grid(start, first_bin):
    out = _run(_frame(_mins(start, 40)), "10m", "RELIANCE@NSE")
    assert out.index[0] == T(first_bin)
    assert all(_on_grid(t, 9, 15) for t in out.index)


def test_nse_single_bar_at_1529():
    df = _frame([T("2025-04-01 15:29")])
    out = _run(df, "10m", "RELIANCE@NSE")
    assert list(out.index) == [T("2025-04-01 15:25")]
    assert out.iloc[0].tolist() == df.iloc[0].tolist()


def test_nse_two_bars_1529_1530_share_1525_bin():
    df = _frame([T("2025-04-01 15:29"), T("2025-04-01 15:30")])
    out = _run(df, "10m", "RELIANCE@NSE")
    assert list(out.index) == [T("2025-04-01 15:25")]
    assert out["volume"].iloc[0] == df["volume"].sum()


def test_nse_file_starting_1530():
    out = _run(_frame(_mins("2025-04-01 15:30", 5)), "10m", "RELIANCE@NSE")
    assert list(out.index) == [T("2025-04-01 15:25")]


@pytest.mark.parametrize("symbol", [
    "500325.BO", "RELIANCE.NS", "RELIANCE@BSE", "NIFTY25DECFUT@NFO",
    "SENSEX25DECFUT@BFO", "NIFTY25DEC24000CE@NFO", "reliance@nse",
])
def test_indian_non_mcx_symbols_use_0915(symbol):
    assert matched_market(symbol) in ("india_equity", "india_fno", "india_options")
    out = _run(_frame(_mins("2025-04-01 11:07", 30)), "10m", symbol)
    assert out.index[0] == T("2025-04-01 11:05")
    assert all(_on_grid(t, 9, 15) for t in out.index)


@pytest.mark.parametrize("symbol", ["CRUDEOIL25DECFUT@MCX", "crudeoil25decfut@mcx",
                                    "GOLD@MCX", "gold@Mcx"])
def test_mcx_evening_start_on_0900_grid(symbol):
    out = _run(_frame(_mins("2025-04-01 18:03", 30)), "10m", symbol)
    assert out.index[0] == T("2025-04-01 18:00")
    assert all(_on_grid(t, 9, 0) for t in out.index)


def test_mcx_3m_grid():
    out = _run(_frame(_mins("2025-04-01 18:04", 30)), "3m", "CRUDEOIL25DECFUT@MCX")
    assert out.index[0] == T("2025-04-01 18:03")
    assert all(_on_grid(t, 9, 0, pd.Timedelta("3min")) for t in out.index)


@pytest.mark.parametrize("symbol", ["BTCUSDT", "BTC@CRYPTO", "AAPL.US", "UNKNOWNSYM"])
@pytest.mark.parametrize("start,first_bin", [
    ("2025-04-01 00:07", "2025-04-01 00:00"),
    ("2025-04-01 23:59", "2025-04-01 23:50"),
])
def test_non_indian_midnight_grid(symbol, start, first_bin):
    out = _run(_frame(_mins(start, 25)), "10m", symbol)
    assert out.index[0] == T(first_bin)
    assert all(_on_grid(t, 0, 0) for t in out.index)


def test_crypto_3m_midnight_grid_from_0007():
    out = _run(_frame(_mins("2025-04-01 00:07", 30)), "3m", "BTCUSDT")
    assert out.index[0] == T("2025-04-01 00:06")


def test_crypto_2359_crosses_midnight_on_grid():
    out = _run(_frame(_mins("2025-04-01 23:59", 15)), "10m", "BTCUSDT")
    assert list(out.index) == [T("2025-04-01 23:50"), T("2025-04-02 00:00"), T("2025-04-02 00:10")]


def test_session_anchor_values():
    assert ll._session_anchor("RELIANCE@NSE", "india_equity").time() == T("09:15").time()
    assert ll._session_anchor("X@MCX", "india_fno").time() == T("09:00").time()
    assert ll._session_anchor("x@mcx", "india_equity").time() == T("09:00").time()
    assert ll._session_anchor("BTCUSDT", "crypto").time() == T("00:00").time()
    assert ll._session_anchor("X", None).time() == T("00:00").time()
    # an MCX suffix alone does not imply 09:00 when the market is not Indian
    assert ll._session_anchor("X@MCX", None).time() == T("00:00").time()


# --- multi-day: weekend + midweek holiday ------------------------------------

def test_multi_day_weekend_and_midweek_holiday():
    # Fri 2025-10-17 (starts mid-session), Mon 10-20, Tue 10-21 holiday, Wed 10-22.
    idx = (_mins("2025-10-17 13:03", 40)
           .append(_mins("2025-10-20 09:23", 40))
           .append(_mins("2025-10-22 09:15", 375)))
    out = _run(_frame(idx), "10m", "RELIANCE@NSE")
    assert all(_on_grid(t, 9, 15) for t in out.index)
    assert T("2025-10-17 12:55") in out.index
    assert T("2025-10-20 09:15") in out.index
    assert T("2025-10-22 09:15") in out.index
    assert T("2025-10-22 15:25") in out.index
    assert not any(t.date() in (T("2025-10-18").date(), T("2025-10-19").date(),
                                T("2025-10-21").date()) for t in out.index)
    # every Wednesday bin is full except the last (15:25-15:29 = 5 bars)
    wed = out[out.index.normalize() == T("2025-10-22")]
    assert len(wed) == 38


def test_dst_irrelevant_across_us_eu_transitions():
    # US DST 2025-03-09, EU DST 2025-03-30: India has none; grid must not move.
    days = ["2025-03-07", "2025-03-10", "2025-03-28", "2025-03-31"]
    idx = _mins(f"{days[0]} 10:01", 30)
    for d in days[1:]:
        idx = idx.append(_mins(f"{d} 10:01", 30))
    out = _run(_frame(idx), "10m", "RELIANCE@NSE")
    for d in days:
        assert T(f"{d} 09:55") in out.index
    assert all(_on_grid(t, 9, 15) for t in out.index)


# --- OHLCV aggregation on the shifted grid -----------------------------------

def test_ohlcv_aggregation_on_shifted_grid():
    df = _frame(_mins("2025-04-01 09:16", 60), seed=7)
    out = _run(df, "10m", "RELIANCE@NSE")
    for start in out.index:
        chunk = df[(df.index >= start) & (df.index < start + TEN)]
        row = out.loc[start]
        assert row["open"] == chunk["open"].iloc[0]
        assert row["high"] == chunk["high"].max()
        assert row["low"] == chunk["low"].min()
        assert row["close"] == chunk["close"].iloc[-1]
        assert row["volume"] == pytest.approx(chunk["volume"].sum())
    # first bin 09:15 holds only 09:16..09:24 (9 bars)
    assert out["volume"].iloc[0] == pytest.approx(df["volume"].iloc[:9].sum())
    assert out["volume"].sum() == pytest.approx(df["volume"].sum())


def test_ohlcv_aggregation_3m_shifted_grid():
    df = _frame(_mins("2025-04-01 09:17", 30), seed=3)
    out = _run(df, "3m", "RELIANCE@NSE")
    assert out.index[0] == T("2025-04-01 09:15")
    first = df.iloc[:1]  # only 09:17 lands in the 09:15 bin
    assert out["open"].iloc[0] == first["open"].iloc[0]
    assert out["close"].iloc[0] == first["close"].iloc[0]
    assert out.index[1] == T("2025-04-01 09:18")


# --- other intervals unchanged; legacy anchor=None ---------------------------

@pytest.mark.parametrize("iv", ["5m", "15m", "30m", "1H", "4H", "1D"])
@pytest.mark.parametrize("symbol", ["RELIANCE@NSE", "CRUDEOIL25DECFUT@MCX", "BTCUSDT"])
@pytest.mark.parametrize("start", ["2025-04-01 09:15", "2025-04-01 09:16", "2025-04-01 18:03"])
def test_non_anchored_intervals_identical_to_legacy(iv, symbol, start):
    df = _frame(_mins(start, 600))
    new = _run(df, iv, symbol)
    old = ll._resample_to_interval(df, iv, symbol)
    # 1-minute source, coarser target: both sides resample and are pinned to ns.
    assert new.index.unit == "ns"
    assert old.index.unit == "ns"
    pd.testing.assert_frame_equal(new, old)


def test_legacy_anchor_none_keeps_first_bar_origin():
    df = _frame(_mins("2025-04-01 09:16", 40))
    old = ll._resample_to_interval(df, "10m", "RELIANCE@NSE")
    assert old.index[0] == T("2025-04-01 09:16")
    assert old.index[1] == T("2025-04-01 09:26")


def test_legacy_anchor_none_uses_first_day_earliest():
    # unsorted-on-first-day guard: origin is the earliest bar of the first date
    df = _frame(_mins("2025-04-01 00:07", 30))
    old = ll._resample_to_interval(df, "10m", "BTCUSDT")
    assert old.index[0] == T("2025-04-01 00:07")


def test_empty_frame_with_anchor():
    empty = _frame(pd.DatetimeIndex([]))
    out = _run(empty, "10m", "RELIANCE@NSE")
    assert out.empty
    # empty frames are returned unchanged (pass-through), so the input unit is kept
    assert out.index.unit == empty.index.unit


def test_same_granularity_with_anchor_unchanged():
    df = _frame(pd.date_range("2025-04-01 09:16", periods=10, freq="10min"))
    out = _run(df, "10m", "RELIANCE@NSE")
    # same granularity is a documented pass-through: the source frame comes back
    # untouched, so it keeps the input unit (not ns-normalised).
    assert out.index.unit == df.index.unit
    pd.testing.assert_frame_equal(out, df)


def test_upsample_refused_with_anchor():
    df = _frame(pd.date_range("2025-04-01 09:15", periods=10, freq="15min"))
    out = _run(df, "10m", "RELIANCE@NSE")
    # upsample is refused and the source bars are returned unchanged, so the
    # input unit is kept (not ns-normalised).
    assert out.index.unit == df.index.unit
    pd.testing.assert_frame_equal(out, df)


# --- loader path: tz-aware input converted to IST wall clock -----------------

def _write_cfg(tmp_path, monkeypatch, entries):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("sources:\n" + "".join(
        f'  - symbol: "{s}"\n    type: csv\n    path: "{p.as_posix()}"\n' for s, p in entries),
        encoding="utf-8")
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    # the in-process DataLoader reads the module-level path (set at import)
    monkeypatch.setattr(ll, "_CONFIG_PATH", cfg)
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    monkeypatch.delenv("BT_KEEP_RUNS", raising=False)


def _csv(tmp_path, name, df, suffix=""):
    path = tmp_path / name
    out = df.copy()
    out.index = pd.Index([t.strftime("%Y-%m-%d %H:%M:%S") + suffix for t in df.index], name="date")
    out.to_csv(path)
    return path


@pytest.mark.parametrize("symbol", ["RELIANCE.NS", "RELIANCE@NSE", "NIFTY25DECFUT@NFO"])
def test_loader_plus0530_csv_on_ist_0915_grid(tmp_path, monkeypatch, symbol):
    df = _frame(_mins("2025-04-01 11:07", 60))
    _write_cfg(tmp_path, monkeypatch, [(symbol, _csv(tmp_path, "x.csv", df, "+05:30"))])
    out = ll.DataLoader().fetch([symbol], "2025-04-01", "2025-04-01", interval="10m")[symbol]
    assert out.index.tz is None
    assert out.index[0] == T("2025-04-01 11:05")
    assert all(_on_grid(t, 9, 15) for t in out.index)


def test_loader_utc_csv_for_nse_converted_to_ist_grid(tmp_path, monkeypatch):
    # 05:37Z == 11:07 IST -> 11:05 IST bin
    ist = _mins("2025-04-01 11:07", 60)
    utc = ist - pd.Timedelta(hours=5, minutes=30)
    df = _frame(utc)
    _write_cfg(tmp_path, monkeypatch, [("RELIANCE.NS", _csv(tmp_path, "x.csv", df, "Z"))])
    out = ll.DataLoader().fetch(["RELIANCE.NS"], "2025-04-01", "2025-04-01", interval="10m")["RELIANCE.NS"]
    assert out.index[0] == T("2025-04-01 11:05")
    assert all(_on_grid(t, 9, 15) for t in out.index)


def test_loader_naive_mcx_and_crypto(tmp_path, monkeypatch):
    mcx = _frame(_mins("2025-04-01 18:03", 30))
    btc = _frame(_mins("2025-04-01 00:07", 30))
    _write_cfg(tmp_path, monkeypatch, [
        ("CRUDEOIL25DECFUT@MCX", _csv(tmp_path, "m.csv", mcx)),
        ("BTCUSDT", _csv(tmp_path, "b.csv", btc)),
    ])
    got = ll.DataLoader().fetch(["CRUDEOIL25DECFUT@MCX", "BTCUSDT"], "2025-04-01", "2025-04-01",
                                interval="10m")
    assert got["CRUDEOIL25DECFUT@MCX"].index[0] == T("2025-04-01 18:00")
    assert got["BTCUSDT"].index[0] == T("2025-04-01 00:00")


# --- end-to-end --------------------------------------------------------------

HOLD = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        return {c: pd.Series(1.0, index=df.index) for c, df in data_map.items()}
'''


@pytest.mark.parametrize("iv", ["10m", "3m"])
def test_run_backtest_mid_session_nse_local_csv(tmp_path, monkeypatch, iv):
    idx = (_mins("2025-04-01 11:07", 263)          # mid-session start, to 15:29
           .append(_mins("2025-04-02 09:15", 375))
           .append(_mins("2025-04-03 09:15", 375)))
    df = _frame(idx)
    _write_cfg(tmp_path, monkeypatch, [("RELIANCE.NS", _csv(tmp_path, "r.csv", df))])
    res = run_backtest(HOLD, ["RELIANCE.NS"], "2025-04-01", "2025-04-03", interval=iv,
                       capital=1_000_000, source="local")
    assert res["ok"], res.get("error")
    assert res["metrics"]
    assert not any("declares bars spaced" in w for w in res["warnings"]), res["warnings"]
