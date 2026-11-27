import pandas as pd

from vibe_bt.backtest.engines._market_hooks import matched_market
from vibe_bt.backtest.loaders import local_loader as ll


def _frame(idx):
    return pd.DataFrame(
        {"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 1.0}, index=idx
    )


def _run(df, iv, symbol):
    return ll._resample_to_interval(
        df, iv, symbol, ll._session_anchor(symbol, matched_market(symbol))
    )


def test_nse_mid_session_start_10m():
    out = _run(_frame(pd.date_range("2025-04-01 11:07", periods=60, freq="1min")), "10m", "RELIANCE@NSE")
    assert out.index[0] == pd.Timestamp("2025-04-01 11:05")
    assert out.index[1] == pd.Timestamp("2025-04-01 11:15")
    assert all((t - pd.Timestamp("2025-04-01 09:15")) % pd.Timedelta("10min") == pd.Timedelta(0) for t in out.index)


def test_mcx_grid_0900():
    out = _run(_frame(pd.date_range("2025-04-01 11:07", periods=60, freq="1min")), "10m", "CRUDEOILFUT@MCX")
    assert out.index[0] == pd.Timestamp("2025-04-01 11:00")


def test_crypto_midnight_grid():
    out = _run(_frame(pd.date_range("2025-04-01 11:07", periods=60, freq="1min")), "10m", "BTCUSDT")
    assert out.index[0] == pd.Timestamp("2025-04-01 11:00")
    assert out.index[1] == pd.Timestamp("2025-04-01 11:10")


def test_multi_day_holiday_gap_aligned():
    idx = pd.date_range("2025-04-01 11:07", periods=30, freq="1min").append(
        pd.date_range("2025-04-07 09:15", periods=30, freq="1min")
    )
    out = _run(_frame(idx), "10m", "RELIANCE@NSE")
    for t in out.index:
        assert (t - pd.Timestamp(t.date()) - pd.Timedelta("9h15min")) % pd.Timedelta("10min") == pd.Timedelta(0)
    assert pd.Timestamp("2025-04-07 09:15") in out.index


def test_3m_nse_same_as_first_bar_anchor():
    idx = pd.date_range("2025-04-01 09:15", periods=90, freq="1min")
    df = _frame(idx)
    new = _run(df, "3m", "RELIANCE@NSE")
    old = ll._resample_to_interval(df, "3m", "RELIANCE@NSE")  # legacy first-bar origin
    pd.testing.assert_frame_equal(new, old)
