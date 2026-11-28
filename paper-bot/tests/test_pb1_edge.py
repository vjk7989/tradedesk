"""PB-1 edge tests. No network: httpx.MockTransport + fixture candles."""
import asyncio
import dataclasses
import json
import random
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from paper_bot import db as D
from paper_bot.config import Config
from paper_bot.engine import Engine
from paper_bot.stats import max_drawdown, summary
from paper_bot.strategy import closed_only, evaluate
from paper_bot import web
from paper_bot.web import create_app

P = 300
T0 = 1_700_000_000 - 1_700_000_000 % P
FEE, SLIP = 0.0005, 0.0002


def cfg_for(tmp_path, **kw):
    base = dict(symbols=("BTCUSD",), fast=2, slow=3, data_dir=str(tmp_path))
    base.update(kw)
    return Config(**base)


def candles(closes, t0=T0):
    return [{"time": t0 + i * P, "open": c, "high": c, "low": c, "close": c, "volume": 1.0}
            for i, c in enumerate(closes)]


def now_after(cs):
    return max(c["time"] for c in cs) + P + 1


class Feed:
    """Per-symbol mock Delta API. `bodies[sym]` is a callable(req) -> Response, or candle list."""

    def __init__(self):
        self.cs = {}
        self.err = {}
        self.reqs = []
        self.hook = None

    def handler(self, req):
        self.reqs.append(req)
        sym = req.url.params["symbol"]
        if self.hook:
            self.hook(sym)
        if sym in self.err:
            return self.err[sym](req)
        cs = self.cs.get(sym, [])
        return httpx.Response(200, json={"success": True, "result": sorted(cs, key=lambda c: -c["time"])})


def make(tmp_path, cfg, feed=None):
    feed = feed or Feed()
    conn = D.connect(cfg.db_path)
    client = httpx.AsyncClient(transport=httpx.MockTransport(feed.handler))
    return Engine(cfg, conn, client), feed, conn


def run_tick(eng, now):
    asyncio.run(eng.tick(now))


def feed_all(feed, cfg, cs):
    for s in cfg.symbols:
        feed.cs[s] = cs


def decisions(conn):
    return D.rows(conn, "SELECT * FROM decisions ORDER BY id")


def trades(conn):
    return D.rows(conn, "SELECT * FROM trades ORDER BY id")


# ============================== candles =====================================
def test_newest_first_api_order_is_handled(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    feed_all(feed, cfg, candles([100, 100, 100, 100, 130]))  # served newest first
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    d = decisions(conn)[-1]
    assert d["action"] == "open" and d["candle_time"] == T0 + 4 * P and d["close"] == 130


def test_unordered_input_same_result_as_ordered(tmp_path):
    cs = candles([100, 100, 100, 100, 130])
    shuffled = cs[:]
    random.Random(7).shuffle(shuffled)
    now = now_after(cs)
    out = closed_only(shuffled, now, P)
    assert [c["time"] for c in out] == [c["time"] for c in cs]
    assert evaluate([c["close"] for c in out], 2, 3)[0] == "up"


def test_duplicate_timestamps_do_not_count_as_extra_candles(tmp_path):
    # SLOW unique closed candles + a duplicate of the last one: still only SLOW real candles -> skip.
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    cs = candles([100, 100, 130])
    feed_all(feed, cfg, cs + [dict(cs[-1])])
    run_tick(eng, now_after(cs))
    assert decisions(conn)[-1]["action"] == "skip"
    assert trades(conn) == []


def test_gap_in_candles_does_not_crash(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    cs = candles([100, 100, 100, 100, 130])
    del cs[2]  # one missing slot
    feed_all(feed, cfg, cs)
    run_tick(eng, now_after(cs))
    d = decisions(conn)[-1]
    assert d["candle_time"] == cs[-1]["time"] and d["action"] in ("open", "hold", "skip")


def test_forming_candle_boundary_both_sides():
    cs = candles([100.0] * 4)
    last = cs[-1]["time"]
    assert closed_only(cs, last + P, P)[-1]["time"] == last          # time+res == now -> closed
    assert closed_only(cs, last + P - 1, P)[-1]["time"] == cs[-2]["time"]  # time+res > now -> forming


def test_forming_spike_does_not_trade(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    cs = candles([100, 100, 100, 100, 5000])
    feed_all(feed, cfg, cs)
    run_tick(eng, cs[-1]["time"] + P - 1)  # 4 closed (SLOW+1) + forming spike
    d = decisions(conn)[-1]
    assert d["action"] == "hold" and d["candle_time"] == cs[-2]["time"] and trades(conn) == []


def test_exactly_slow_plus_one_closed_candles_evaluates(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    feed_all(feed, cfg, candles([100, 100, 100, 130]))  # SLOW+1 = 4
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    assert decisions(conn)[-1]["action"] == "open"


def test_exactly_slow_closed_candles_skips(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    feed_all(feed, cfg, candles([100, 100, 130]))  # SLOW = 3
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    d = decisions(conn)[-1]
    assert d["action"] == "skip" and d["reason"].startswith("data error: ")


def test_fetch_requests_enough_history_with_timeout(tmp_path):
    cfg = cfg_for(tmp_path, slow=50, fast=20)
    eng, feed, conn = make(tmp_path, cfg)
    now = T0 + 1000 * P + 17
    run_tick(eng, now)
    req = feed.reqs[0]
    start, end = int(req.url.params["start"]), int(req.url.params["end"])
    assert end >= now - 1 and (end - start) // P >= cfg.slow + 2 + 1  # SLOW+2 closed + the forming one
    assert req.url.params["resolution"] == "5m"
    assert req.extensions["timeout"]["read"] == pytest.approx(10.0)


# ============================== crossover ===================================
def test_cross_only_on_latest_closed_candle():
    assert evaluate([100, 100, 100, 100], 2, 3)[0] == "none"
    assert evaluate([100, 100, 100, 100, 130], 2, 3)[0] == "up"
    assert evaluate([100, 100, 100, 100, 130, 140], 2, 3)[0] == "none"  # cross was one candle ago


def _signals(closes, f=2, s=3):
    return [evaluate(closes[: i + 1], f, s)[0] for i in range(s, len(closes))]


def test_equality_on_current_then_previous_up():
    seq = [100, 90, 80, 100, 110]
    sig, f, s, why = evaluate(seq[:4], 2, 3)
    assert f == pytest.approx(s) and sig == "none" and "equal" in why
    assert _signals(seq) == ["none", "up"]  # touch then cross = exactly one signal


def test_equality_on_current_then_previous_down():
    seq = [100, 110, 120, 100, 90]
    assert evaluate(seq[:4], 2, 3)[1] == pytest.approx(evaluate(seq[:4], 2, 3)[2])
    assert _signals(seq) == ["none", "down"]


def test_equality_both_candles_is_no_cross():
    assert _signals([100.0] * 6) == ["none"] * 3


def test_cross_then_immediate_reverse_cross(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    seq = [100, 100, 100, 100, 130, 60]
    assert _signals(seq) == ["none", "up", "down"]
    feed_all(feed, cfg, candles(seq[:5]))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    feed_all(feed, cfg, candles(seq))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    assert [d["action"] for d in decisions(conn)] == ["open", "reverse"]
    assert [(t["side"], t["kind"]) for t in trades(conn)] == [("buy", "open"), ("sell", "close"), ("sell", "open")]
    assert D.rows(conn, "SELECT side FROM positions")[0]["side"] == "short"


def test_allow_short_false_down_from_flat_stays_flat(tmp_path):
    cfg = cfg_for(tmp_path, allow_short=False)
    eng, feed, conn = make(tmp_path, cfg)
    feed_all(feed, cfg, candles([100, 100, 100, 100, 60]))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    d = decisions(conn)[-1]
    assert d["signal"] == "flat" and d["action"] == "hold"
    assert trades(conn) == [] and D.rows(conn, "SELECT * FROM positions") == []


def test_allow_short_false_reverse_cross_closes_not_shorts(tmp_path):
    cfg = cfg_for(tmp_path, allow_short=False)
    eng, feed, conn = make(tmp_path, cfg)
    seq = [100, 100, 100, 100, 130, 60]
    feed_all(feed, cfg, candles(seq[:5]))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    feed_all(feed, cfg, candles(seq))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    assert [t["kind"] for t in trades(conn)] == ["open", "close"]
    assert D.rows(conn, "SELECT * FROM positions") == []


def test_allow_short_env_parsing():
    assert Config.from_env({"ALLOW_SHORT": "false"}).allow_short is False
    assert Config.from_env({"ALLOW_SHORT": "0"}).allow_short is False
    assert Config.from_env({}).allow_short is True


# ============================== money =======================================
def test_exact_fees_slippage_long_reverse_short_close(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    seq = [100, 100, 100, 100, 130, 60]
    feed_all(feed, cfg, candles(seq[:5]))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    feed_all(feed, cfg, candles(seq))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    eng._close("BTCUSD", 50.0, 1)
    conn.commit()
    o1, c1, o2, c2 = trades(conn)

    fp1 = 130 * (1 + SLIP); q1 = 1000 / fp1
    assert (o1["price"], o1["qty"], o1["fee"]) == pytest.approx((fp1, q1, 1000 * FEE))
    assert o1["pnl"] is None
    fp2 = 60 * (1 - SLIP); fee2 = q1 * fp2 * FEE
    assert (c1["price"], c1["qty"], c1["fee"]) == pytest.approx((fp2, q1, fee2))
    assert c1["pnl"] == pytest.approx((fp2 - fp1) * q1 - fee2 - 1000 * FEE)
    fp3 = 60 * (1 - SLIP); q3 = 1000 / fp3  # short open sells: slippage lowers fill
    assert (o2["side"], o2["price"], o2["qty"], o2["fee"]) == pytest.approx(("sell", fp3, q3, 1000 * FEE))
    fp4 = 50 * (1 + SLIP); fee4 = q3 * fp4 * FEE  # short close buys: slippage raises fill
    assert (c2["side"], c2["price"], c2["fee"]) == pytest.approx(("buy", fp4, fee4))
    assert c2["pnl"] == pytest.approx((fp3 - fp4) * q3 - fee4 - 1000 * FEE)


def test_cash_conservation_when_flat(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    seq = [100, 100, 100, 100, 130, 60, 40, 90]
    for i in range(5, len(seq) + 1):
        feed_all(feed, cfg, candles(seq[:i]))
        run_tick(eng, now_after(feed.cs["BTCUSD"]))
    if D.rows(conn, "SELECT * FROM positions"):
        eng._close("BTCUSD", 77.0, 2)
        conn.commit()
    tr = trades(conn)
    closes = [t for t in tr if t["kind"] == "close"]
    assert len(closes) >= 2
    realised_net = sum(t["pnl"] for t in closes)
    fees = sum(t["fee"] for t in tr)
    realised_gross = realised_net + fees  # pnl is net of both legs' fees
    cash = D.get_cash(conn, cfg.capital)
    assert cash == pytest.approx(cfg.capital + realised_gross - fees)
    assert cash == pytest.approx(cfg.capital + realised_net)


def test_drawdown_known_path(tmp_path):
    assert max_drawdown([10000, 11000, 9900, 12000, 6000, 13000]) == pytest.approx(0.5)
    assert max_drawdown([1, 2, 3]) == 0.0
    assert max_drawdown([5]) == 0.0
    cfg = cfg_for(tmp_path)
    conn = D.connect(cfg.db_path)
    for i, t in enumerate([11000, 9900, 12000, 9000]):
        conn.execute("INSERT INTO equity(ts,cash,unrealised,total) VALUES(?,?,?,?)", (i, t, 0, t))
    conn.commit()
    assert summary(conn, cfg)["max_drawdown_pct"] == pytest.approx(25.0)


def test_drawdown_below_start_capital_counts(tmp_path):
    cfg = cfg_for(tmp_path)
    conn = D.connect(cfg.db_path)
    conn.execute("INSERT INTO equity(ts,cash,unrealised,total) VALUES(1,9000,0,9000)")
    conn.commit()
    assert summary(conn, cfg)["max_drawdown_pct"] == pytest.approx(10.0)


# ============================== restart =====================================
class Kill(BaseException):
    """Simulates process death: not an Exception, so nothing in the engine catches it."""


@pytest.mark.parametrize("where", ["_open", "_decision", "snapshot", "after_commit"])
def test_kill_then_restart_no_double_no_lost_trade(tmp_path, monkeypatch, where):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    cs = candles([100, 100, 100, 100, 130])
    feed_all(feed, cfg, cs)
    now = now_after(cs)
    if where != "after_commit":
        def boom(*a, **k):
            raise Kill()
        monkeypatch.setattr(Engine, where, boom)
        with pytest.raises(Kill):
            run_tick(eng, now)
        monkeypatch.undo()
    else:
        run_tick(eng, now)
    conn.close()  # uncommitted work is lost, as on a crash

    eng2, _, conn2 = make(tmp_path, cfg, feed=feed)
    run_tick(eng2, now + 5)  # same candle after restart
    run_tick(eng2, now + 10)  # and once more
    assert len(trades(conn2)) == 1
    assert len(D.rows(conn2, "SELECT * FROM positions")) == 1
    assert [d["action"] for d in decisions(conn2)].count("open") == 1
    assert D.get_cash(conn2, cfg.capital) == pytest.approx(cfg.capital - 1000 * FEE)


def test_same_candle_twice_one_action(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    feed_all(feed, cfg, candles([100, 100, 100, 100, 130]))
    now = now_after(feed.cs["BTCUSD"])
    run_tick(eng, now)
    run_tick(eng, now + 30)
    assert [d["action"] for d in decisions(conn)] == ["open", "hold"]
    assert len(trades(conn)) == 1


def test_exception_mid_reversal_rolls_back_and_retries(tmp_path, monkeypatch):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    seq = [100, 100, 100, 100, 130, 60]
    feed_all(feed, cfg, candles(seq[:5]))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    before = (trades(conn), D.rows(conn, "SELECT * FROM positions"), D.get_cash(conn, cfg.capital))

    real_open = Engine._open

    def boom(*a, **k):
        raise RuntimeError("injected between close and open")
    monkeypatch.setattr(Engine, "_open", boom)
    feed_all(feed, cfg, candles(seq))
    now = now_after(feed.cs["BTCUSD"])
    run_tick(eng, now)
    after = (trades(conn), D.rows(conn, "SELECT * FROM positions"), D.get_cash(conn, cfg.capital))
    assert after == before, "half-done reversal was committed"
    assert decisions(conn)[-1]["action"] == "skip"

    monkeypatch.setattr(Engine, "_open", real_open)
    run_tick(eng, now + 5)  # same candle must be retried, not treated as processed
    assert [t["kind"] for t in trades(conn)] == ["open", "close", "open"]
    assert [d["action"] for d in decisions(conn)].count("reverse") == 1


def test_concurrent_read_never_sees_uncommitted_rows(tmp_path):
    cfg = cfg_for(tmp_path, symbols=("BTCUSD", "ETHUSD"))
    eng, feed, conn = make(tmp_path, cfg)
    feed_all(feed, cfg, candles([100, 100, 100, 100, 130]))
    app = create_app(cfg, conn, run_loop=False)
    seen = {}
    with TestClient(app) as c:
        def hook(sym):
            if sym == "ETHUSD":  # BTCUSD has traded but nothing is committed yet
                seen["trades"] = c.get("/api/trades").json()
                seen["decisions"] = c.get("/api/decisions").json()
                seen["positions"] = c.get("/api/positions").json()
        feed.hook = hook
        run_tick(eng, now_after(feed.cs["BTCUSD"]))
        assert seen == {"trades": [], "decisions": [], "positions": []}
        assert len(c.get("/api/trades").json()) == 2  # visible after commit


# ============================== API errors ==================================
def _raw(body: bytes, status=200):
    return lambda req: httpx.Response(status, content=body, headers={"content-type": "application/json"})


def _rows_with_last(close_literal: str):
    rows = [{"time": T0 + i * P, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 1}
            for i in range(4)]
    body = json.dumps({"success": True, "result": list(reversed(rows))})
    last = (f'{{"time": {T0 + 4 * P}, "open": 100, "high": 100, "low": 100, '
            f'"close": {close_literal}, "volume": 1}}')
    return body.replace('"result": [', f'"result": [{last}, ', 1).encode()


def _timeout(req):
    raise httpx.ReadTimeout("slow", request=req)


ERRORS = {
    "timeout": _timeout,
    "connect": lambda req: (_ for _ in ()).throw(httpx.ConnectError("refused", request=req)),
    "500": lambda req: httpx.Response(500, text="boom"),
    "429": lambda req: httpx.Response(429),
    "success_false": lambda req: httpx.Response(200, json={"success": False, "error": {"code": "bad_symbol"}}),
    "success_false_result": lambda req: httpx.Response(200, json={"success": False, "result": []}),
    "empty_result": lambda req: httpx.Response(200, json={"success": True, "result": []}),
    "null_result": lambda req: httpx.Response(200, json={"success": True, "result": None}),
    "dict_result": lambda req: httpx.Response(200, json={"success": True, "result": {"a": 1}}),
    "not_json": _raw(b"<html>gateway</html>"),
    "row_missing_close": lambda req: httpx.Response(200, json={"result": [{"time": T0, "open": 1}]}),
    "row_bad_time": lambda req: httpx.Response(200, json={"result": [{"time": "x", "open": 1, "high": 1,
                                                                       "low": 1, "close": 1}]}),
    "none_price": _raw(_rows_with_last("null")),
    "nan_price": _raw(_rows_with_last("NaN")),
    "inf_price": _raw(_rows_with_last("Infinity")),
}


@pytest.mark.parametrize("kind", list(ERRORS))
def test_api_error_gives_skip_and_loop_continues(tmp_path, kind):
    cfg = cfg_for(tmp_path, symbols=("BAD", "GOOD"))
    eng, feed, conn = make(tmp_path, cfg)
    feed.err["BAD"] = ERRORS[kind]
    feed.cs["GOOD"] = candles([100, 100, 100, 100, 130])
    now = T0 + 5 * P + 1
    run_tick(eng, now)
    ds = decisions(conn)
    assert [d["symbol"] for d in ds] == ["BAD", "GOOD"]
    assert ds[0]["action"] == "skip" and ds[0]["reason"].startswith("data error: ")
    assert ds[1]["action"] == "open"
    assert D.rows(conn, "SELECT * FROM positions WHERE symbol='BAD'") == []
    del feed.err["BAD"]
    feed.cs["BAD"] = candles([100, 100, 100, 100, 130])
    run_tick(eng, now + 1)  # next tick, API recovered
    assert decisions(conn)[-2]["symbol"] == "BAD" and decisions(conn)[-2]["action"] == "open"
    assert len(D.rows(conn, "SELECT * FROM equity")) == 2


def test_web_loop_survives_tick_exception():
    calls = []

    class E:
        async def tick(self):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("first tick dies")

    async def go():
        t = asyncio.create_task(web.loop(E(), Config(interval_sec=0)))
        for _ in range(50):
            await asyncio.sleep(0.01)
            if len(calls) >= 3:
                break
        t.cancel()
    asyncio.run(go())
    assert len(calls) >= 3


def test_slow_api_does_not_block_dashboard(tmp_path):
    cfg = cfg_for(tmp_path, interval_sec=1)

    async def slow(req):
        await asyncio.sleep(30)
        return httpx.Response(200, json={"result": []})
    client = httpx.AsyncClient(transport=httpx.MockTransport(slow))
    conn = D.connect(cfg.db_path)
    app = create_app(cfg, conn, client=client, run_loop=True)
    with TestClient(app) as c:
        time.sleep(0.2)  # loop is now stuck in the fetch
        t = time.monotonic()
        assert c.get("/").status_code == 200
        assert c.get("/api/summary").status_code == 200
        assert time.monotonic() - t < 3


# ============================== dashboard / API =============================
XSS = "<script>alert(1)</script>"
ATTR = '"><img src=x onerror=alert(1)>'


def _populate_hostile(conn, sym):
    conn.execute("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                 " VALUES(1,?,1,1,1,1,?,?,?)", (sym, XSS, "skip", "data error: " + XSS + ATTR))
    conn.execute("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                 " VALUES(2,?,1,1,1,1,'hold',?,'x')", (sym, XSS))  # unknown action value
    conn.execute("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(1,?,?,?,1,1,0,1)", (sym, XSS, XSS))
    conn.execute("INSERT INTO positions VALUES(?,?,1,1,0,1)", (sym, XSS))
    conn.commit()


def test_html_escapes_symbol_reason_and_filter(tmp_path):
    cfg = cfg_for(tmp_path, symbols=(XSS, ATTR, "BTCUSD"))
    conn = D.connect(cfg.db_path)
    _populate_hostile(conn, XSS)
    _populate_hostile(conn, ATTR)
    with TestClient(create_app(cfg, conn, run_loop=False)) as c:
        for url in ("/", "/?symbol=" + XSS, "/?symbol=" + ATTR, "/?action=" + XSS,
                    "/?symbol=%3Cscript%3Ealert(1)%3C%2Fscript%3E&action=skip"):
            r = c.get(url)
            assert r.status_code == 200
            assert "<script" not in r.text.lower() and "<img" not in r.text.lower()
        assert "&lt;script&gt;" in c.get("/").text


def test_sql_injection_in_filters_is_harmless(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    feed_all(feed, cfg, candles([100, 100, 100, 100, 130]))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    with TestClient(create_app(cfg, conn, run_loop=False)) as c:
        for q in ("symbol=BTCUSD' OR '1'='1", "action=skip'; DROP TABLE decisions;--",
                  "symbol=x\" OR 1=1 --&action=open) UNION SELECT * FROM state--"):
            assert c.get("/?" + q).status_code == 200
        for bad in ("1;DROP TABLE trades", "0", "1001", "-1"):
            assert c.get("/api/decisions", params={"limit": bad}).status_code == 422
        assert len(c.get("/api/decisions", params={"limit": 1}).json()) == 1
        assert c.get("/api/decisions", params={"limit": 1000}).status_code == 200
    assert len(decisions(conn)) == 1 and len(trades(conn)) == 1


DEC_KEYS = {"id", "ts", "symbol", "candle_time", "close", "fast", "slow", "signal", "action", "reason"}
TR_KEYS = {"id", "ts", "symbol", "side", "kind", "qty", "price", "fee", "pnl"}
POS_KEYS = {"symbol", "side", "qty", "entry", "entry_fee", "mark"}
EQ_KEYS = {"ts", "cash", "unrealised", "total"}
SUM_KEYS = {"mode", "equity", "start_capital", "pnl", "pnl_pct", "unrealised", "realised", "trades",
            "closed_trades", "win_rate", "max_drawdown_pct", "last_tick"}


def test_json_shapes_empty_db(tmp_path):
    cfg = cfg_for(tmp_path)
    conn = D.connect(cfg.db_path)
    with TestClient(create_app(cfg, conn, run_loop=False)) as c:
        for ep in ("decisions", "trades", "positions", "equity"):
            assert c.get(f"/api/{ep}").json() == []
        s = c.get("/api/summary").json()
        assert SUM_KEYS <= set(s)
        assert s["equity"] == cfg.capital and s["pnl"] == 0 and s["win_rate"] is None
        assert s["last_tick"] is None and s["max_drawdown_pct"] == 0 and s["trades"] == 0
        assert c.get("/").status_code == 200


def test_json_shapes_populated_db(tmp_path):
    cfg = cfg_for(tmp_path)
    eng, feed, conn = make(tmp_path, cfg)
    seq = [100, 100, 100, 100, 130, 60]
    for i in (5, 6):
        feed_all(feed, cfg, candles(seq[:i]))
        run_tick(eng, now_after(feed.cs["BTCUSD"]))
    with TestClient(create_app(cfg, conn, run_loop=False)) as c:
        d = c.get("/api/decisions").json()
        assert len(d) == 2 and set(d[0]) == DEC_KEYS and d[0]["action"] == "reverse"  # newest first
        t = c.get("/api/trades").json()
        assert len(t) == 3 and set(t[0]) == TR_KEYS and t[0]["id"] > t[-1]["id"]
        p = c.get("/api/positions").json()
        assert len(p) == 1 and POS_KEYS <= set(p[0])
        e = c.get("/api/equity").json()
        assert len(e) == 2 and set(e[0]) == EQ_KEYS
        s = c.get("/api/summary").json()
        assert SUM_KEYS <= set(s) and s["trades"] == 3 and s["closed_trades"] == 1
        assert s["win_rate"] == 0 and s["last_tick"] is not None


def test_no_env_values_leak(tmp_path, monkeypatch):
    secrets = {"DELTA_API_KEY": "SEKRETKEY_9f8e7d", "DELTA_API_SECRET": "SEKRETSEC_1a2b3c",
               "BASIC_AUTH_PASS": "SEKRETPASS_x1y2", "DATABASE_URL": "postgres://u:SEKRETDB_q@h/db"}
    for k, v in secrets.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("DELTA_BASE_URL", "https://user:SEKRETURL_zz@api.example.test")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "SEKRETDIR_data"))
    monkeypatch.setenv("SYMBOLS", "BTCUSD")
    import os
    cfg = Config.from_env(os.environ)
    feed = Feed()
    eng, feed, conn = make(tmp_path, cfg, feed)
    feed_all(feed, cfg, candles([100.0] * 60 + [200.0]))
    run_tick(eng, now_after(feed.cs["BTCUSD"]))
    feed.err["BTCUSD"] = ERRORS["timeout"]
    run_tick(eng, now_after(feed.cs["BTCUSD"]) + P)  # error reason must not echo the URL either
    with TestClient(create_app(cfg, conn, run_loop=False)) as c:
        bodies = [c.get(u).text for u in ("/", "/?action=skip", "/healthz", "/api/decisions", "/api/trades",
                                          "/api/positions", "/api/equity", "/api/summary")]
    blob = "\n".join(bodies)
    assert "SEKRET" not in blob
    assert "api.example.test" not in blob


# ============================== config ======================================
@pytest.mark.parametrize("env", [
    {"FAST": "50", "SLOW": "50"},
    {"FAST": "60", "SLOW": "50"},
    {"FAST": "0"},
    {"NOTIONAL_USD": "-1"},
    {"NOTIONAL_USD": "0"},
    {"RESOLUTION": "7m"},
    {"RESOLUTION": ""},
    {"INTERVAL_SEC": "abc"},
])
def test_bad_config_fails_at_startup(env):
    with pytest.raises(Exception):
        Config.from_env(env)


def test_invalid_resolution_error_is_clear():
    with pytest.raises(Exception) as ei:
        Config.from_env({"RESOLUTION": "7m"})
    msg = str(ei.value)
    assert "RESOLUTION" in msg.upper() and "7m" in msg


@pytest.mark.parametrize("env", [{"FAST": "49", "SLOW": "50"}, {"NOTIONAL_USD": "0.01"},
                                 {"RESOLUTION": "1d"}, {"RESOLUTION": "1m"}, {}])
def test_good_config_boundaries_accepted(env):
    cfg = Config.from_env(env)
    assert cfg.period > 0 and cfg.fast < cfg.slow and cfg.notional > 0
