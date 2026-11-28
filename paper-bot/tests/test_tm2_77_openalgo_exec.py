"""TM2-77: paper-bot execution through OpenAlgo's Analyzer (sandbox). Test writer's suite.

HARD RULE pinned here: never a live order. Every placeorder is preceded by a fresh analyzer check that returned a
real boolean `analyze_mode is True`; there are no retries; every failure fails closed.

No real network: the fake OpenAlgo is an httpx.MockTransport injected into `httpx.Client` (the only HTTP client
openalgo_exec uses), plus one real 127.0.0.1 thread server (real timeout / real wire) that is torn down in its
fixture. The fake COUNTS analyzer and placeorder calls and records them in order.

`paper_bot.openalgo_exec` is imported lazily (never at module top) so the sim byte-identity subprocess can import
this module and still prove sim never imports it.
"""
import asyncio
import dataclasses
import http.server
import json
import logging
import os
import re
import socket
import sqlite3
import subprocess
import sys
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from paper_bot import db as D
from paper_bot.config import Config
from paper_bot.engine import Engine
from paper_bot.web import create_app

P = 300
T0 = 1_700_000_000 - 1_700_000_000 % P
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PB_DIR = os.path.dirname(TESTS_DIR)

# Distinctive fake key (>= 16 chars as config requires after fix round 2). Never a real credential.
KEY = "OAK-zq7Xv9Lm2Pw4Rt6Yh8Jk3Nd5Bf1Gc0"
SIZES = (("BTCUSD", 0.001), ("ETHUSD", 0.01))

UP = [100.0, 100.0, 100.0, 200.0]     # fast 2 / slow 3: cross up   -> want long
DOWN = [100.0, 100.0, 100.0, 50.0]    # cross down -> want short (or flat without shorts)
NONE = [100.0, 100.0, 100.0, 100.0]   # no cross   -> hold, no order, no analyzer call
N_UP = 4999        # floor((1000 / (200 * 1.0002)) / 0.001)
N_DOWN = 20004     # floor((1000 / (50 * 0.9998)) / 0.001)


# ---------------------------------------------------------------- fake OpenAlgo ---------------------------------
def J(status, obj):
    return lambda req: httpx.Response(status, json=obj)


def RAW(status, text, ctype="text/html", headers=None):
    return lambda req: httpx.Response(status, content=text.encode(), headers={"content-type": ctype, **(headers or {})})


def RAISE(cls, msg="boom"):
    def f(req):
        raise cls(msg, request=req)
    return f


ON = J(200, {"status": "success", "data": {"analyze_mode": True, "mode": "analyze", "total_logs": 0}})
OFF = J(200, {"status": "success", "data": {"analyze_mode": False, "mode": "live", "total_logs": 0}})


def OK(oid="OA-1"):
    return J(200, {"status": "success", "orderid": oid})


class FakeOA:
    """In-process OpenAlgo. `aq`/`pq` are queues of responders for analyzer/placeorder; defaults when empty."""

    def __init__(self):
        self.log = []          # (endpoint, method, body, request)
        self.client_kwargs = []
        self.aq, self.pq = [], []
        self.analyzer, self.place = ON, OK()
        self.other = 0

    def handler(self, req):
        path = req.url.path
        body = json.loads(req.content) if req.content else None
        ep = path.split("/api/v1/", 1)[1] if "/api/v1/" in path else path
        self.log.append((ep, req.method, body, req))
        if ep == "analyzer":
            return (self.aq.pop(0) if self.aq else self.analyzer)(req)
        if ep == "placeorder":
            return (self.pq.pop(0) if self.pq else self.place)(req)
        self.other += 1
        return httpx.Response(404, json={"status": "error", "message": "no such endpoint"})

    def eps(self):
        return [e for e, *_ in self.log]

    @property
    def n_analyzer(self):
        return self.eps().count("analyzer")

    @property
    def n_place(self):
        return self.eps().count("placeorder")

    def assert_gated(self):
        """Every placeorder is IMMEDIATELY preceded by an analyzer call (fresh check, strict order)."""
        e = self.eps()
        for i, x in enumerate(e):
            if x == "placeorder":
                assert i > 0 and e[i - 1] == "analyzer", e
        assert self.n_analyzer >= self.n_place


_RealClient = httpx.Client


def install(fake):
    """Route every sync httpx.Client (openalgo_exec's only HTTP path) to the fake. Returns an undo function."""
    def factory(*a, **kw):
        fake.client_kwargs.append(dict(kw))
        return _RealClient(*a, transport=httpx.MockTransport(fake.handler), **kw)
    httpx.Client = factory

    def undo():
        httpx.Client = _RealClient
    return undo


@pytest.fixture
def fake():
    f = FakeOA()
    undo = install(f)
    yield f
    undo()


def ox_cfg(data_dir, **kw):
    base = dict(symbols=("BTCUSD",), fast=2, slow=3, data_dir=str(data_dir), execution="openalgo",
                openalgo_url="http://oa.test", openalgo_api_key=KEY, contract_sizes=SIZES, openalgo_timeout=2.0)
    base.update(kw)
    return Config(**base)


def candles(closes, k):
    return [{"time": T0 + (k + i) * P, "open": c, "high": c, "low": c, "close": c, "volume": 1.0}
            for i, c in enumerate(closes)]


class Bot:
    """Engine on a DATA_DIR, with a mock Delta candle feed. Step k shifts the candles so each step is a new candle."""

    def __init__(self, data_dir, **kw):
        self.cfg = ox_cfg(data_dir, **kw)
        self.cs = {}
        self.k = 0
        self.eng = self.conn = None

    def _feed(self, req):
        return httpx.Response(200, json={"success": True, "result": list(reversed(self.cs[req.url.params["symbol"]]))})

    def start(self):
        self.conn = D.connect(self.cfg.db_path)
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self._feed))
        try:
            self.eng = Engine(self.cfg, self.conn, self.client)
        except BaseException:
            self.conn.close()
            raise
        return self

    def tick(self, closes, k=None, extra=0):
        if k is None:
            self.k += 1
            k = self.k
        for s in self.cfg.symbols:
            self.cs[s] = candles(closes, k)
        asyncio.run(self.eng.tick(T0 + (k + 4) * P + 7 + extra))

    def stop(self):
        if self.conn:
            self.conn.close()
            self.conn = None

    # --- reads
    def last(self, sym="BTCUSD"):
        return D.rows(self.conn, "SELECT * FROM decisions WHERE symbol=? ORDER BY id DESC LIMIT 1", (sym,))[0]

    def trades(self):
        return D.rows(self.conn, "SELECT symbol, side, kind, qty FROM trades ORDER BY id")

    def pos(self):
        """Positions without the mark column (mark follows every candle; side/qty/entry/fee must not change)."""
        return D.rows(self.conn, "SELECT symbol, side, qty, entry, entry_fee FROM positions ORDER BY symbol")

    def state(self, prefix="openalgo"):
        return dict((r["key"], r["value"]) for r in
                    D.rows(self.conn, "SELECT key, value FROM state WHERE key LIKE ? ORDER BY key", (prefix + "%",)))


def operator_sql(sym):
    return f"DELETE FROM state WHERE key IN ('openalgo_unknown:{sym}','openalgo_inflight:{sym}')"


def run_operator_sql(db_path, reason, sym="BTCUSD"):
    """Take the SQL from the skip reason verbatim and run it like an operator would (separate connection)."""
    m = re.search(r"run: (DELETE FROM state WHERE key IN \([^)]*\))", reason)
    assert m and m.group(1) == operator_sql(sym), reason
    c = sqlite3.connect(db_path, isolation_level=None)
    c.execute(m.group(1))
    c.close()


# ============================================================ 1. startup =======================================
def test_startup_analyzer_on_starts(tmp_path, fake):
    b = Bot(tmp_path).start()
    assert fake.eps() == ["analyzer"] and fake.n_place == 0
    assert b.state() == {}
    b.stop()


BAD_ANALYZER = {
    "off": OFF,
    "off_string_false": J(200, {"status": "success", "data": {"analyze_mode": "false"}}),
    "string_true": J(200, {"status": "success", "data": {"analyze_mode": "true"}}),
    "int_1": J(200, {"status": "success", "data": {"analyze_mode": 1}}),
    "null": J(200, {"status": "success", "data": {"analyze_mode": None}}),
    "nested": J(200, {"status": "success", "data": {"data": {"analyze_mode": True}}}),
    "top_level": J(200, {"status": "success", "analyze_mode": True}),
    "missing_data": J(200, {"status": "success"}),
    "list_data": J(200, {"status": "success", "data": [{"analyze_mode": True}]}),
    "200_status_error": J(200, {"status": "error", "message": "x", "data": {"analyze_mode": True}}),
    "no_status": J(200, {"data": {"analyze_mode": True}}),
    "list_body": J(200, [{"status": "success", "data": {"analyze_mode": True}}]),
    "non_json": RAW(200, "<html>analyze_mode true</html>"),
    "http_500_claims_true": J(500, {"status": "success", "data": {"analyze_mode": True}}),
    "redirect_307": RAW(307, "", headers={"location": "http://evil.test/api/v1/analyzer"}),
    "connect_error": RAISE(httpx.ConnectError),
    "timeout": RAISE(httpx.ReadTimeout),
}


@pytest.mark.parametrize("case", sorted(BAD_ANALYZER))
def test_startup_refuses_when_analyzer_not_on(tmp_path, fake, case):
    fake.analyzer = BAD_ANALYZER[case]
    with pytest.raises(RuntimeError) as ei:
        Bot(tmp_path).start()
    msg = str(ei.value)
    assert "EXECUTION=openalgo refused to start" in msg
    if case == "off":
        assert "analyzer is OFF" in msg
    assert fake.n_place == 0
    assert fake.eps() == ["analyzer"]  # exactly one check; redirect NOT followed, no retry
    assert all(kw.get("follow_redirects") is False for kw in fake.client_kwargs)


def test_app_lifespan_refuses_to_start_when_analyzer_off(tmp_path, fake):
    fake.analyzer = OFF
    cfg = ox_cfg(tmp_path)
    feed = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    app = create_app(cfg, D.connect(cfg.db_path), client=feed, run_loop=True)
    with pytest.raises(RuntimeError, match="refused to start"):
        with TestClient(app):
            pass
    assert fake.n_place == 0


def base_env(tmp_path, **kw):
    e = {"EXECUTION": "openalgo", "OPENALGO_URL": "http://oa.test", "OPENALGO_API_KEY": KEY,
         "CONTRACT_SIZES": "BTCUSD:0.001,ETHUSD:0.01", "SYMBOLS": "BTCUSD,ETHUSD", "DATA_DIR": str(tmp_path)}
    e.update(kw)
    return {k: v for k, v in e.items() if v is not None}


def test_config_from_env_ok(tmp_path):
    c = Config.from_env(base_env(tmp_path, OPENALGO_URL="http://oa.test/pfx//"))
    assert c.execution == "openalgo" and c.openalgo_url == "http://oa.test/pfx"
    assert c.contract_sizes == (("BTCUSD", 0.001), ("ETHUSD", 0.01))
    assert c.openalgo_symbol_suffix == "FUT" and c.openalgo_timeout == 10.0


@pytest.mark.parametrize("over, match", [
    ({"OPENALGO_URL": None}, "OPENALGO_URL is required"),
    ({"OPENALGO_URL": "oa.test"}, "OPENALGO_URL is required"),
    ({"OPENALGO_API_KEY": None}, "OPENALGO_API_KEY is required"),
    ({"OPENALGO_API_KEY": KEY + " "}, "OPENALGO_API_KEY"),
    ({"CONTRACT_SIZES": None}, "CONTRACT_SIZES has no size for BTCUSD"),
    ({"CONTRACT_SIZES": "BTCUSD:0.001"}, "CONTRACT_SIZES has no size for ETHUSD"),
    ({"CONTRACT_SIZES": "BTCUSD:0,ETHUSD:0.01"}, "CONTRACT_SIZES entry"),
    ({"CONTRACT_SIZES": "BTCUSD:-1,ETHUSD:0.01"}, "CONTRACT_SIZES entry"),
    ({"CONTRACT_SIZES": "BTCUSD:nan,ETHUSD:0.01"}, "CONTRACT_SIZES entry"),
    ({"CONTRACT_SIZES": "BTCUSD:abc,ETHUSD:0.01"}, "CONTRACT_SIZES entry"),
    ({"CONTRACT_SIZES": "BTCUSD,ETHUSD:0.01"}, "CONTRACT_SIZES entry"),
    ({"CONTRACT_SIZES": "BTCUSD:1,BTCUSD:2,ETHUSD:0.01"}, "CONTRACT_SIZES entry"),
    ({"EXECUTION": "live"}, "EXECUTION='live' must be one of sim, openalgo"),
    ({"EXECUTION": "openalgo-live"}, "EXECUTION="),
    ({"OPENALGO_TIMEOUT": "0"}, "OPENALGO_TIMEOUT"),
    ({"OPENALGO_TIMEOUT": "61"}, "OPENALGO_TIMEOUT"),
    ({"OPENALGO_TIMEOUT": "x"}, "OPENALGO_TIMEOUT"),
])
def test_config_validation_refuses(tmp_path, over, match):
    with pytest.raises(ValueError, match="invalid config") as ei:
        Config.from_env(base_env(tmp_path, **over))
    assert match in str(ei.value)
    assert_no_key(str(ei.value))


@pytest.mark.parametrize("short", [KEY[:15], KEY[:8], "k", "abcdefghijklmno"])
def test_config_refuses_short_api_key_without_echo(tmp_path, short):
    """Fix round 2: OPENALGO_API_KEY shorter than 16 chars is refused; the error never echoes it."""
    assert len(short) < 16
    with pytest.raises(ValueError, match="invalid config") as ei:
        Config.from_env(base_env(tmp_path, OPENALGO_API_KEY=short))
    assert "OPENALGO_API_KEY" in str(ei.value)
    assert short not in str(ei.value).replace("OPENALGO_API_KEY", "")
    assert ox_cfg(tmp_path, openalgo_api_key=short).openalgo_problems()  # direct Config too (Engine path)


def test_config_accepts_16_char_key(tmp_path):
    assert Config.from_env(base_env(tmp_path, OPENALGO_API_KEY=KEY[:16])).openalgo_api_key == KEY[:16]


def test_engine_refuses_direct_config_without_sizes_before_any_http(tmp_path, fake):
    for cfg in (ox_cfg(tmp_path, contract_sizes=()), ox_cfg(tmp_path, openalgo_url=""),
                ox_cfg(tmp_path, openalgo_api_key="")):
        with pytest.raises(ValueError, match="invalid config"):
            Engine(cfg, D.connect(cfg.db_path), None)
    assert fake.log == []


# ============================================================ 2. per order =====================================
def test_analyzer_rechecked_before_every_placeorder(tmp_path, fake):
    b = Bot(tmp_path).start()
    b.tick(UP)            # open long
    b.tick(NONE)          # hold: no order, no check
    b.tick(DOWN)          # reverse: 2 legs
    b.tick(DOWN, k=b.k)   # same candle: already processed
    b.tick(UP)            # reverse back
    fake.assert_gated()
    assert fake.eps() == ["analyzer"] + ["analyzer", "placeorder"] * 5
    assert [t["kind"] for t in b.trades()] == ["open", "close", "open", "close", "open"]
    b.stop()


@pytest.mark.parametrize("mid", ["off", "string_true", "int_1", "null", "200_status_error", "http_500_claims_true",
                                 "redirect_307", "timeout", "connect_error", "non_json"])
def test_analyzer_off_or_bad_mid_run_refuses_order(tmp_path, fake, mid):
    b = Bot(tmp_path).start()
    b.tick(UP)
    pos_before, trades_before = b.pos(), b.trades()
    assert fake.n_place == 1
    fake.analyzer = BAD_ANALYZER[mid]
    b.tick(DOWN)
    d = b.last()
    assert d["action"] == "skip"
    if mid == "off":
        assert "openalgo analyzer off: order refused" in d["reason"]
    else:
        assert "analyzer check failed" in d["reason"] and "order refused" in d["reason"]
    assert fake.n_place == 1 and b.pos() == pos_before and b.trades() == trades_before
    assert b.state("openalgo_unknown") == {} and b.state("openalgo_inflight") == {}  # refused != halted
    fake.analyzer = ON
    b.tick(DOWN)  # new candle, analyzer back on: trading resumes
    assert b.last()["action"] == "reverse" and fake.n_place == 3
    fake.assert_gated()
    b.stop()


# ============================================================ 3. placeorder outcomes ===========================
def test_place_success_records_orderid(tmp_path, fake):
    fake.place = OK("SB-42")
    b = Bot(tmp_path).start()
    b.tick(UP)
    d = b.last()
    assert d["action"] == "open"
    assert "[openalgo order SB-42; fill modelled from candle close]" in d["reason"]
    assert f"open long {N_UP} contracts" in d["reason"]
    assert b.trades() == [{"symbol": "BTCUSD", "side": "buy", "kind": "open", "qty": pytest.approx(N_UP * 0.001)}]
    assert b.state() == {"openalgo_order:SB-42": f"BTCUSD BUY {N_UP}"}  # inflight marker cleared
    b.tick(UP, k=b.k, extra=5)
    b.tick(NONE)
    assert fake.n_place == 1
    b.stop()


DEFINITE = {
    "400_json_error": J(400, {"status": "error", "message": "Insufficient funds"}),
    "429_json_error": J(429, {"status": "error", "message": "rate limited"}),
    "200_status_error": J(200, {"status": "error", "message": "bad symbol"}),
    "connect_refused": RAISE(httpx.ConnectError, "refused"),
}


@pytest.mark.parametrize("case", sorted(DEFINITE))
def test_place_definite_reject_skips_not_halted(tmp_path, fake, case):
    fake.place = DEFINITE[case]
    b = Bot(tmp_path).start()
    b.tick(UP)
    d = b.last()
    assert d["action"] == "skip" and "open long not executed" in d["reason"]
    assert ("order not sent" if case == "connect_refused" else "rejected by openalgo") in d["reason"]
    assert b.pos() == [] and b.trades() == [] and b.state() == {}
    b.tick(UP, k=b.k, extra=5)  # same candle again: no retry
    b.tick(NONE)
    assert fake.n_place == 1
    fake.place = OK("OA-2")
    b.tick(UP)                  # not halted: a new signal trades
    assert b.last()["action"] == "open" and fake.n_place == 2
    fake.assert_gated()
    b.stop()


UNKNOWN = {
    "timeout": RAISE(httpx.ReadTimeout, "read timed out"),
    "write_timeout": RAISE(httpx.WriteTimeout, "write timed out"),
    "remote_protocol_error": RAISE(httpx.RemoteProtocolError, "server hung up"),
    "500_json_error": J(500, {"status": "error", "message": "internal"}),
    "502_html": RAW(502, "<html>bad gateway</html>"),
    "200_non_json": RAW(200, "ok!"),
    "success_no_orderid": J(200, {"status": "success"}),
    "success_empty_orderid": J(200, {"status": "success", "orderid": "  "}),
    "orderid_bool": J(200, {"status": "success", "orderid": True}),
    "orderid_list": J(200, {"status": "success", "orderid": ["1"]}),
    "orderid_null": J(200, {"status": "success", "orderid": None}),
}


@pytest.mark.parametrize("case", sorted(UNKNOWN))
def test_place_unknown_halts_until_operator_sql(tmp_path, fake, case):
    fake.place = UNKNOWN[case]
    b = Bot(tmp_path).start()
    b.tick(UP)
    d = b.last()
    assert d["action"] == "skip" and "order outcome unknown, not retried" in d["reason"]
    assert b.pos() == [] and b.trades() == []
    st = b.state()
    assert set(st) == {"openalgo_unknown:BTCUSD"}
    fake.place = OK("OA-9")  # even a healthy server gets no order while halted
    b.tick(UP, k=b.k, extra=5)
    for closes in (DOWN, UP, DOWN):
        b.tick(closes)
        d = b.last()
        assert d["action"] == "skip" and operator_sql("BTCUSD") in d["reason"]
        assert "check the OpenAlgo orderbook/positions" in d["reason"]
    assert fake.n_place == 1 and b.pos() == []
    run_operator_sql(b.cfg.db_path, d["reason"])
    b.tick(UP)  # no restart needed
    assert b.last()["action"] == "open" and fake.n_place == 2 and b.state() == {"openalgo_order:OA-9": f"BTCUSD BUY {N_UP}"}
    fake.assert_gated()
    b.stop()


def test_halt_survives_restart(tmp_path, fake):
    fake.place = UNKNOWN["timeout"]
    b = Bot(tmp_path).start()
    b.tick(UP)
    b.stop()
    fake.place = OK()
    b2 = Bot(tmp_path).start()
    b2.k = 1
    b2.tick(UP)
    assert b2.last()["action"] == "skip" and operator_sql("BTCUSD") in b2.last()["reason"]
    assert fake.n_place == 1
    b2.stop()


# ============================================================ real 127.0.0.1 server ===========================
class _Srv(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


@pytest.fixture
def real_oa():
    """Real HTTP OpenAlgo on 127.0.0.1:<ephemeral>. placeorder can be told to stall (released on teardown)."""
    st = {"log": [], "stall": 0.0, "stop": threading.Event()}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n))
            st["log"].append((self.path, self.command, self.headers.get("content-type"), body))
            if self.path.endswith("/analyzer"):
                out = {"status": "success", "data": {"analyze_mode": True, "mode": "analyze", "total_logs": 0}}
            else:
                if st["stall"]:
                    st["stop"].wait(st["stall"])
                out = {"status": "success", "orderid": "REAL-1"}
            data = json.dumps(out).encode()
            try:
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                pass

    srv = _Srv(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    st["url"] = f"http://127.0.0.1:{srv.server_address[1]}"
    yield st
    st["stop"].set()
    srv.shutdown()
    srv.server_close()
    t.join(5)


def test_real_server_wire_and_success(tmp_path, real_oa):
    b = Bot(tmp_path, openalgo_url=real_oa["url"] + "/").start()
    b.tick(UP)
    assert [x[0] for x in real_oa["log"]] == ["/api/v1/analyzer", "/api/v1/analyzer", "/api/v1/placeorder"]
    assert all(x[1] == "POST" and x[2] == "application/json" for x in real_oa["log"])
    assert real_oa["log"][2][3] == {"strategy": "paper-bot", "symbol": "BTCUSDFUT", "exchange": "CRYPTO",
                                    "action": "BUY", "pricetype": "MARKET", "product": "NRML",
                                    "quantity": N_UP, "apikey": KEY}
    assert "REAL-1" in b.last()["reason"]
    b.stop()


def test_real_server_timeout_is_unknown_and_halts(tmp_path, real_oa):
    real_oa["stall"] = 3.0
    b = Bot(tmp_path, openalgo_url=real_oa["url"], openalgo_timeout=0.3).start()
    b.tick(UP)
    d = b.last()
    assert d["action"] == "skip" and "request timeout after 0.3s" in d["reason"]
    assert "openalgo_unknown:BTCUSD" in b.state()
    real_oa["stall"] = 0
    b.tick(DOWN)
    assert [x[0] for x in real_oa["log"]].count("/api/v1/placeorder") == 1
    b.stop()


def test_real_connect_refused_startup(tmp_path):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    with pytest.raises(RuntimeError, match="refused to start: analyzer status check failed"):
        Bot(tmp_path, openalgo_url=f"http://127.0.0.1:{port}").start()


# ============================================================ 4. crash window =================================
def _patch_call(monkeypatch, when):
    from paper_bot import openalgo_exec as OX
    orig = OX.OpenAlgoExec._call

    def _call(self, ep, body):
        if ep == "placeorder" and when == "before":
            raise KeyboardInterrupt  # crash after the marker commit, before the HTTP call
        r = orig(self, ep, body)
        if ep == "placeorder" and when == "after":
            raise KeyboardInterrupt  # crash after the POST reached the server, before the result rows
        return r
    monkeypatch.setattr(OX.OpenAlgoExec, "_call", _call)


@pytest.mark.parametrize("when", ["after", "before"])
def test_crash_in_send_path_never_resends(tmp_path, fake, monkeypatch, when):
    _patch_call(monkeypatch, when)
    b = Bot(tmp_path).start()
    with pytest.raises(KeyboardInterrupt):
        b.tick(UP)
    assert fake.n_place == (1 if when == "after" else 0)
    b.stop()
    monkeypatch.undo()  # restores _call only; the fake fixture keeps routing httpx.Client
    b2 = Bot(tmp_path).start()  # restart on the same DATA_DIR
    b2.k = 1
    b2.tick(UP, extra=30)  # the same candle again
    b2.tick(UP)            # and a fresh signal
    b2.tick(DOWN)
    assert fake.n_place == (1 if when == "after" else 0)  # no second order for that candle, ever
    st = b2.state()
    assert st.get("openalgo_inflight:BTCUSD") == f"candle {T0 + 4 * P} BUY {N_UP}"
    assert "openalgo_unknown:BTCUSD" in st
    assert b2.pos() == [] and b2.trades() == []
    d = b2.last()
    assert d["action"] == "skip" and operator_sql("BTCUSD") in d["reason"]
    run_operator_sql(b2.cfg.db_path, d["reason"])
    b2.tick(UP)
    assert b2.last()["action"] == "open" and fake.n_place == (2 if when == "after" else 1)
    fake.assert_gated()
    b2.stop()


HARD_KILL = r"""
import json, os, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
import test_tm2_77_openalgo_exec as T
from paper_bot import openalgo_exec as OX
fake = T.FakeOA(); T.install(fake)
when = sys.argv[4]
orig = OX.OpenAlgoExec._call
def _call(self, ep, body):
    if ep == "placeorder" and when == "before":
        print(json.dumps(fake.eps())); sys.stdout.flush(); os._exit(17)
    r = orig(self, ep, body)
    if ep == "placeorder":
        print(json.dumps(fake.eps())); sys.stdout.flush(); os._exit(17)
    return r
OX.OpenAlgoExec._call = _call
b = T.Bot(sys.argv[3]).start()
b.tick(T.UP)
print("NOT KILLED")
"""


@pytest.mark.parametrize("when", ["after", "before"])
def test_hard_kill_around_send_never_resends(tmp_path, fake, when):
    """os._exit (no cleanup at all, like SIGKILL / power loss) right after or right before the POST."""
    r = subprocess.run([sys.executable, "-c", HARD_KILL, PB_DIR, TESTS_DIR, str(tmp_path), when],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 17, r.stderr
    sent = json.loads(r.stdout.strip().splitlines()[-1])
    assert sent == (["analyzer", "analyzer", "placeorder"] if when == "after" else ["analyzer", "analyzer"])
    b = Bot(tmp_path).start()
    b.k = 1
    b.tick(UP, extra=30)
    b.tick(UP)
    assert fake.n_place == 0
    assert "openalgo_inflight:BTCUSD" in b.state()
    d = b.last()
    assert d["action"] == "skip" and operator_sql("BTCUSD") in d["reason"]
    run_operator_sql(b.cfg.db_path, d["reason"])
    b.tick(UP)
    assert b.last()["action"] == "open" and fake.n_place == 1
    b.stop()


# ============================================================ 5. reverse =======================================
def test_reverse_two_gated_legs(tmp_path, fake):
    fake.place = OK("O-1")
    b = Bot(tmp_path).start()
    b.tick(UP)
    fake.pq = [OK("C-2"), OK("O-3")]
    b.tick(DOWN)
    d = b.last()
    assert d["action"] == "reverse" and "[order C-2]" in d["reason"] and "openalgo order O-3" in d["reason"]
    places = [x[2] for x in fake.log if x[0] == "placeorder"]
    assert [(p["action"], p["quantity"]) for p in places] == [("BUY", N_UP), ("SELL", N_UP), ("SELL", N_DOWN)]
    assert fake.eps()[-4:] == ["analyzer", "placeorder", "analyzer", "placeorder"]
    assert b.pos()[0]["side"] == "short" and b.pos()[0]["qty"] == pytest.approx(N_DOWN * 0.001)
    b.stop()


def test_reverse_close_refused_nothing_opens(tmp_path, fake):
    b = Bot(tmp_path).start()
    b.tick(UP)
    before = b.pos()
    fake.aq = [OFF]
    b.tick(DOWN)
    assert b.last()["action"] == "skip" and "close long not executed: openalgo analyzer off" in b.last()["reason"]
    assert fake.n_place == 1 and b.pos() == before and len(b.trades()) == 1
    b.stop()


def test_reverse_close_ok_open_refused_by_second_gate(tmp_path, fake):
    b = Bot(tmp_path).start()
    b.tick(UP)
    fake.aq = [ON, OFF]
    b.tick(DOWN)
    d = b.last()
    assert d["action"] == "close" and "open short not executed: openalgo analyzer off" in d["reason"]
    assert fake.n_place == 2 and b.pos() == [] and b.state("openalgo_unknown") == {}
    assert b.state("openalgo_inflight") == {}
    b.stop()


def test_reverse_close_ok_open_unknown_halts(tmp_path, fake):
    b = Bot(tmp_path).start()
    b.tick(UP)
    fake.pq = [OK("C-2"), UNKNOWN["timeout"]]
    b.tick(DOWN)
    d = b.last()
    assert d["action"] == "close" and "open short not executed: order outcome unknown" in d["reason"]
    assert b.pos() == [] and [t["kind"] for t in b.trades()] == ["open", "close"]
    assert "openalgo_unknown:BTCUSD" in b.state()
    fake.place = OK()
    b.tick(UP)
    b.tick(DOWN)
    assert fake.n_place == 3 and b.last()["action"] == "skip"
    b.stop()


# ============================================================ 6. quantity ======================================
@pytest.mark.parametrize("size, n", [(0.001, N_UP), (0.01, 499), (0.1, 49), (1.0, 4), (3.0, 1), (4.999, 1)])
def test_quantity_floor_units_over_size(tmp_path, fake, size, n):
    b = Bot(tmp_path, contract_sizes=(("BTCUSD", size),)).start()
    b.tick(UP)
    [p] = [x[2] for x in fake.log if x[0] == "placeorder"]
    assert p["quantity"] == n and type(p["quantity"]) is int
    assert b.pos()[0]["qty"] == pytest.approx(n * size)
    b.stop()


def test_zero_contracts_skips_without_any_call(tmp_path, fake):
    b = Bot(tmp_path, contract_sizes=(("BTCUSD", 5.0),)).start()
    b.tick(UP)
    d = b.last()
    assert d["action"] == "skip" and "is below one contract (size 5)" in d["reason"]
    assert fake.eps() == ["analyzer"] and b.pos() == [] and b.state() == {}
    b.stop()


def test_contracts_for():
    from paper_bot.openalgo_exec import contracts_for
    assert contracts_for(4.999, 0.001) == 4999
    assert contracts_for(0.003, 0.001) == 3 and contracts_for(0.3, 0.1) == 3 and contracts_for(3 * 0.1, 0.1) == 3
    assert contracts_for(0.9999, 1) == 0 and contracts_for(1.9999, 1) == 1
    for bad in (0, -1, float("nan"), float("inf")):
        assert contracts_for(bad, 0.001) == 0


@pytest.mark.parametrize("side, qty", [("BUY", True), ("BUY", False), ("BUY", 1.0), ("BUY", "1"), ("BUY", -1),
                                       ("BUY", 0), ("buy", 1), ("SHORT", 1), ("BUY", None)])
def test_place_rejects_bad_args_before_any_call(tmp_path, fake, side, qty):
    from paper_bot.openalgo_exec import OpenAlgoExec
    r = OpenAlgoExec(ox_cfg(tmp_path)).place("BTCUSD", side, qty)
    assert r.status == "refused" and "invalid order" in r.reason
    assert fake.log == []


# ============================================================ 7. sim -> openalgo ==============================
def test_sim_opened_position_refuses_openalgo_start(tmp_path, fake):
    sim = Bot(tmp_path, execution="sim").start()
    sim.tick(UP)
    assert sim.pos()[0]["qty"] == pytest.approx(1000 / 200.04)
    sim.stop()
    assert fake.log == []
    with pytest.raises(RuntimeError, match="fresh DATA_DIR") as ei:
        Bot(tmp_path).start()
    assert "BTCUSD" in str(ei.value) and "not a whole number of contracts" in str(ei.value)
    assert fake.log == []  # refused before even asking the analyzer


def _seed_position(data_dir, sym, qty):
    c = D.connect(os.path.join(str(data_dir), "paper.db"))
    c.execute("INSERT INTO positions VALUES(?,?,?,?,?,?)", (sym, "long", qty, 100.0, 0.1, 100.0))
    c.close()


@pytest.mark.parametrize("size, n", [(0.001, 3), (0.001, 1), (0.1, 3), (0.01, 7), (1.0, 2), (0.001, N_UP)])
def test_whole_multiple_position_starts(tmp_path, fake, size, n):
    _seed_position(tmp_path, "BTCUSD", n * size)
    b = Bot(tmp_path, contract_sizes=(("BTCUSD", size),)).start()
    assert fake.eps() == ["analyzer"]
    b.tick(DOWN)  # closes exactly n contracts
    q = [x[2]["quantity"] for x in fake.log if x[0] == "placeorder"]
    assert q[0] == n
    b.stop()


@pytest.mark.parametrize("contracts", [2.9999995, 3.0000005, 2.5, 0.5, 0.0005])
def test_non_multiple_position_refused(tmp_path, fake, contracts):
    """Fix round 2: tolerance is 1e-9, so 2.9999995 contracts is refused (8339cf7 used 1e-6 and accepted it)."""
    _seed_position(tmp_path, "BTCUSD", contracts * 0.001)
    with pytest.raises(RuntimeError, match="fresh DATA_DIR"):
        Bot(tmp_path).start()
    assert fake.log == []


def test_position_for_symbol_without_size_refused(tmp_path, fake):
    _seed_position(tmp_path, "SOLUSD", 1.0)
    with pytest.raises(RuntimeError, match="fresh DATA_DIR"):
        Bot(tmp_path).start()
    assert fake.log == []


# ============================================================ 8. API key secrecy ==============================
FRAGS = sorted({KEY[:n] for n in range(8, len(KEY) + 1)} | {KEY[-n:] for n in range(8, len(KEY) + 1)}, key=len)


def leaks(text):
    return [f for f in FRAGS if f in text]


def assert_no_key(text):
    assert leaks(text) == [], leaks(text)[-1:]


def test_redact_full_key_at_any_length(tmp_path):
    """Fix round 2: the FULL key is always removed, whatever its length (also below the 8-char fragment floor)."""
    from paper_bot.openalgo_exec import OpenAlgoExec
    ox = OpenAlgoExec(ox_cfg(tmp_path))
    for k in ("k", "k3y", "abc1234", "abcd1234", KEY[:15], KEY):
        ox._key = k
        out = ox.redact(f"x{k}y {k}{k} z")
        assert k not in out and out.count("[REDACTED]") >= 3, (k, out)
    ox._key = KEY
    for s in (KEY, KEY[:8], KEY[-8:], KEY[:20] + "!", "!" + KEY[-20:], ("A" * 110) + KEY):
        assert_no_key(ox.redact(s))


@pytest.mark.parametrize("pad", [110, 115, 119])
def test_key_straddling_120_char_cut_never_leaks(tmp_path, fake, pad):
    """Fix round 1: redact BEFORE truncating. The message is cut at 120 chars; the key starts at `pad`."""
    fake.place = J(400, {"status": "error", "message": ("A" * pad) + KEY + " tail"})
    b = Bot(tmp_path).start()
    b.tick(UP)
    d = b.last()
    assert d["action"] == "skip" and "rejected by openalgo" in d["reason"]
    assert_no_key(d["reason"])
    assert_no_key("\n".join(b.conn.iterdump()))
    b.stop()


def test_api_key_never_leaks(tmp_path, fake, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    b = Bot(tmp_path)
    # startup refusal whose server message echoes the key
    fake.aq = [J(500, {"status": "error", "message": f"bad apikey {KEY}"}),
               J(200, {"status": "error", "message": f"{KEY[:12]}...{KEY[-12:]}"})]
    errs = []
    for _ in range(2):
        with pytest.raises(RuntimeError) as ei:
            b.start()
        errs.append(str(ei.value))
    b.start()
    msgs = [f"invalid apikey {KEY}", f"{KEY} and again {KEY}", f"prefix {KEY[:12]}", f"suffix {KEY[-9:]}"]
    msgs += [("A" * pad) + KEY + " tail" for pad in (110, 115, 119, 100, 105)]
    for m in msgs:
        fake.pq = [J(400, {"status": "error", "message": m})]
        b.tick(UP)
        assert b.last()["action"] == "skip"
    # analyzer mid-run error echo
    fake.aq = [J(400, {"status": "error", "message": f"key {KEY} not allowed"})]
    b.tick(UP)
    assert "analyzer check failed" in b.last()["reason"]
    # orderid echoes (short and across the 64-char cut)
    fake.pq = [OK(f"OID-{KEY}")]
    b.tick(UP)
    assert b.last()["action"] == "open"
    fake.pq = [OK(("X" * 58) + KEY), J(500, {"status": "error", "message": ("B" * 110) + KEY})]
    b.tick(DOWN)  # close ok (orderid echo), open unknown (5xx echo) -> halted, reason stored in state
    assert "openalgo_unknown:BTCUSD" in b.state()
    b.tick(UP)
    assert fake.n_place == len(msgs) + 3
    assert any("[REDACTED]" in x["reason"] for x in D.rows(b.conn, "SELECT reason FROM decisions"))

    texts = errs + [caplog.text] + [r.getMessage() for r in caplog.records]
    out, err = capfd.readouterr()
    texts += [out, err]
    texts += list(b.conn.iterdump())
    for t in ("decisions", "trades", "positions", "equity", "state"):
        texts.append(json.dumps(D.rows(b.conn, f"SELECT * FROM {t}")))
    texts += [repr(b.cfg), str(b.cfg), repr(b.eng.ox), str(b.eng.ox), repr(b.eng)]
    app = create_app(b.cfg, b.conn, run_loop=False)
    with TestClient(app) as c:
        for u in ("/", "/?symbol=BTCUSD&action=skip", "/?action=open", "/api/decisions?limit=500", "/api/trades",
                  "/api/trades.csv", "/api/decisions.csv", "/api/positions", "/api/equity", "/api/summary",
                  "/healthz"):
            r = c.get(u)
            assert r.status_code == 200
            texts.append(r.text)
    b.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    for fn in os.listdir(tmp_path):
        texts.append(open(os.path.join(tmp_path, fn), "rb").read().decode("latin-1"))
    for t in texts:
        assert_no_key(t)
    assert KEY not in repr(b.cfg) and KEY not in str(b.cfg)
    # positive control: the key IS on the wire, in the body only
    assert all(x[2]["apikey"] == KEY for x in fake.log)
    assert all(KEY not in str(x[3].url) and all(KEY not in v for v in x[3].headers.values()) for x in fake.log)
    b.stop()


# ============================================================ 9. mirroring trade-mcp ==========================
def test_request_shapes_mirror_trade_mcp(tmp_path, fake):
    """Expected shapes hard-coded from trade-mcp/src/openalgo/client.ts + types.ts + sdk/bindings.ts + sdk/api-docs.ts.
    - client.ts:21     base URL trailing slashes stripped
    - client.ts:63-66  POST `${base}/api/v1/${endpoint}`, Content-Type application/json, body {...body, apikey}
    - client.ts:113    analyzerStatus = call("analyzer", {})
    - client.ts:114    placeOrder = call("placeorder", PlaceOrderRequest)
    - types.ts:25-33   PlaceOrderRequest: symbol, exchange, strategy, action, pricetype, product, quantity: number
    - bindings.ts:276-286 toWire: strategy/symbol/exchange/action/pricetype/product/quantity (no price for MARKET)
    - api-docs.ts:9    exchange "CRYPTO";  api-docs.ts:10  perpetual = Delta symbol + "FUT";  api-docs.ts:11  NRML
    """
    b = Bot(tmp_path, openalgo_url="http://oa.test/pfx///", symbols=("BTCUSD", "ETHUSD")).start()
    b.tick(UP)
    b.tick(DOWN)
    assert len(fake.log) == 1 + 2 * 2 + 2 * 4
    for ep, method, body, req in fake.log:
        assert method == "POST"
        assert str(req.url) == f"http://oa.test/pfx/api/v1/{ep}"
        assert req.headers["content-type"] == "application/json"
        assert req.url.query == b""
        if ep == "analyzer":
            assert body == {"apikey": KEY}
        else:
            assert ep == "placeorder"
            assert set(body) == {"strategy", "symbol", "exchange", "action", "pricetype", "product", "quantity",
                                 "apikey"}
            assert body["strategy"] == "paper-bot" and body["exchange"] == "CRYPTO" and body["product"] == "NRML"
            assert body["pricetype"] == "MARKET" and body["action"] in ("BUY", "SELL")
            assert body["symbol"] in ("BTCUSDFUT", "ETHUSDFUT") and body["apikey"] == KEY
            assert type(body["quantity"]) is int and body["quantity"] > 0
    places = [x[2] for x in fake.log if x[0] == "placeorder"]
    assert places[0] == {"strategy": "paper-bot", "symbol": "BTCUSDFUT", "exchange": "CRYPTO", "action": "BUY",
                         "pricetype": "MARKET", "product": "NRML", "quantity": N_UP, "apikey": KEY}
    assert places[1]["symbol"] == "ETHUSDFUT" and places[1]["quantity"] == 499
    assert fake.client_kwargs[0] == {"timeout": 2.0, "follow_redirects": False}
    fake.assert_gated()
    b.stop()


# ============================================================ 10. sim byte-identity ===========================
def sim_fixture_dump(cfg):
    """2 symbols, 5 steps: open long/short, already-processed hold, reverse, data error 500, reverse, hold."""
    state = {"cs": {}, "err": set()}

    def handler(req):
        sym = req.url.params["symbol"]
        if sym in state["err"]:
            return httpx.Response(500)
        return httpx.Response(200, json={"success": True, "result": list(reversed(state["cs"][sym]))})

    conn = D.connect(cfg.db_path)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    eng = Engine(cfg, conn, client)
    steps = [
        ({"BTCUSD": [100.0, 100.0, 100.0, 200.0], "ETHUSD": [50.0, 50.0, 50.0, 25.0]}, set()),
        ({"BTCUSD": [100.0, 100.0, 100.0, 200.0], "ETHUSD": [50.0, 50.0, 50.0, 25.0]}, set()),
        ({"BTCUSD": [100.0, 100.0, 100.0, 50.0], "ETHUSD": [50.0, 50.0, 50.0, 50.0]}, set()),
        ({"BTCUSD": [100.0, 100.0, 100.0, 50.0], "ETHUSD": [50.0, 50.0, 50.0, 100.0]}, {"BTCUSD"}),
        ({"BTCUSD": [200.0, 200.0, 200.0, 200.0], "ETHUSD": [100.0, 100.0, 100.0, 300.0]}, set()),
    ]
    for k, (closes, err) in enumerate(steps):
        state["cs"] = {s: candles(c, k) for s, c in closes.items()}
        state["err"] = err
        asyncio.run(eng.tick(T0 + (k + 4) * P + 7))
    asyncio.run(client.aclose())
    out = db_values(conn)
    conn.close()
    return out


def db_values(conn):
    """Version-independent exact snapshot: schema SQL (whitespace-normalised) and every table's rows as Python
    values (ints/floats/str/None, never stringified), ordered by rowid or the PK. JSON round-trips floats exactly."""
    schema = [[t, n, tb, " ".join(sql.split())] for t, n, tb, sql in conn.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").fetchall()]
    order = {"positions": "symbol", "state": "key"}
    tables = {}
    for (t,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
        tables[t] = [list(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY {order.get(t, 'rowid')}").fetchall()]
    return {"schema": schema, "tables": tables}


# Generated by running sim_fixture_dump against origin/main 5fb4b485 (paper-bot unchanged since 8e955367).
# Python values (floats written with repr, which round-trips exactly), compared with ==: no SQLite text
# formatting is involved, so this does not depend on the SQLite version (iterdump float text does).
SIM_EXPECTED = {'schema': [['index',
             'idx_decisions_action_id',
             'decisions',
             'CREATE INDEX idx_decisions_action_id ON decisions(action, id)'],
            ['index',
             'idx_decisions_action_ts',
             'decisions',
             'CREATE INDEX idx_decisions_action_ts ON decisions(action, ts)'],
            ['index',
             'idx_decisions_symbol_id',
             'decisions',
             'CREATE INDEX idx_decisions_symbol_id ON decisions(symbol, id)'],
            ['index',
             'idx_decisions_symbol_ts',
             'decisions',
             'CREATE INDEX idx_decisions_symbol_ts ON decisions(symbol, ts)'],
            ['index', 'idx_equity_ts', 'equity', 'CREATE INDEX idx_equity_ts ON equity(ts)'],
            ['index', 'idx_trades_ts_symbol', 'trades', 'CREATE INDEX idx_trades_ts_symbol ON trades(ts, symbol)'],
            ['table',
             'decisions',
             'decisions',
             'CREATE TABLE decisions(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, candle_time INTEGER, close '
             'REAL, fast REAL, slow REAL, signal TEXT, action TEXT, reason TEXT)'],
            ['table',
             'equity',
             'equity',
             'CREATE TABLE equity(id INTEGER PRIMARY KEY, ts REAL, cash REAL, unrealised REAL, total REAL)'],
            ['table',
             'positions',
             'positions',
             'CREATE TABLE positions(symbol TEXT PRIMARY KEY, side TEXT, qty REAL, entry REAL, entry_fee REAL, '
             'mark REAL)'],
            ['table', 'state', 'state', 'CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT)'],
            ['table',
             'trades',
             'trades',
             'CREATE TABLE trades(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, side TEXT, kind TEXT, qty REAL, '
             'price REAL, fee REAL, pnl REAL)']],
 'tables': {'decisions': [[1,
                           1700001007.0,
                           'BTCUSD',
                           1700000700,
                           200.0,
                           150.0,
                           133.33333333333334,
                           'long',
                           'open',
                           'fast 150.00 crossed above slow 133.33 → open long'],
                          [2,
                           1700001007.0,
                           'ETHUSD',
                           1700000700,
                           25.0,
                           37.5,
                           41.666666666666664,
                           'short',
                           'open',
                           'fast 37.50 crossed below slow 41.67 → open short'],
                          [3,
                           1700001307.0,
                           'BTCUSD',
                           1700001000,
                           200.0,
                           150.0,
                           133.33333333333334,
                           'long',
                           'hold',
                           'fast 150.00 crossed above slow 133.33 → already long, hold'],
                          [4,
                           1700001307.0,
                           'ETHUSD',
                           1700001000,
                           25.0,
                           37.5,
                           41.666666666666664,
                           'short',
                           'hold',
                           'fast 37.50 crossed below slow 41.67 → already short, hold'],
                          [5,
                           1700001607.0,
                           'BTCUSD',
                           1700001300,
                           50.0,
                           75.0,
                           83.33333333333333,
                           'short',
                           'reverse',
                           'fast 75.00 crossed below slow 83.33 → close long, open short'],
                          [6,
                           1700001607.0,
                           'ETHUSD',
                           1700001300,
                           50.0,
                           50.0,
                           50.0,
                           'hold',
                           'hold',
                           'no cross (fast equal to slow by 0.00%) → hold'],
                          [7,
                           1700001907.0,
                           'BTCUSD',
                           None,
                           None,
                           None,
                           None,
                           'hold',
                           'skip',
                           'data error: http 500'],
                          [8,
                           1700001907.0,
                           'ETHUSD',
                           1700001600,
                           100.0,
                           75.0,
                           66.66666666666667,
                           'long',
                           'reverse',
                           'fast 75.00 crossed above slow 66.67 → close short, open long'],
                          [9,
                           1700002207.0,
                           'BTCUSD',
                           1700001900,
                           200.0,
                           200.0,
                           200.0,
                           'hold',
                           'hold',
                           'no cross (fast equal to slow by 0.00%) → hold'],
                          [10,
                           1700002207.0,
                           'ETHUSD',
                           1700001900,
                           300.0,
                           200.0,
                           166.66666666666666,
                           'long',
                           'hold',
                           'fast 200.00 crossed above slow 166.67 → already long, hold']],
            'equity': [[1, 1700001007.0, 9999.0, -0.4000000159999211, 9998.599999984],
                       [2, 1700001307.0, 9999.0, -0.4000000159999211, 9998.599999984],
                       [3, 1700001607.0, 9248.275069986003, -1000.6001200240047, 8247.674949961998],
                       [4, 1700001907.0, 6244.173949761958, -0.4000000159999211, 6243.773949745959],
                       [5, 1700002207.0, 6244.173949761958, -1001.4000400560012, 5242.773909705957]],
            'positions': [['BTCUSD', 'short', 20.004000800160032, 49.99, 0.5, 200.0],
                          ['ETHUSD', 'long', 9.998000399920016, 100.02, 0.5, 300.0]],
            'state': [['cash', '6244.173949761958'],
                      ['last_candle:BTCUSD', '1700001900'],
                      ['last_candle:ETHUSD', '1700001900'],
                      ['last_tick', '1700002207']],
            'trades': [[1, 1700001007.0, 'BTCUSD', 'buy', 'open', 4.999000199960008, 200.04, 0.5, None],
                       [2, 1700001007.0, 'ETHUSD', 'sell', 'open', 40.008001600320064, 24.995, 0.5, None],
                       [3,
                        1700001607.0,
                        'BTCUSD',
                        'sell',
                        'close',
                        4.999000199960008,
                        49.99,
                        0.12495000999800042,
                        -750.7249300139971],
                       [4, 1700001607.0, 'BTCUSD', 'sell', 'open', 20.004000800160032, 49.99, 0.5, None],
                       [5,
                        1700001907.0,
                        'ETHUSD',
                        'buy',
                        'close',
                        40.008001600320064,
                        100.02,
                        2.0008001600320062,
                        -3004.1011202240447],
                       [6, 1700001907.0, 'ETHUSD', 'buy', 'open', 9.998000399920016, 100.02, 0.5, None]]}}

SIM_CHILD = r"""
import json, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from paper_bot.config import Config
import test_tm2_77_openalgo_exec as T
cfg = Config.from_env()
dump = T.sim_fixture_dump(cfg)
print(json.dumps({"mods": sorted(m for m in sys.modules if m.startswith("paper_bot")), "dump": dump,
                  "cfg": repr(cfg), "fields": [cfg.execution, cfg.openalgo_url, cfg.openalgo_api_key,
                                               list(cfg.contract_sizes), cfg.openalgo_symbol_suffix,
                                               cfg.openalgo_timeout]}))
"""


@pytest.mark.parametrize("execution", [None, "sim", " SIM "])
def test_sim_ignores_openalgo_env_and_is_byte_identical(tmp_path, execution):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENALGO", "CONTRACT_SIZES", "EXECUTION"))}
    env.update({"OPENALGO_URL": "junk://nowhere", "OPENALGO_API_KEY": KEY, "CONTRACT_SIZES": "garbage::,::",
                "OPENALGO_TIMEOUT": "not-a-number", "OPENALGO_SYMBOL_SUFFIX": "ZZZ",
                "SYMBOLS": "BTCUSD,ETHUSD", "FAST": "2", "SLOW": "3", "DATA_DIR": str(tmp_path)})
    if execution is not None:
        env["EXECUTION"] = execution
    r = subprocess.run([sys.executable, "-c", SIM_CHILD, PB_DIR, TESTS_DIR], env=env, capture_output=True,
                       text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert "paper_bot.openalgo_exec" not in out["mods"]
    assert out["fields"] == ["sim", "", "", [], "FUT", 10.0]  # OPENALGO_* / CONTRACT_SIZES not even parsed
    assert KEY not in out["cfg"]
    got = out["dump"]
    assert got["schema"] == SIM_EXPECTED["schema"]
    assert got["tables"].keys() == SIM_EXPECTED["tables"].keys()
    for t, rows in SIM_EXPECTED["tables"].items():
        assert got["tables"][t] == rows, t  # exact: floats compared with ==
        for gr, er in zip(got["tables"][t], rows):
            assert [type(x) for x in gr] == [type(x) for x in er], (t, gr)


def test_sim_engine_never_builds_openalgo(tmp_path, fake):
    cfg = Config(symbols=("BTCUSD",), fast=2, slow=3, data_dir=str(tmp_path), openalgo_url="http://oa.test",
                 openalgo_api_key=KEY, contract_sizes=SIZES)
    b = Bot(tmp_path)
    b.cfg = cfg
    b.start()
    assert b.eng.ox is None
    b.tick(UP)
    assert b.last()["action"] == "open" and fake.log == []
    b.stop()


def test_ox_order_outside_transaction_does_not_crash(tmp_path, fake):
    """Fix round 2: `_ox_order`'s COMMIT is guarded by in_transaction (direct call outside _txn)."""
    b = Bot(tmp_path).start()
    assert not b.conn.in_transaction
    r = b.eng._ox_order("BTCUSD", "BUY", 3, T0)
    assert r.status == "ok" and fake.eps() == ["analyzer", "analyzer", "placeorder"]
    b.conn.execute("COMMIT")
    assert b.state("openalgo_order") == {"openalgo_order:OA-1": "BTCUSD BUY 3"}
    b.stop()
