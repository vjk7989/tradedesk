import asyncio
import dataclasses

import httpx
import pytest
from fastapi.testclient import TestClient

from paper_bot import db as D
from paper_bot.config import Config
from paper_bot.engine import Engine
from paper_bot.stats import max_drawdown, summary
from paper_bot.strategy import closed_only, evaluate
from paper_bot.web import create_app

P = 300
T0 = 1_700_000_000 - 1_700_000_000 % P
CFG = Config(symbols=("BTCUSD",), data_dir="unused")
FLAT = [100.0] * 50


def candles(closes, t0=T0):
    return [{"time": t0 + i * P, "open": c, "high": c, "low": c, "close": c, "volume": 1.0}
            for i, c in enumerate(closes)]


def now_after(cs):
    return cs[-1]["time"] + P + 1  # last candle is closed


class Feed:
    """Mock Delta API: serves `body` (newest first) or a failure mode."""
    def __init__(self):
        self.cs, self.mode = [], "ok"

    def handler(self, req):
        if self.mode == "500":
            return httpx.Response(500)
        if self.mode == "timeout":
            raise httpx.ConnectTimeout("t")
        if self.mode == "garbage":
            return httpx.Response(200, json={"result": [{"nope": 1}]})
        if self.mode == "empty":
            return httpx.Response(200, json={"success": True, "result": []})
        return httpx.Response(200, json={"success": True, "result": list(reversed(self.cs))})


def make(tmp_path, cfg=CFG, feed=None):
    feed = feed or Feed()
    conn = D.connect(str(tmp_path / "paper.db"))
    client = httpx.AsyncClient(transport=httpx.MockTransport(feed.handler))
    return Engine(cfg, conn, client), feed, conn


def tick(eng, feed, closes):
    feed.cs = candles(closes)
    asyncio.run(eng.tick(now_after(feed.cs)))


# --- strategy -------------------------------------------------------------
def test_cross_up_down_none():
    assert evaluate(FLAT + [200.0], 20, 50)[0] == "up"
    assert evaluate(FLAT + [50.0], 20, 50)[0] == "down"
    sig, f, s, why = evaluate([100.0] * 51, 20, 50)
    assert sig == "none" and "no cross" in why


def test_no_cross_when_already_above():
    closes = FLAT + [200.0, 210.0]
    assert evaluate(closes, 20, 50)[0] == "none"


def test_forming_candle_ignored():
    cs = candles(FLAT + [200.0])
    now = cs[-1]["time"] + P - 1  # last candle still forming
    assert closed_only(cs, now, P)[-1]["time"] == cs[-2]["time"]
    assert closed_only(cs, now + 2, P)[-1]["time"] == cs[-1]["time"]


def test_forming_candle_does_not_trade(tmp_path):
    eng, feed, conn = make(tmp_path)
    feed.cs = candles(FLAT + [200.0])
    asyncio.run(eng.tick(feed.cs[-1]["time"] + P - 1))  # spike candle not closed yet
    assert D.rows(conn, "SELECT * FROM trades") == []
    assert D.rows(conn, "SELECT action FROM decisions")[0]["action"] == "skip"  # only 50 closed candles


# --- fills & pnl ----------------------------------------------------------
def test_long_open_close_maths(tmp_path):
    eng, feed, conn = make(tmp_path)
    tick(eng, feed, FLAT + [200.0])  # up -> long
    [t] = D.rows(conn, "SELECT * FROM trades")
    fp = 200 * 1.0002
    assert t["price"] == pytest.approx(fp) and t["qty"] == pytest.approx(1000 / fp)
    assert t["fee"] == pytest.approx(1000 * 0.0005)
    assert D.get_cash(conn, 10000) == pytest.approx(10000 - 0.5)
    eng.db.execute("UPDATE positions SET mark=210")
    eng.snapshot(1)
    eq = D.rows(conn, "SELECT * FROM equity")[-1]
    assert eq["unrealised"] == pytest.approx((210 - fp) * 1000 / fp)
    eng._close("BTCUSD", 220.0, 2)
    c = D.rows(conn, "SELECT * FROM trades WHERE kind='close'")[0]
    xp = 220 * (1 - 0.0002)
    qty = 1000 / fp
    assert c["price"] == pytest.approx(xp)
    assert c["pnl"] == pytest.approx((xp - fp) * qty - 0.5 - qty * xp * 0.0005)
    assert D.get_cash(conn, 10000) == pytest.approx(10000 + c["pnl"])


def test_short_and_reversal(tmp_path):
    eng, feed, conn = make(tmp_path)
    tick(eng, feed, FLAT + [50.0])  # down -> short
    p = D.rows(conn, "SELECT * FROM positions")[0]
    assert p["side"] == "short" and p["entry"] == pytest.approx(50 * (1 - 0.0002))
    # new candle: price spikes -> up cross -> reverse
    closes = [100.0] * 32 + [50.0] * 19 + [4000.0]
    tick(eng, feed, closes)
    tr = D.rows(conn, "SELECT * FROM trades ORDER BY id")
    assert [t["kind"] for t in tr] == ["open", "close", "open"]
    assert tr[1]["pnl"] < 0 and tr[2]["side"] == "buy"
    assert D.rows(conn, "SELECT side FROM positions")[0]["side"] == "long"
    assert D.rows(conn, "SELECT action FROM decisions ORDER BY id DESC")[0]["action"] == "reverse"


def test_short_disabled_goes_flat(tmp_path):
    eng, feed, conn = make(tmp_path, dataclasses.replace(CFG, allow_short=False))
    tick(eng, feed, FLAT + [200.0])
    tick(eng, feed, [100.0] * 51 + [50.0])  # down cross, newer candle
    assert D.rows(conn, "SELECT * FROM positions") == []
    assert D.rows(conn, "SELECT action FROM decisions ORDER BY id DESC")[0]["action"] == "close"


# --- restart --------------------------------------------------------------
def test_restart_no_double_trade(tmp_path):
    eng, feed, conn = make(tmp_path)
    tick(eng, feed, FLAT + [200.0])
    conn.close()
    eng2, _, conn2 = make(tmp_path, feed=feed)  # same db file
    assert len(D.rows(conn2, "SELECT * FROM positions")) == 1
    asyncio.run(eng2.tick(now_after(feed.cs) + 5))
    assert len(D.rows(conn2, "SELECT * FROM trades")) == 1
    last = D.rows(conn2, "SELECT * FROM decisions ORDER BY id DESC")[0]
    assert last["action"] == "hold" and "already processed" in last["reason"]
    assert D.get_cash(conn2, 10000) == pytest.approx(10000 - 0.5)


# --- data errors ----------------------------------------------------------
@pytest.mark.parametrize("mode", ["500", "timeout", "garbage", "empty"])
def test_data_error_skips(tmp_path, mode):
    eng, feed, conn = make(tmp_path)
    feed.mode = mode
    asyncio.run(eng.tick(T0 + 100 * P))
    asyncio.run(eng.tick(T0 + 101 * P))  # loop survives
    ds = D.rows(conn, "SELECT * FROM decisions")
    assert len(ds) == 2 and all(d["action"] == "skip" and d["reason"].startswith("data error: ") for d in ds)


def test_too_few_candles_skips(tmp_path):
    eng, feed, conn = make(tmp_path)
    feed.cs = candles([100.0] * 10)
    asyncio.run(eng.tick(now_after(feed.cs)))
    assert "data error: only 10" in D.rows(conn, "SELECT reason FROM decisions")[0]["reason"]


def test_one_decision_per_symbol_per_tick(tmp_path):
    cfg = dataclasses.replace(CFG, symbols=("BTCUSD", "ETHUSD"))
    eng, feed, conn = make(tmp_path, cfg)
    tick(eng, feed, FLAT + [100.0])
    assert [d["symbol"] for d in D.rows(conn, "SELECT symbol FROM decisions ORDER BY id")] == ["BTCUSD", "ETHUSD"]


# --- stats ----------------------------------------------------------------
def test_drawdown():
    assert max_drawdown([100, 120, 90, 130, 117]) == pytest.approx(0.25)
    assert max_drawdown([]) == 0.0


def test_summary_empty_and_populated(tmp_path):
    eng, feed, conn = make(tmp_path)
    s = summary(conn, CFG)
    assert s["equity"] == 10000 and s["win_rate"] is None and s["trades"] == 0
    tick(eng, feed, FLAT + [200.0])
    s = summary(conn, CFG)
    assert s["trades"] == 1 and s["pnl"] == pytest.approx(s["unrealised"] - 0.5)
    assert s["realised"] == pytest.approx(-0.5)


# --- web ------------------------------------------------------------------
def test_dashboard_and_api(tmp_path):
    eng, feed, conn = make(tmp_path)
    app = create_app(CFG, conn, run_loop=False)
    with TestClient(app) as c:
        assert c.get("/healthz").json() == {"ok": True}
        html = c.get("/").text
        assert "PAPER" in html and "no trades yet" in html and "no equity data" in html
        assert c.get("/api/decisions").json() == [] and c.get("/api/trades").json() == []
        tick(eng, feed, FLAT + [200.0])
        tick(eng, feed, [100.0] * 51 + [50.0])
        html = c.get("/").text
        assert "<polyline" in html and "open long" in html and "BTCUSD" in html
        assert "<script" not in html and "http://" not in html.replace("http://www.w3.org", "")
        assert "reverse" in c.get("/?action=reverse").text
        assert "open long" not in c.get("/?action=reverse&symbol=BTCUSD").text
        c.get("/?symbol=<script>")  # bad filter is ignored, not reflected
        assert len(c.get("/api/decisions").json()) == 2
        assert len(c.get("/api/trades").json()) == 3
        assert c.get("/api/positions").json()[0]["side"] == "short"
        assert len(c.get("/api/equity").json()) == 2
        assert c.get("/api/summary").json()["mode"] == "PAPER"
