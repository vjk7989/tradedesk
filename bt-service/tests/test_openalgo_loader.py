import httpx
import pandas as pd
import pytest

from vibe_bt.backtest.loaders import openalgo_loader as oa
from vibe_bt.backtest.loaders.base import NoAvailableSourceError

KEY = "SECRETKEY123"


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("OPENALGO_URL", "http://oa.local:5000/")
    monkeypatch.setenv("OPENALGO_API_KEY", KEY)


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code = payload, status

    def json(self):
        return self._p


def patch_post(monkeypatch, resp=None, exc=None):
    calls = []

    def post(self, url, json=None, **kw):
        calls.append((url, json))
        if exc:
            raise exc
        return resp

    monkeypatch.setattr(httpx.Client, "post", post)
    return calls


ROWS = [
    {"timestamp": "2025-04-01 09:15:00+05:30", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 10},
    {"timestamp": "2025-04-02 09:15:00+05:30", "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 20},
]


@pytest.mark.parametrize(
    "code,expected",
    [
        ("RELIANCE.NS", ("RELIANCE", "NSE")),
        ("500325.BO", ("500325", "BSE")),
        ("M&M.ns", ("M&M", "NSE")),
        ("NIFTY28NOV2524000CE@NFO", ("NIFTY28NOV2524000CE", "NFO")),
        ("CRUDEOIL25DECFUT@MCX", ("CRUDEOIL25DECFUT", "MCX")),
        ("BTCUSD@CRYPTO", ("BTCUSD", "CRYPTO")),
        ("AAPL.US", None),
        ("AAPL", None),
        ("X@NOWHERE", None),
    ],
)
def test_symbol_mapping(code, expected):
    assert oa._map_symbol(code) == expected


@pytest.mark.parametrize(
    "given,expected",
    [("1D", "D"), ("1d", "D"), ("1H", "1h"), ("5m", "5m"), ("30m", "30m"), ("1m", "1m")],
)
def test_interval_mapping(given, expected):
    assert oa._INTERVAL_MAP[given] == expected


def test_request_body_and_frame(env, monkeypatch):
    calls = patch_post(monkeypatch, FakeResp({"status": "success", "data": ROWS}))
    out = oa.DataLoader().fetch(["RELIANCE.NS"], "2025-04-01", "2025-04-08", interval="1D")
    url, body = calls[0]
    assert url == "http://oa.local:5000/api/v1/history"
    assert body == {"apikey": KEY, "symbol": "RELIANCE", "exchange": "NSE", "interval": "D",
                    "start_date": "2025-04-01", "end_date": "2025-04-08"}
    df = out["RELIANCE.NS"]
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]
    assert df.index.name == "trade_date" and df.index.tz is None
    assert df.index[0] == pd.Timestamp("2025-04-01")
    assert df["close"].tolist() == [1.5, 2.5]


def test_unix_timestamps_to_ist(env, monkeypatch):
    rows = [{"timestamp": 1743479100, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}]
    patch_post(monkeypatch, FakeResp({"status": "success", "data": rows}))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval="5m")["X.NS"]
    assert df.index[0] == pd.Timestamp("2025-04-01 09:15:00")


def test_unhandled_symbol_skipped(env, monkeypatch):
    calls = patch_post(monkeypatch, FakeResp({"status": "success", "data": ROWS}))
    assert oa.DataLoader().fetch(["AAPL.US"], "2025-04-01", "2025-04-08") == {}
    assert calls == []


def test_error_status_falls_through(env, monkeypatch):
    patch_post(monkeypatch, FakeResp({"status": "error", "message": "bad"}))
    loader = oa.DataLoader()
    assert loader.fetch(["X.NS"], "2025-04-01", "2025-04-08") == {}
    with pytest.raises(NoAvailableSourceError):
        loader._fetch_one("http://oa.local", KEY, "X", "NSE", "D", "2025-04-01", "2025-04-08")


def test_http_error_falls_through(env, monkeypatch):
    patch_post(monkeypatch, FakeResp({}, status=500))
    assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-08") == {}


def test_apikey_never_in_exception(env, monkeypatch):
    patch_post(monkeypatch, exc=httpx.ConnectError(f"boom apikey={KEY}"))
    with pytest.raises(NoAvailableSourceError) as ei:
        oa.DataLoader()._fetch_one("http://oa.local", KEY, "X", "NSE", "D", "2025-04-01", "2025-04-08")
    assert KEY not in str(ei.value) and KEY not in repr(ei.value)
    patch_post(monkeypatch, FakeResp({"status": "error", "message": f"invalid key {KEY}"}))
    with pytest.raises(NoAvailableSourceError) as ei:
        oa.DataLoader()._fetch_one("http://oa.local", KEY, "X", "NSE", "D", "2025-04-01", "2025-04-08")
    assert KEY not in str(ei.value)


def test_missing_env_unavailable(monkeypatch):
    monkeypatch.delenv("OPENALGO_URL", raising=False)
    monkeypatch.delenv("OPENALGO_API_KEY", raising=False)
    loader = oa.DataLoader()
    assert loader.is_available() is False
    assert loader.fetch(["X.NS"], "2025-04-01", "2025-04-08") == {}


def test_registry_and_routing(env):
    from vibe_bt.backtest.engines._market_hooks import _detect_market
    from vibe_bt.backtest.loaders import registry

    registry._ensure_registered()
    assert "openalgo" in registry.LOADER_REGISTRY
    assert registry.FALLBACK_CHAINS["india_equity"][0] == "openalgo"
    assert registry.resolve_loader("india_equity").name == "openalgo"
    assert _detect_market("NIFTY28NOV2524000CE@NFO") == "india_equity"
    assert _detect_market("CRUDEOIL25DECFUT@MCX") == "india_equity"
    assert _detect_market("BTCUSD@CRYPTO") == "crypto"
    assert _detect_market("RELIANCE.NS") == "india_equity"


def test_child_env_cache_dir(monkeypatch, tmp_path):
    from bt_service.runner import _child_env

    monkeypatch.setenv("OPENALGO_API_KEY", KEY)
    monkeypatch.setenv("SOME_OTHER_SECRET", "x")
    env = _child_env(tmp_path)
    assert env["XDG_CACHE_HOME"] == str(tmp_path / ".cache")
    assert env["OPENALGO_API_KEY"] == KEY and "SOME_OTHER_SECRET" not in env
