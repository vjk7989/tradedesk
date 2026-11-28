import asyncio
import csv
import io
import json
import logging
import time
from contextlib import asynccontextmanager, contextmanager
from html import escape
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse, Response

from . import db as D
from .engine import Engine
from .stats import per_symbol, summary

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
    # Index-sampled, not time-sampled: after old equity rows are thinned (db.downsample_equity) the x-axis is not
    # time-proportional and the min/max caption comes from the sampled points. The Max drawdown and Total P&L
    # cards are computed from all rows and stay exact.
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


def valid_filters(cfg, symbol="", action=""):
    """The one whitelist for the HTML filter and the CSV exports: unknown values fall back to 'all'."""
    return (symbol if symbol in cfg.symbols else "", action if action in ACTIONS else "")


def _sanitize(v):
    """Real numbers stay numbers (so negative P&L like -12.5 stays numeric in a spreadsheet); every string is
    neutralised if it could be read as a formula."""
    if v is None:
        return ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    s = str(v)
    # look past leading whitespace too (" =1+1"), but keep the original text after the quote
    return "'" + s if s.lstrip(" \t\r\n\v\f\xa0")[:1] in ("=", "+", "-", "@") or s[:1] in ("\t", "\r", "\n") else s


def to_csv(columns, rows):
    buf = io.StringIO()
    wr = csv.writer(buf, lineterminator="\r\n")
    wr.writerow(columns)
    for r in rows:
        wr.writerow([_sanitize(r.get(c)) for c in columns])
    return buf.getvalue()


def json_rows(rows):
    """Same bytes FastAPI's JSONResponse would produce (compact separators), without the per-row
    jsonable_encoder cost that dominates large lists."""
    return Response(json.dumps(rows, separators=(",", ":"), ensure_ascii=False), media_type="application/json")


def csv_response(body, name):
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


def _iso(ts):
    if not ts:
        return ""
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
    except (TypeError, ValueError, OverflowError, OSError):
        return _sanitize(ts)


def decisions_csv(conn, cfg, symbol="", action=""):
    symbol, action = valid_filters(cfg, symbol, action)
    conds, args = [], []
    if symbol:
        conds.append("symbol=?"); args.append(symbol)
    if action:
        conds.append("action=?"); args.append(action)
    rows = D.rows(conn, "SELECT * FROM decisions" + (" WHERE " + " AND ".join(conds) if conds else "") +
                  " ORDER BY id DESC", args)
    for r in rows:
        r["time_utc"], r["candle_utc"] = _iso(r["ts"]), _iso(r["candle_time"])
    return to_csv(["id", "ts", "time_utc", "symbol", "candle_time", "candle_utc", "close", "fast", "slow",
                   "signal", "action", "reason"], rows)


def trades_csv(conn, cfg, symbol="", action=""):
    """action filters trades to fills written by a decision with that action (same ts and symbol)."""
    symbol, action = valid_filters(cfg, symbol, action)
    conds, args = [], []
    if symbol:
        conds.append("symbol=?"); args.append(symbol)
    if action:
        conds.append("(ts, symbol) IN (SELECT ts, symbol FROM decisions WHERE action=?)")
        args.append(action)
    rows = D.rows(conn, "SELECT * FROM trades" + (" WHERE " + " AND ".join(conds) if conds else "") +
                  " ORDER BY id DESC", args)
    for r in rows:
        r["time_utc"] = _iso(r["ts"])
    return to_csv(["id", "ts", "time_utc", "symbol", "side", "kind", "qty", "price", "fee", "pnl"], rows)


DEFAULT_LIMIT, MAX_LIMIT = 200, 1000
MAX_ID = 2 ** 63 - 1  # SQLite INTEGER range
TRADES_SHOWN = 500  # dashboard trades table; the full list stays in /api/trades and trades.csv


def page_params(before="", limit=""):
    """Dashboard pagination, validated like the filters: anything invalid silently falls back to the default."""
    b = int(before) if before.isascii() and before.isdigit() and 0 < int(before) <= MAX_ID else None
    n = int(limit) if limit.isascii() and limit.isdigit() and 1 <= int(limit) <= MAX_LIMIT else DEFAULT_LIMIT
    return b, n


def render(conn, cfg, symbol="", action="", now=None, before="", limit=""):
    now = now or time.time()
    s = summary(conn, cfg)
    last = s["last_tick"]
    nxt = (last + next_delay(cfg, last)) if last else None
    healthy = bool(last) and now - last < cfg.interval_sec * 2 + 30
    dot = f'<span class="dot" style="background:{"#3fb950" if healthy else "#f85149"}"></span>'
    sym_ok, act_ok = valid_filters(cfg, symbol, action)
    q, args = "SELECT * FROM decisions", []
    conds = []
    if sym_ok:
        conds.append("symbol=?"); args.append(sym_ok)
    if act_ok:
        conds.append("action=?"); args.append(act_ok)
    before_id, n = page_params(before, limit)
    if before_id:
        conds.append("id<?"); args.append(before_id)
    if conds:
        q += " WHERE " + " AND ".join(conds)
    decisions = D.rows(conn, q + " ORDER BY id DESC LIMIT ?", args + [n + 1])
    title = (f"{n} per page, before id {before_id}" if before_id else f"latest {n}")
    more = len(decisions) > n  # fetched one extra row only to know whether an older page exists
    decisions = decisions[:n]
    trades = D.rows(conn, "SELECT * FROM trades ORDER BY id DESC LIMIT ?", (TRADES_SHOWN + 1,))
    trades_cut = len(trades) > TRADES_SHOWN
    trades = trades[:TRADES_SHOWN]
    positions = D.rows(conn, "SELECT * FROM positions ORDER BY symbol")
    totals = [r[0] for r in conn.execute("SELECT total FROM equity ORDER BY id")]

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
          "<h2>Per symbol</h2><div class='cards'>"]
    for ps in per_symbol(conn, cfg):
        ld = ps["last_decision"]
        wr = "-" if ps["win_rate"] is None else f'{ps["win_rate"]:.0f}%'
        last_txt = (f'{escape(ld["action"])}: {escape(ld["reason"] or "")}' if ld else "no decision yet")
        h.append(f'<div class="card"><span>{escape(ps["symbol"])} ({escape(ps["side"])})</span>'
                 f'<b>{_pnl(ps["realised"])}</b><span>realised (incl. open entry fee)</span><br>'
                 f'<span>unrealised {_pnl(ps["unrealised"])} | trades {ps["trades"]} | win rate {wr}</span><br>'
                 f'<span>last: {last_txt}</span></div>')
    qs = "?" + urlencode({k: v for k, v in (("symbol", sym_ok), ("action", act_ok)) if v})
    qs = "" if qs == "?" else qs
    h += ["</div>", f'<div class="muted">Download: <a href="/api/trades.csv{qs}">trades.csv</a> | '
          f'<a href="/api/decisions.csv{qs}">decisions.csv</a></div>',
          f'<h2>Decisions ({title})</h2><form method="get"><select name="symbol"><option value="">all symbols</option>'
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
    older_link = ""
    if before_id:
        newest = urlencode({k: v for k, v in (("symbol", sym_ok), ("action", act_ok),
                                              ("limit", n if n != DEFAULT_LIMIT else "")) if v != ""})
        older_link = f'<div class="muted"><a href="/{"?" + newest if newest else ""}">newest decisions</a></div>'
    if more and decisions:
        older = urlencode({k: v for k, v in (("symbol", sym_ok), ("action", act_ok), ("before", decisions[-1]["id"]),
                                             ("limit", n if n != DEFAULT_LIMIT else "")) if v != ""})
        older_link += f'<div class="muted"><a href="/?{older}">older decisions</a></div>'
    h += [f"</table></div>{older_link}<h2>Trades</h2><div class='wrap'><table><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Kind</th>"
          "<th class=r>Qty</th><th class=r>Price</th><th class=r>Fee</th><th class=r>Realised P&amp;L</th></tr>"]
    for t in trades:
        h.append(f'<tr><td>{_t(t["ts"])}</td><td>{escape(t["symbol"])}</td><td>{escape(t["side"])}</td>'
                 f'<td>{escape(t["kind"])}</td><td class=r>{t["qty"]:.6f}</td><td class=r>{_n(t["price"])}</td>'
                 f'<td class=r>{_n(t["fee"], 4)}</td><td class=r>{_pnl(t["pnl"])}</td></tr>')
    if not trades:
        h.append('<tr><td colspan=8 class="muted">no trades yet</td></tr>')
    if trades_cut:
        h.append(f'</table></div><div class="muted">latest {TRADES_SHOWN} trades shown; '
                 f'<a href="/api/trades.csv">trades.csv</a> has all of them</div></body></html>')
    else:
        h.append("</table></div></body></html>")
    return "".join(h)


def next_delay(cfg, now):
    """Seconds until the next tick: just after the next candle close when INTERVAL_SEC >= candle period,
    else a plain INTERVAL_SEC sleep (fast smoke/debug runs)."""
    if cfg.interval_sec < cfg.period:
        return cfg.interval_sec
    return (now // cfg.period + 1) * cfg.period + cfg.align_delay - now


async def loop(engine, cfg, detail_days=D.EQUITY_DETAIL_DAYS):
    while True:
        try:
            await engine.tick()
        except Exception:
            log.exception("tick failed")
        try:
            # Daily, right after a tick and on the same writer connection (so never concurrent with one). The
            # downsample commits in short batches; the next tick is minutes away.
            t0 = time.perf_counter()
            n = await asyncio.to_thread(D.maintain, engine.db, detail_days)
            if n is not None:
                log.info("maintenance: %d equity rows thinned in %.0f ms", n, (time.perf_counter() - t0) * 1000)
        except Exception:
            log.exception("maintenance failed")
        await asyncio.sleep(next_delay(cfg, time.time()))


def create_app(cfg, conn=None, client=None, run_loop=True):
    detail_days = D.equity_detail_days()  # fail at startup on a bad EQUITY_DETAIL_DAYS, like Config.validate
    conn = conn or D.connect(cfg.db_path)  # the writer: only the strategy loop uses it
    path = D.db_file(conn)

    @contextmanager
    def reader():
        r = D.connect_ro(path)
        try:
            yield r
        finally:
            r.close()

    @asynccontextmanager
    async def lifespan(app):
        c = client or httpx.AsyncClient()
        task = asyncio.create_task(loop(Engine(cfg, conn, c), cfg, detail_days)) if run_loop else None
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
    def index(symbol: str = "", action: str = "", before: str = "", limit: str = ""):
        with reader() as r:
            return render(r, cfg, symbol, action, before=before, limit=limit)

    @app.get("/api/decisions")
    def decisions(limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT), before: int | None = Query(None, ge=1, le=MAX_ID)):
        """Newest first; `before=<id>` returns the page of rows with a smaller id (keyset pagination)."""
        with reader() as r:
            if before is None:
                return D.rows(r, "SELECT * FROM decisions ORDER BY id DESC LIMIT ?", (limit,))
            return D.rows(r, "SELECT * FROM decisions WHERE id<? ORDER BY id DESC LIMIT ?", (before, limit))

    @app.get("/api/trades")
    def trades():
        with reader() as r:
            return json_rows(D.rows(r, "SELECT * FROM trades ORDER BY id DESC"))

    @app.get("/api/trades.csv")
    def trades_export(symbol: str = "", action: str = ""):
        with reader() as r:
            return csv_response(trades_csv(r, cfg, symbol, action), "trades.csv")

    @app.get("/api/decisions.csv")
    def decisions_export(symbol: str = "", action: str = ""):
        with reader() as r:
            return csv_response(decisions_csv(r, cfg, symbol, action), "decisions.csv")

    @app.get("/api/positions")
    def positions():
        with reader() as r:
            return D.rows(r, "SELECT * FROM positions ORDER BY symbol")

    @app.get("/api/equity")
    def equity():
        with reader() as r:
            r.row_factory = None  # plain tuples: much cheaper than sqlite3.Row -> dict for ~10^5 rows
            rs = r.execute("SELECT ts,cash,unrealised,total FROM equity ORDER BY id").fetchall()
        return json_rows([{"ts": a, "cash": b, "unrealised": c, "total": d} for a, b, c, d in rs])

    @app.get("/api/summary")
    def api_summary():
        with reader() as r:
            return summary(r, cfg)

    return app
