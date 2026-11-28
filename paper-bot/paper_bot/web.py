import asyncio
import logging
import time
from contextlib import asynccontextmanager
from html import escape

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse

from . import db as D
from .engine import Engine
from .stats import summary

log = logging.getLogger("paper_bot")
ACTIONS = ("open", "reverse", "close", "hold", "skip")
COLORS = {"open": "#1a7f37", "reverse": "#8250df", "close": "#bc4c00", "hold": "#6e7781", "skip": "#cf222e"}

CSS = """body{font-family:system-ui,sans-serif;margin:0;padding:12px;background:#0d1117;color:#e6edf3}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 6px}.muted{color:#8b949e;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:12px 0}
.card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px}.card b{display:block;font-size:18px}
.card span{font-size:12px;color:#8b949e}.pos{color:#3fb950}.neg{color:#f85149}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #21262d;white-space:nowrap}td.r,th.r{text-align:right}
td.reason{white-space:normal;min-width:260px}.tag{padding:1px 6px;border-radius:8px;color:#fff;font-size:12px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px}
svg{width:100%;height:160px;background:#161b22;border:1px solid #30363d;border-radius:6px}
a{color:#58a6ff}form{margin:6px 0}select,button{font-size:13px}"""


def _t(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts)) + "Z" if ts else "-"


def _n(v, d=2):
    return "-" if v is None else f"{v:,.{d}f}"


def _pnl(v, d=2, suffix=""):
    if v is None:
        return "-"
    return f'<span class="{"pos" if v >= 0 else "neg"}">{v:+,.{d}f}{suffix}</span>'


def equity_svg(totals):
    if len(totals) < 2:
        return '<svg viewBox="0 0 600 160"><text x="300" y="85" fill="#8b949e" text-anchor="middle">no equity data yet</text></svg>'
    step = max(1, len(totals) // 400)
    pts = totals[::step] + ([totals[-1]] if (len(totals) - 1) % step else [])
    lo, hi = min(pts), max(pts)
    span = (hi - lo) or 1.0
    xy = " ".join(f"{i / (len(pts) - 1) * 600:.1f},{150 - (v - lo) / span * 140:.1f}" for i, v in enumerate(pts))
    return (f'<svg viewBox="0 0 600 160" preserveAspectRatio="none"><polyline points="{xy}" fill="none" '
            f'stroke="#58a6ff" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>'
            f'<div class="muted">min {_n(lo)} / max {_n(hi)}</div>')


def render(conn, cfg, symbol="", action="", now=None):
    now = now or time.time()
    s = summary(conn, cfg)
    last = s["last_tick"]
    nxt = (last + cfg.interval_sec) if last else None
    healthy = bool(last) and now - last < cfg.interval_sec * 2 + 30
    dot = f'<span class="dot" style="background:{"#3fb950" if healthy else "#f85149"}"></span>'
    sym_ok = symbol if symbol in cfg.symbols else ""
    act_ok = action if action in ACTIONS else ""
    q, args = "SELECT * FROM decisions", []
    conds = []
    if sym_ok:
        conds.append("symbol=?"); args.append(sym_ok)
    if act_ok:
        conds.append("action=?"); args.append(act_ok)
    if conds:
        q += " WHERE " + " AND ".join(conds)
    decisions = D.rows(conn, q + " ORDER BY id DESC LIMIT 200", args)
    trades = D.rows(conn, "SELECT * FROM trades ORDER BY id DESC")
    positions = D.rows(conn, "SELECT * FROM positions ORDER BY symbol")
    totals = [r["total"] for r in D.rows(conn, "SELECT total FROM equity ORDER BY id")]

    def opts(items, cur):
        return "".join(f'<option value="{escape(i)}"{" selected" if i == cur else ""}>{escape(i)}</option>'
                       for i in items)

    cards = [("Equity", _n(s["equity"])), ("Total P&L", _pnl(s["pnl"]) + " (" + _pnl(s["pnl_pct"], 2, "%") + ")"),
             ("Realised", _pnl(s["realised"])), ("Unrealised", _pnl(s["unrealised"])),
             ("Trades", str(s["trades"])),
             ("Win rate", "-" if s["win_rate"] is None else f'{s["win_rate"]:.0f}%'),
             ("Max drawdown", f'{s["max_drawdown_pct"]:.2f}%')]
    h = [f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
         f'<meta http-equiv="refresh" content="30"><title>paper-bot</title><style>{CSS}</style></head><body>',
         f'<h1>{dot}paper-bot <span class="tag" style="background:#9e6a03">PAPER</span></h1>',
         f'<div class="muted">{escape(", ".join(cfg.symbols))} | {escape(cfg.resolution)} SMA {cfg.fast}/{cfg.slow} | '
         f'notional ${cfg.notional:,.0f} | fee {cfg.fee:.2%} slip {cfg.slippage:.2%} | short {"on" if cfg.allow_short else "off"}<br>'
         f'last tick {_t(last)} | next ~{_t(nxt)} | {"healthy" if healthy else "STALE"}</div>',
         '<div class="cards">' + "".join(f'<div class="card"><span>{k}</span><b>{v}</b></div>' for k, v in cards) + "</div>",
         "<h2>Open positions</h2><div class='wrap'><table><tr><th>Symbol</th><th>Side</th><th class=r>Qty</th>"
         "<th class=r>Entry</th><th class=r>Mark</th><th class=r>Unrealised</th></tr>"]
    for p in positions:
        u = (p["mark"] - p["entry"]) * p["qty"] * (1 if p["side"] == "long" else -1)
        h.append(f'<tr><td>{escape(p["symbol"])}</td><td>{escape(p["side"])}</td><td class=r>{p["qty"]:.6f}</td>'
                 f'<td class=r>{_n(p["entry"])}</td><td class=r>{_n(p["mark"])}</td><td class=r>{_pnl(u)}</td></tr>')
    if not positions:
        h.append('<tr><td colspan=6 class="muted">flat</td></tr>')
    h += ["</table></div><h2>Equity curve</h2>", equity_svg(totals),
          f'<h2>Decisions (latest 200)</h2><form method="get"><select name="symbol"><option value="">all symbols</option>'
          f'{opts(cfg.symbols, sym_ok)}</select> <select name="action"><option value="">all actions</option>'
          f'{opts(ACTIONS, act_ok)}</select> <button>Filter</button></form>',
          "<div class='wrap'><table><tr><th>Time</th><th>Symbol</th><th>Candle</th><th class=r>Close</th>"
          "<th class=r>Fast</th><th class=r>Slow</th><th>Signal</th><th>Action</th><th>Reason</th></tr>"]
    for d in decisions:
        c = COLORS.get(d["action"], "#6e7781")
        h.append(f'<tr><td>{_t(d["ts"])}</td><td>{escape(d["symbol"])}</td><td>{_t(d["candle_time"])}</td>'
                 f'<td class=r>{_n(d["close"])}</td><td class=r>{_n(d["fast"])}</td><td class=r>{_n(d["slow"])}</td>'
                 f'<td>{escape(d["signal"] or "")}</td><td><span class="tag" style="background:{c}">{escape(d["action"])}</span></td>'
                 f'<td class="reason">{escape(d["reason"] or "")}</td></tr>')
    h += ["</table></div><h2>Trades</h2><div class='wrap'><table><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Kind</th>"
          "<th class=r>Qty</th><th class=r>Price</th><th class=r>Fee</th><th class=r>Realised P&amp;L</th></tr>"]
    for t in trades:
        h.append(f'<tr><td>{_t(t["ts"])}</td><td>{escape(t["symbol"])}</td><td>{escape(t["side"])}</td>'
                 f'<td>{escape(t["kind"])}</td><td class=r>{t["qty"]:.6f}</td><td class=r>{_n(t["price"])}</td>'
                 f'<td class=r>{_n(t["fee"], 4)}</td><td class=r>{_pnl(t["pnl"])}</td></tr>')
    if not trades:
        h.append('<tr><td colspan=8 class="muted">no trades yet</td></tr>')
    h.append("</table></div></body></html>")
    return "".join(h)


async def loop(engine, cfg):
    while True:
        try:
            await engine.tick()
        except Exception:
            log.exception("tick failed")
        await asyncio.sleep(cfg.interval_sec)


def create_app(cfg, conn=None, client=None, run_loop=True):
    conn = conn or D.connect(cfg.db_path)

    @asynccontextmanager
    async def lifespan(app):
        c = client or httpx.AsyncClient()
        task = asyncio.create_task(loop(Engine(cfg, conn, c), cfg)) if run_loop else None
        yield
        if task:
            task.cancel()
        if not client:
            await c.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    def index(symbol: str = "", action: str = ""):
        return render(conn, cfg, symbol, action)

    @app.get("/api/decisions")
    def decisions(limit: int = Query(200, ge=1, le=1000)):
        return D.rows(conn, "SELECT * FROM decisions ORDER BY id DESC LIMIT ?", (limit,))

    @app.get("/api/trades")
    def trades():
        return D.rows(conn, "SELECT * FROM trades ORDER BY id DESC")

    @app.get("/api/positions")
    def positions():
        return D.rows(conn, "SELECT * FROM positions ORDER BY symbol")

    @app.get("/api/equity")
    def equity():
        return D.rows(conn, "SELECT ts,cash,unrealised,total FROM equity ORDER BY id")

    @app.get("/api/summary")
    def api_summary():
        return summary(conn, cfg)

    return app
