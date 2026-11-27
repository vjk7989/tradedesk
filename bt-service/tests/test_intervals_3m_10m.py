import httpx
import pandas as pd
import pytest

from vibe_bt.backtest import runner
from vibe_bt.backtest.loaders import local_loader, openalgo_loader as oa
from vibe_bt.backtest.metrics import calc_bars_per_year

KEY = "K"


@pytest.mark.parametrize("iv", ["3m", "10m"])
def test_valid_and_seconds(iv):
    assert iv in runner._VALID_INTERVALS
    assert runner._INTERVAL_SECONDS[iv] == {"3m": 180.0, "10m": 600.0}[iv]


def test_existing_intervals_unchanged():
    assert runner._VALID_INTERVALS >= {"1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W", "1M"}
    assert runner._INTERVAL_SECONDS["5m"] == 300.0


def test_bars_per_year():
    days = calc_bars_per_year("1D", "india_broker")
    assert calc_bars_per_year("3m", "india_broker") == days * 125
    assert calc_bars_per_year("10m", "india_broker") == days * 38  # 37.5 rounded up, like 1H=7
    assert calc_bars_per_year("3m", "local") == calc_bars_per_year("1D", "local") * 130
    assert calc_bars_per_year("10m", "local") == calc_bars_per_year("1D", "local") * 39
    assert calc_bars_per_year("5m", "india_broker") == days * 75


@pytest.mark.parametrize("iv,n", [("3m", 3), ("10m", 10)])
def test_local_resample(iv, n):
    idx = pd.date_range("2025-04-01 09:30", periods=60, freq="1min")
    df = pd.DataFrame({"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 1.0}, index=idx)
    out = local_loader._resample_to_interval(df, iv, "X")
    assert out["volume"].iloc[0] == n
    assert len(out) <= 60 // n + 1


@pytest.mark.parametrize("iv", ["3m", "10m"])
def test_openalgo_request_interval(monkeypatch, iv):
    monkeypatch.setenv("OPENALGO_URL", "http://oa.local:5000/")
    monkeypatch.setenv("OPENALGO_API_KEY", KEY)
    calls = []

    class R:
        status_code = 200

        def json(self):
            return {"status": "success", "data": []}

    def post(self, url, json=None, **kw):
        calls.append(json)
        return R()

    monkeypatch.setattr(httpx.Client, "post", post)
    oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval=iv)
    assert calls and calls[0]["interval"] == iv
