"""Edge-case tests for the OpenAlgo loader, registry wiring, and child cache setup."""
import datetime as dt
import json
import logging
import traceback
from pathlib import Path

import httpx
import pandas as pd
import pytest

from vibe_bt.backtest.loaders import openalgo_loader as oa
from vibe_bt.backtest.loaders import registry
from vibe_bt.backtest.loaders.base import NoAvailableSourceError

KEY = "SECRETKEY123"


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("OPENALGO_URL", "http://oa.local:5000/")
    monkeypatch.setenv("OPENALGO_API_KEY", KEY)


class FakeResp:
    def __init__(self, payload, status=200, bad_json=False):
        self._p, self.status_code, self._bad = payload, status, bad_json

    def json(self):
        if self._bad:
            raise ValueError("Expecting value: line 1 column 1")
        return self._p


def patch_post(monkeypatch, resp=None, exc=None, by_symbol=None):
    calls = []

    def post(self, url, json=None, **kw):
        calls.append((url, json))
        if by_symbol is not None:
            r = by_symbol[json["symbol"]]
            if isinstance(r, Exception):
                raise r
            return r
        if exc:
            raise exc
        return resp

    monkeypatch.setattr(httpx.Client, "post", post)
    return calls


def ok(rows):
    return FakeResp({"status": "success", "data": rows})


def row(ts, o=1, h=2, l=0.5, c=1.5, v=10):
    return {"timestamp": ts, "open": o, "high": h, "low": l, "close": c, "volume": v}


# ---------- symbols ----------

@pytest.mark.parametrize(
    "code,expected",
    [
        ("reliance.ns", ("reliance", "NSE")),
        ("M&M.NS", ("M&M", "NSE")),
        ("BAJAJ-AUTO.NS", ("BAJAJ-AUTO", "NSE")),
        ("nifty28nov2524000ce@nfo", ("nifty28nov2524000ce", "NFO")),
        ("  RELIANCE.NS  ", ("RELIANCE", "NSE")),
        ("SYM@BFO", ("SYM", "BFO")),
        ("SYM@CDS", ("SYM", "CDS")),
        ("SYM@BCD", ("SYM", "BCD")),
        ("SYM@BSE", ("SYM", "BSE")),
        ("SYM@NSE", ("SYM", "NSE")),
        ("SYM@", None),
        ("@NSE", None),
        ("A@B@NSE", None),
        ("SYM@XYZ", None),
        ("", None),
        ("   ", None),
        (".NS", None),
        (".BO", None),
    ],
)
def test_symbol_edges(code, expected):
    assert oa._map_symbol(code) == expected


def test_double_suffix_not_sent_with_suffix():
    mapped = oa._map_symbol("RELIANCE.NS.NS")
    assert mapped is None or not mapped[0].upper().endswith(".NS")


def test_pathish_symbol_rejected():
    assert oa._map_symbol("../x.NS") is None


def test_suffix_stripped_in_request(env, monkeypatch):
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    oa.DataLoader().fetch(["M&M.NS", "500325.BO"], "2025-04-01", "2025-04-02")
    assert [(b["symbol"], b["exchange"]) for _, b in calls] == [("M&M", "NSE"), ("500325", "BSE")]


def test_unmapped_symbol_makes_no_call(env, monkeypatch):
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    assert oa.DataLoader().fetch(["AAPL", "SYM@XYZ"], "2025-04-01", "2025-04-02") == {}
    assert calls == []


def test_empty_codes(env, monkeypatch):
    calls = patch_post(monkeypatch, ok([]))
    assert oa.DataLoader().fetch([], "2025-04-01", "2025-04-02") == {}
    assert calls == []


# ---------- intervals ----------

@pytest.mark.parametrize("given,expected", [("D", "D"), ("1h", "1h"), ("3m", "3m"), ("10m", "10m"), ("15m", "15m")])
def test_interval_sent(env, monkeypatch, given, expected):
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval=given)
    assert calls[0][1]["interval"] == expected


@pytest.mark.parametrize("bad", ["", "2h", "1W", "1M", "1w", "4h", "1y", None])
def test_interval_rejected_no_call(env, monkeypatch, bad):
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval=bad) == {}
    assert calls == []


def test_month_not_confused_with_minute():
    assert oa._INTERVAL_MAP.get("1M") != "1m"


# ---------- dates ----------

def test_start_after_end_rejected(env, monkeypatch):
    calls = patch_post(monkeypatch, ok([]))
    with pytest.raises(ValueError):
        oa.DataLoader().fetch(["X.NS"], "2025-04-10", "2025-04-01")
    assert calls == []


def test_same_day_range_ok(env, monkeypatch):
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    assert "X.NS" in oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-01")
    assert len(calls) == 1


def test_datetime_dates_body_json_serialisable(env, monkeypatch):
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    oa.DataLoader().fetch(["X.NS"], dt.date(2025, 4, 1), dt.datetime(2025, 4, 2))
    json.dumps(calls[0][1])  # real httpx would fail to encode datetime objects
    assert calls[0][1]["start_date"] == "2025-04-01"


# ---------- response shapes ----------

def test_empty_data_list(env, monkeypatch):
    patch_post(monkeypatch, ok([]))
    assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02") == {}


def test_null_data(env, monkeypatch):
    patch_post(monkeypatch, FakeResp({"status": "success", "data": None}))
    assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02") == {}


def test_missing_timestamp_column(env, monkeypatch):
    patch_post(monkeypatch, ok([{"open": 1, "high": 2, "low": 0.5, "close": 1}]))
    assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02") == {}


def test_missing_close_column(env, monkeypatch):
    patch_post(monkeypatch, ok([{"timestamp": "2025-04-01 09:15:00+05:30", "open": 1, "high": 2, "low": 0.5}]))
    assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02") == {}


def test_missing_volume_filled_zero(env, monkeypatch):
    r = row("2025-04-01 09:15:00+05:30")
    del r["volume"]
    patch_post(monkeypatch, ok([r]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02")["X.NS"]
    assert df["volume"].iloc[0] == 0.0


def test_string_numbers_and_float_dtype(env, monkeypatch):
    patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30", "1.5", "2", "1", "1.75", "100")]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02")["X.NS"]
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]
    assert all(str(t) == "float64" for t in df.dtypes)
    assert df["close"].iloc[0] == 1.75


def test_nan_none_rows_dropped(env, monkeypatch):
    rows = [row("2025-04-01 09:15:00+05:30", c=None), row("2025-04-02 09:15:00+05:30", o=float("nan")),
            row("2025-04-03 09:15:00+05:30")]
    patch_post(monkeypatch, ok(rows))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-05")["X.NS"]
    assert list(df.index) == [pd.Timestamp("2025-04-03")]


def test_duplicates_kept_once_and_sorted(env, monkeypatch):
    rows = [row("2025-04-03 09:15:00+05:30", c=3), row("2025-04-01 09:15:00+05:30", c=1),
            row("2025-04-03 09:15:00+05:30", c=33), row("2025-04-02 09:15:00+05:30", c=2)]
    patch_post(monkeypatch, ok(rows))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-05")["X.NS"]
    assert df.index.is_monotonic_increasing and df.index.is_unique
    assert len(df) == 3
    assert df.index.name == "trade_date" and df.index.tz is None


def test_epoch_seconds_ist(env, monkeypatch):
    ts = int(pd.Timestamp("2025-04-01 03:45:00", tz="UTC").timestamp())  # 09:15 IST
    patch_post(monkeypatch, ok([row(ts)]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval="1m")["X.NS"]
    assert df.index[0] == pd.Timestamp("2025-04-01 09:15:00")


def test_epoch_millis_ist(env, monkeypatch):
    ts = int(pd.Timestamp("2025-04-01 03:45:00", tz="UTC").timestamp()) * 1000
    patch_post(monkeypatch, ok([row(ts)]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval="1m")["X.NS"]
    assert df.index[0] == pd.Timestamp("2025-04-01 09:15:00")


def test_iso_z_converted_to_ist(env, monkeypatch):
    patch_post(monkeypatch, ok([row("2025-04-01T03:45:00Z")]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval="1m")["X.NS"]
    assert df.index[0] == pd.Timestamp("2025-04-01 09:15:00")


def test_iso_plus0530_kept(env, monkeypatch):
    patch_post(monkeypatch, ok([row("2025-04-01T09:15:00+05:30")]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval="1m")["X.NS"]
    assert df.index[0] == pd.Timestamp("2025-04-01 09:15:00")


def test_utc_midnight_boundary_ist(env, monkeypatch):
    ts = int(pd.Timestamp("2025-01-01 00:00:00", tz="UTC").timestamp())
    patch_post(monkeypatch, ok([row(ts)]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-01-01", "2025-01-02", interval="1h")["X.NS"]
    assert df.index[0] == pd.Timestamp("2025-01-01 05:30:00")


def test_daily_bar_1830_utc_prev_day_normalised(env, monkeypatch):
    ts = int(pd.Timestamp("2025-03-31 18:30:00", tz="UTC").timestamp())  # 2025-04-01 00:00 IST
    patch_post(monkeypatch, ok([row(ts)]))
    df = oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02", interval="1D")["X.NS"]
    assert df.index[0] == pd.Timestamp("2025-04-01")


def test_huge_response(env, monkeypatch):
    base = int(pd.Timestamp("2020-01-01", tz="UTC").timestamp())
    rows = [row(base + 60 * i) for i in range(100_000)]
    patch_post(monkeypatch, ok(rows))
    df = oa.DataLoader().fetch(["X.NS"], "2020-01-01", "2020-04-01", interval="1m")["X.NS"]
    assert len(df) == 100_000 and df.index.is_monotonic_increasing


# ---------- HTTP errors / redaction ----------

def _fetch_one_err(monkeypatch, **kw):
    patch_post(monkeypatch, **kw)
    with pytest.raises(NoAvailableSourceError) as ei:
        oa.DataLoader()._fetch_one("http://oa.local:5000", KEY, "X", "NSE", "D", "2025-04-01", "2025-04-02")
    return ei.value


def _no_key(exc):
    text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    assert KEY not in str(exc) and KEY not in text


def test_401_with_key_echo_redacted(monkeypatch):
    e = _fetch_one_err(monkeypatch, resp=FakeResp({"status": "error", "message": f"bad key {KEY}"}, status=401))
    _no_key(e)
    assert "401" in str(e)


def test_status_error_with_key_echo_redacted(monkeypatch):
    _no_key(_fetch_one_err(monkeypatch, resp=FakeResp({"status": "error", "message": f"invalid apikey {KEY}"})))


def test_status_missing(monkeypatch):
    _fetch_one_err(monkeypatch, resp=FakeResp({"data": []}))


def test_payload_not_dict(monkeypatch):
    _fetch_one_err(monkeypatch, resp=FakeResp(["x"]))


def test_non_json_200(monkeypatch):
    _no_key(_fetch_one_err(monkeypatch, resp=FakeResp(None, bad_json=True)))


def test_timeout(monkeypatch):
    _no_key(_fetch_one_err(monkeypatch, exc=httpx.ReadTimeout(f"timed out {KEY}")))


def test_connection_refused_redacted_no_chain(monkeypatch):
    e = _fetch_one_err(monkeypatch, exc=httpx.ConnectError(f"refused apikey={KEY}"))
    _no_key(e)
    assert e.__cause__ is None and e.__suppress_context__


def test_timeout_is_30s(env, monkeypatch):
    seen = {}
    real_init = httpx.Client.__init__

    def init(self, *a, **kw):
        seen["timeout"] = kw.get("timeout")
        real_init(self, *a, **kw)

    monkeypatch.setattr(httpx.Client, "__init__", init)
    patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02")
    assert seen["timeout"] == 30


def test_fetch_error_logs_without_key(env, monkeypatch, caplog):
    patch_post(monkeypatch, exc=httpx.ConnectError(f"refused {KEY}"))
    with caplog.at_level(logging.DEBUG):
        assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02") == {}
    assert KEY not in caplog.text


def test_one_of_two_failing(env, monkeypatch):
    patch_post(monkeypatch, by_symbol={
        "BAD": FakeResp({}, status=500),
        "GOOD": ok([row("2025-04-01 09:15:00+05:30")]),
    })
    out = oa.DataLoader().fetch(["BAD.NS", "GOOD.NS"], "2025-04-01", "2025-04-02")
    assert list(out) == ["GOOD.NS"]


# ---------- env ----------

@pytest.mark.parametrize("url,expected", [
    ("http://h:5000///", "http://h:5000/api/v1/history"),
    ("https://h/oa/", "https://h/oa/api/v1/history"),
    ("  http://h  ", "http://h/api/v1/history"),
])
def test_url_normalisation(monkeypatch, url, expected):
    monkeypatch.setenv("OPENALGO_URL", url)
    monkeypatch.setenv("OPENALGO_API_KEY", KEY)
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02")
    assert calls[0][0] == expected


def test_url_missing_scheme_no_raise(monkeypatch):
    monkeypatch.setenv("OPENALGO_URL", "oa.local:5000")
    monkeypatch.setenv("OPENALGO_API_KEY", KEY)
    assert oa.DataLoader().fetch(["X.NS"], "2025-04-01", "2025-04-02") == {}


@pytest.mark.parametrize("url,key", [(None, KEY), ("http://h", None), ("", KEY), ("http://h", "  "), (None, None)])
def test_missing_env_unavailable(monkeypatch, url, key):
    for name, val in (("OPENALGO_URL", url), ("OPENALGO_API_KEY", key)):
        if val is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, val)
    calls = patch_post(monkeypatch, ok([]))
    ld = oa.DataLoader()
    assert ld.is_available() is False
    assert ld.fetch(["X.NS"], "2025-04-01", "2025-04-02") == {}
    assert calls == []


def test_env_read_at_call_time(monkeypatch):
    monkeypatch.delenv("OPENALGO_URL", raising=False)
    monkeypatch.delenv("OPENALGO_API_KEY", raising=False)
    ld = oa.DataLoader()
    assert not ld.is_available()
    monkeypatch.setenv("OPENALGO_URL", "http://h")
    monkeypatch.setenv("OPENALGO_API_KEY", "K1")
    assert ld.is_available()
    calls = patch_post(monkeypatch, ok([row("2025-04-01 09:15:00+05:30")]))
    ld.fetch(["X.NS"], "2025-04-01", "2025-04-02")
    monkeypatch.setenv("OPENALGO_API_KEY", "K2")
    ld.fetch(["X.NS"], "2025-04-01", "2025-04-02")
    assert [b["apikey"] for _, b in calls] == ["K1", "K2"]


# ---------- registry / fallback ----------

def test_chains_openalgo_first():
    assert registry.FALLBACK_CHAINS["india_equity"][0] == "openalgo"
    assert registry.FALLBACK_CHAINS["crypto"][0] == "openalgo"


def test_resolve_falls_back_when_env_unset(monkeypatch):
    monkeypatch.delenv("OPENALGO_URL", raising=False)
    monkeypatch.delenv("OPENALGO_API_KEY", raising=False)
    calls = patch_post(monkeypatch, ok([]))
    try:
        loader = registry.resolve_loader("india_equity")
    except NoAvailableSourceError:
        loader = None
    assert loader is None or loader.name in ("yahoo", "yfinance", "india_broker", "local")
    assert calls == []


def test_resolve_picks_openalgo_when_env_set(env):
    assert registry.resolve_loader("india_equity").name == "openalgo"
    assert registry.resolve_loader("crypto").name == "openalgo"


@pytest.mark.parametrize("code,market", [
    ("BTCUSD@CRYPTO", "crypto"), ("btcusd@crypto", "crypto"),
    ("X@NSE", "india_equity"), ("X@BSE", "india_equity"), ("NIFTY25FUT@NFO", "india_equity"),
    ("X@BFO", "india_equity"), ("X@CDS", "india_equity"), ("X@BCD", "india_equity"),
    ("CRUDEOIL@MCX", "india_equity"), ("M&M@NSE", "india_equity"),
])
def test_market_detection(code, market):
    from vibe_bt.backtest.engines._market_hooks import matched_market
    assert matched_market(code) == market


def test_market_detection_unknown_exchange():
    from vibe_bt.backtest.engines._market_hooks import matched_market
    assert matched_market("X@XYZ") not in ("crypto", "india_equity")


# ---------- child cache ----------

def test_child_env_sets_xdg_cache(tmp_path):
    from bt_service.runner import _child_env
    assert _child_env(tmp_path)["XDG_CACHE_HOME"] == str(tmp_path / ".cache")


def test_child_env_without_run_dir_has_no_forced_cache(monkeypatch):
    from bt_service.runner import _child_env
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    assert "XDG_CACHE_HOME" not in _child_env()


def test_child_cache_setup_before_audit_hook(tmp_path, monkeypatch):
    import yfinance

    import bt_service._child as child
    seen = []
    monkeypatch.setattr(yfinance, "set_tz_cache_location", lambda p: seen.append(p))
    cache = child._setup_cache(tmp_path)
    assert cache == tmp_path / ".cache"
    assert cache.is_dir()
    assert len(seen) == 1 and Path(seen[0]).resolve().is_relative_to(cache.resolve())

    src = Path(child.__file__).read_text(encoding="utf-8")
    main = src[src.index('if __name__ == "__main__"'):]
    assert main.index("_setup_cache(") < main.index("_install_audit_hook(")
