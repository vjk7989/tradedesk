"""TM2-72: per-symbol P&L card row and CSV export (/api/trades.csv, /api/decisions.csv).

Fixture DBs are written with the real Engine primitives (_open, _close, _decision, snapshot), so fills, fees and
cash follow the engine's own accounting. Expected numbers are recomputed here from the engine's published formulas.
"""
import csv
import io
import os
import time

import pytest
from fastapi.testclient import TestClient

from paper_bot import db as D
from paper_bot.config import Config
from paper_bot.engine import Engine
from paper_bot.stats import per_symbol, summary
from paper_bot.web import create_app

P = 300
T0 = 1_700_000_000 - 1_700_000_000 % P
N, FEE, SLIP, CAP = 1000.0, 0.0005, 0.0002, 10000.0
TR_COLS = ["id", "ts", "time_utc", "symbol", "side", "kind", "qty", "price", "fee", "pnl"]
DEC_COLS = ["id", "ts", "time_utc", "symbol", "candle_time", "candle_utc", "close", "fast", "slow", "signal",
            "action", "reason"]
ACTIONS = ("open", "reverse", "close", "hold", "skip")
LABEL = "realised (incl. open entry fee)"


def ts(k):
    return float(T0 + k * P + 5)


# ------------------------------------------------------------------ fixture builder (real engine primitives)
class Book:
    def __init__(self, tmp_path, symbols, cfg=None):
        self.cfg = cfg or Config(symbols=symbols, data_dir=str(tmp_path))
        self.conn = D.connect(self.cfg.db_path)
        self.eng = Engine(self.cfg, self.conn, None)  # client unused: we never call tick()

    def step(self, t, sym, action, price=None, reason="", side=None):
        e = self.eng
        if action == "skip":
            e._decision(t, sym, None, None, None, None, "hold", "skip", reason)
            return
        e.db.execute("UPDATE positions SET mark=? WHERE symbol=?", (price, sym))
        signal = action if action == "hold" else ("flat" if action == "close" else side)
        if action == "open":
            e._open(sym, side, price, t)
        elif action == "close":
            e._close(sym, price, t)
        elif action == "reverse":
            e._close(sym, price, t)
            e._open(sym, side, price, t)
        e._decision(t, sym, int(t - t % P), price, price + 1, price - 1, signal, action, reason)

    def end_tick(self, t):
        self.eng.snapshot(t)
        D.set_state(self.conn, "last_tick", t)

    def client(self, **kw):
        return TestClient(create_app(self.cfg, self.conn, run_loop=False), **kw)


# independent re-statement of the engine's fill / fee formulas
def leg_open(price, side):
    f = price * (1 + SLIP) if side == "long" else price * (1 - SLIP)
    q = N / f
    return f, q, q * f * FEE


def leg_close(entry, q, entry_fee, price, side):
    long = side == "long"
    f = price * (1 - SLIP) if long else price * (1 + SLIP)
    fee = q * f * FEE
    gross = (f - entry) * q * (1 if long else -1)
    return gross - fee - entry_fee


def unreal(entry, q, mark, side):
    return (mark - entry) * q * (1 if side == "long" else -1)


R = {  # reasons, as the engine phrases them
    "btc_open": "fast 101.00 crossed above slow 100.00 → open long",
    "btc_rev": "fast 109.00 crossed below slow 110.00 → close long, open short",
    "btc_close": "fast 116.00 crossed above slow 115.00 → close short",
    "btc_short": "fast 111.00 crossed below slow 112.00 → open short",
    "btc_hold": "no cross → hold",
    "eth_open": "fast 201.00 crossed above slow 200.00 → open long",
    "eth_hold": "fast 190.00 crossed above slow 189.00 → already long, hold",
    "sol_skip": "data error: http 403",
}


def fx_empty(tmp_path):
    b = Book(tmp_path, ("BTCUSD", "ETHUSD"))
    exp = {s: dict(realised=0.0, unrealised=0.0, trades=0, closed_trades=0, win_rate=None, side="flat", last=None)
           for s in ("BTCUSD", "ETHUSD")}
    return b, exp


def fx_one(tmp_path):
    b = Book(tmp_path, ("BTCUSD",))
    b.step(ts(1), "BTCUSD", "open", 100.0, R["btc_open"], "long"); b.end_tick(ts(1))
    b.step(ts(2), "BTCUSD", "hold", 110.0, R["btc_hold"]); b.end_tick(ts(2))
    f, q, fee = leg_open(100.0, "long")
    exp = {"BTCUSD": dict(realised=-fee, unrealised=unreal(f, q, 110.0, "long"), trades=1, closed_trades=0,
                          win_rate=None, side="long", last=("hold", R["btc_hold"]))}
    return b, exp


def fx_two(tmp_path):
    b = Book(tmp_path, ("BTCUSD", "ETHUSD"))
    b.step(ts(1), "BTCUSD", "open", 100.0, R["btc_open"], "long")
    b.step(ts(1), "ETHUSD", "open", 50.0, "fast 49 crossed below slow 50 → open short", "short"); b.end_tick(ts(1))
    b.step(ts(2), "BTCUSD", "close", 120.0, "fast 119 crossed below slow 120 → close long")
    b.step(ts(2), "ETHUSD", "hold", 45.0, "no cross → hold"); b.end_tick(ts(2))
    bf, bq, bfee = leg_open(100.0, "long")
    ef, eq, efee = leg_open(50.0, "short")
    exp = {"BTCUSD": dict(realised=leg_close(bf, bq, bfee, 120.0, "long"), unrealised=0.0, trades=2,
                          closed_trades=1, win_rate=100.0, side="flat",
                          last=("close", "fast 119 crossed below slow 120 → close long")),
           "ETHUSD": dict(realised=-efee, unrealised=unreal(ef, eq, 45.0, "short"), trades=1, closed_trades=0,
                          win_rate=None, side="short", last=("hold", "no cross → hold"))}
    return b, exp


def fx_reversal(tmp_path, cfg=None):
    """BTC: open long, reverse to short (win), close short (loss), open short, hold. ETH: open-only long.
    SOL: skip-only."""
    b = Book(tmp_path, ("BTCUSD", "ETHUSD", "SOLUSD"), cfg)
    eth = [None, 200.0, 195.0, 192.0, 190.0, 190.0]
    btc = [None, ("open", 100.0, "btc_open", "long"), ("reverse", 110.0, "btc_rev", "short"),
           ("close", 115.0, "btc_close", None), ("open", 112.0, "btc_short", "short"), ("hold", 108.0, "btc_hold", None)]
    for k in range(1, 6):
        a, px, r, side = btc[k]
        b.step(ts(k), "BTCUSD", a, px, R[r], side)
        b.step(ts(k), "ETHUSD", "open" if k == 1 else "hold", eth[k], R["eth_open" if k == 1 else "eth_hold"], "long")
        b.step(ts(k), "SOLUSD", "skip", reason=R["sol_skip"])
        b.end_tick(ts(k))
    f1, q1, fee1 = leg_open(100.0, "long")
    net1 = leg_close(f1, q1, fee1, 110.0, "long")
    f2, q2, fee2 = leg_open(110.0, "short")
    net2 = leg_close(f2, q2, fee2, 115.0, "short")
    f3, q3, fee3 = leg_open(112.0, "short")
    ef, eq, efee = leg_open(200.0, "long")
    assert net1 > 0 > net2  # one win, one loss
    exp = {"BTCUSD": dict(realised=net1 + net2 - fee3, unrealised=unreal(f3, q3, 108.0, "short"), trades=5,
                          closed_trades=2, win_rate=50.0, side="short", last=("hold", R["btc_hold"])),
           "ETHUSD": dict(realised=-efee, unrealised=unreal(ef, eq, 190.0, "long"), trades=1, closed_trades=0,
                          win_rate=None, side="long", last=("hold", R["eth_hold"])),
           "SOLUSD": dict(realised=0.0, unrealised=0.0, trades=0, closed_trades=0, win_rate=None, side="flat",
                          last=("skip", R["sol_skip"]))}
    return b, exp


FIXTURES = {"empty": fx_empty, "one": fx_one, "two": fx_two, "reversal": fx_reversal}


# ------------------------------------------------------------------ 1. per-symbol numbers
@pytest.mark.parametrize("name", list(FIXTURES))
def test_per_symbol_numbers(tmp_path, name):
    b, exp = FIXTURES[name](tmp_path)
    got = {p["symbol"]: p for p in per_symbol(b.conn, b.cfg)}
    assert list(got) == list(exp)  # config order, nothing extra
    for sym, e in exp.items():
        g = got[sym]
        assert g["realised"] == pytest.approx(e["realised"], abs=1e-9), sym
        assert g["unrealised"] == pytest.approx(e["unrealised"], abs=1e-9), sym
        for k in ("trades", "closed_trades", "win_rate", "side"):
            assert g[k] == e[k], (sym, k)
        if e["last"] is None:
            assert g["last_decision"] is None
        else:
            assert (g["last_decision"]["action"], g["last_decision"]["reason"]) == e["last"]


@pytest.mark.parametrize("name", list(FIXTURES))
def test_per_symbol_sums_equal_global(tmp_path, name):
    b, _ = FIXTURES[name](tmp_path)
    s = summary(b.conn, b.cfg)
    ps = per_symbol(b.conn, b.cfg)
    real, unr = sum(p["realised"] for p in ps), sum(p["unrealised"] for p in ps)
    assert real == pytest.approx(s["realised"], abs=1e-9)
    assert unr == pytest.approx(s["unrealised"], abs=1e-9)
    assert real == pytest.approx(D.get_cash(b.conn, CAP) - CAP, abs=1e-9)
    assert sum(p["trades"] for p in ps) == s["trades"]
    assert sum(p["closed_trades"] for p in ps) == s["closed_trades"]


def _card(html, sym):
    i = html.index(f'<div class="card"><span>{sym} (')
    return html[i:html.index("</div>", i)]


def test_per_symbol_card_row_html(tmp_path):
    b, exp = fx_reversal(tmp_path)
    with b.client() as c:
        html = c.get("/").text
    row = html[html.index("<h2>Per symbol</h2>"):html.index("<h2>Decisions")]
    assert row.count('<div class="card">') == 3
    eth = _card(html, "ETHUSD")  # open-only: realised is minus the entry fee, labelled as such
    assert eth.startswith('<div class="card"><span>ETHUSD (long)</span><b><span class="neg">-0.50</span></b>'
                          f"<span>{LABEL}</span>")
    assert "trades 1 | win rate -" in eth and f"last: hold: {R['eth_hold']}" in eth
    assert f'unrealised <span class="neg">{exp["ETHUSD"]["unrealised"]:+,.2f}</span>' in eth
    btc = _card(html, "BTCUSD")
    assert "BTCUSD (short)" in btc and "trades 5 | win rate 50%" in btc and f"last: hold: {R['btc_hold']}" in btc
    assert f'{exp["BTCUSD"]["realised"]:+,.2f}</span></b><span>{LABEL}</span>' in btc
    sol = _card(html, "SOLUSD")
    assert "SOLUSD (flat)" in sol and "trades 0 | win rate -" in sol and f"last: skip: {R['sol_skip']}" in sol
    assert '<span class="pos">+0.00</span>' in sol


def test_per_symbol_card_row_empty_db(tmp_path):
    b, _ = fx_empty(tmp_path)
    with b.client() as c:
        html = c.get("/").text
    for s in ("BTCUSD", "ETHUSD"):
        card = _card(html, s)
        assert f"{s} (flat)" in card and "last: no decision yet" in card and "trades 0 | win rate -" in card


# ------------------------------------------------------------------ 2. HTML page: existing elements intact
CARD_LABELS = ("Equity", "Total P&L", "Realised", "Unrealised", "Trades", "Win rate", "Max drawdown")
FILTERS = [  # (query, valid symbol, valid action)
    ("", "", ""), ("?symbol=BTCUSD", "BTCUSD", ""), ("?action=open", "", "open"),
    ("?symbol=BTCUSD&action=reverse", "BTCUSD", "reverse"), ("?symbol=&action=", "", ""),
    ("?symbol=ZZZ", "", ""), ("?symbol=btcusd", "", ""), ("?action=OPEN", "", ""), ("?action=bogus", "", ""),
    ("?symbol=ZZZ&action=open", "", "open"), ("?symbol=ETHUSD&action=nope", "ETHUSD", ""),
    ("?symbol=%27%20OR%201%3D1--", "", ""),
]


@pytest.mark.parametrize("q,sym,act", FILTERS)
def test_html_page_renders_with_filters(tmp_path, q, sym, act):
    b, _ = fx_reversal(tmp_path)
    decs = D.rows(b.conn, "SELECT * FROM decisions")
    n_dec = sum(1 for d in decs if (not sym or d["symbol"] == sym) and (not act or d["action"] == act))
    with b.client() as c:
        r = c.get("/" + q)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    h = r.text
    assert h.startswith("<!doctype html>") and h.endswith("</body></html>")
    assert 'paper-bot <span class="tag" style="background:#9e6a03">PAPER</span>' in h
    for k in CARD_LABELS:
        assert f'<div class="card"><span>{k}</span><b>' in h
    for t in ("<h2>Open positions</h2>", "<h2>Equity curve</h2>", "<h2>Per symbol</h2>",
              "<h2>Decisions (latest 200)</h2>", "<h2>Trades</h2>"):
        assert h.count(t) == 1
    assert '<select name="symbol"><option value="">all symbols</option>' in h
    assert '<select name="action"><option value="">all actions</option>' in h
    for s in b.cfg.symbols:
        assert f'<option value="{s}"{" selected" if s == sym else ""}>' in h
    for a in ACTIONS:
        assert f'<option value="{a}"{" selected" if a == act else ""}>' in h
    assert h.count(" selected>") == bool(sym) + bool(act)
    # download links carry only the valid filters
    qs = "&".join(f"{k}={v}" for k, v in (("symbol", sym), ("action", act)) if v)
    qs = "?" + qs if qs else ""
    assert f'<a href="/api/trades.csv{qs}">trades.csv</a>' in h
    assert f'<a href="/api/decisions.csv{qs}">decisions.csv</a>' in h
    # decisions table follows the (whitelisted) filter; trades table always shows every fill
    assert h.count('<td class="reason">') == n_dec
    trades_tbl = h[h.index("<h2>Trades</h2>"):]
    assert trades_tbl.count("<tr><td>") == 6
    assert h.count("<tr><td>BTCUSD</td><td>short</td>") == 1  # open positions table


def test_html_empty_db(tmp_path):
    b, _ = fx_empty(tmp_path)
    with b.client() as c:
        for q in ("", "?symbol=BTCUSD&action=open", "?action=zzz"):
            h = c.get("/" + q).text
            assert "no trades yet" in h and '<td colspan=6 class="muted">flat</td>' in h and "no equity data yet" in h
            assert "<h2>Per symbol</h2>" in h and 'href="/api/trades.csv' in h


# ------------------------------------------------------------------ 3. CSV routes
def _csv(c, path, **params):
    r = c.get(path, params=params)
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/csv; charset=utf-8"
    name = path.rsplit("/", 1)[1]
    assert r.headers["content-disposition"] == f'attachment; filename="{name}"'
    return r, list(csv.DictReader(io.StringIO(r.text, newline="")))


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else ""


def _cell(v):
    return "" if v is None else str(v)


def _expected(conn, table, keep):
    out = []
    for r in D.rows(conn, f"SELECT * FROM {table} ORDER BY id DESC"):
        if not keep(r):
            continue
        e = {k: _cell(v) for k, v in r.items()}
        e["time_utc"] = _iso(r["ts"])
        if table == "decisions":
            e["candle_utc"] = _iso(r["candle_time"])
        out.append(e)
    return out


@pytest.mark.parametrize("name", list(FIXTURES))
def test_csv_all_rows_newest_first_roundtrip(tmp_path, name):
    b, _ = FIXTURES[name](tmp_path)
    with b.client() as c:
        rt, trows = _csv(c, "/api/trades.csv")
        rd, drows = _csv(c, "/api/decisions.csv")
    assert rt.text.splitlines()[0] == ",".join(TR_COLS) and rd.text.splitlines()[0] == ",".join(DEC_COLS)
    assert rt.text.endswith("\r\n") and "\r\n" in rd.text
    assert trows == _expected(b.conn, "trades", lambda r: True)
    assert drows == _expected(b.conn, "decisions", lambda r: True)
    for rows in (trows, drows):
        ids = [int(r["id"]) for r in rows]
        assert ids == sorted(ids, reverse=True)
        assert [float(r["ts"]) for r in rows] == sorted((float(r["ts"]) for r in rows), reverse=True)
    # numbers round-trip exactly
    db_tr = {r["id"]: r for r in D.rows(b.conn, "SELECT * FROM trades")}
    for r in trows:
        d = db_tr[int(r["id"])]
        for k in ("ts", "qty", "price", "fee"):
            assert float(r[k]) == d[k]
        assert (r["pnl"] == "") == (d["pnl"] is None) and (d["pnl"] is None or float(r["pnl"]) == d["pnl"])


def test_csv_reversal_counts(tmp_path):
    b, _ = fx_reversal(tmp_path)
    with b.client() as c:
        _, trows = _csv(c, "/api/trades.csv")
        _, drows = _csv(c, "/api/decisions.csv")
    assert len(trows) == 6 and len(drows) == 15
    assert [(r["symbol"], r["kind"], r["side"]) for r in trows][:3] == [
        ("BTCUSD", "open", "sell"), ("BTCUSD", "close", "buy"), ("BTCUSD", "open", "sell")]
    pnl = [float(r["pnl"]) for r in trows if r["kind"] == "close"]
    assert len(pnl) == 2 and pnl[0] < 0 < pnl[1]  # newest (short loss) first, its "-" not prefixed


def test_trades_action_filter_matches_decision_action(tmp_path):
    b, _ = fx_reversal(tmp_path)
    want = {"open": {(ts(1), "BTCUSD", "open"), (ts(1), "ETHUSD", "open"), (ts(4), "BTCUSD", "open")},
            "reverse": {(ts(2), "BTCUSD", "close"), (ts(2), "BTCUSD", "open")},
            "close": {(ts(3), "BTCUSD", "close")}, "hold": set(), "skip": set()}
    with b.client() as c:
        for a, w in want.items():
            _, rows = _csv(c, "/api/trades.csv", action=a)
            got = [(float(r["ts"]), r["symbol"], r["kind"]) for r in rows]
            assert set(got) == w and len(got) == len(w), a
            assert [int(r["id"]) for r in rows] == sorted((int(r["id"]) for r in rows), reverse=True)
        _, rows = _csv(c, "/api/trades.csv", action="open", symbol="ETHUSD")
        assert [(r["symbol"], r["kind"]) for r in rows] == [("ETHUSD", "open")]


VALID = [("", ""), ("BTCUSD", ""), ("ETHUSD", ""), ("SOLUSD", "")] + [("", a) for a in ACTIONS] + \
        [("BTCUSD", a) for a in ACTIONS] + [("SOLUSD", "skip"), ("ETHUSD", "hold")]
INVALID = ["ZZZ", "btcusd", "OPEN", "Open", " open", "' OR 1=1--", "%", "*", "BTCUSD,ETHUSD"]


def test_csv_filters_same_whitelist_as_html(tmp_path):
    b, _ = fx_reversal(tmp_path)
    decs = D.rows(b.conn, "SELECT * FROM decisions")
    with b.client() as c:
        for sym, act in VALID:
            params = {k: v for k, v in (("symbol", sym), ("action", act)) if v}
            _, drows = _csv(c, "/api/decisions.csv", **params)
            assert drows == _expected(b.conn, "decisions", lambda r: (not sym or r["symbol"] == sym) and
                                      (not act or r["action"] == act)), params
            keys = {(d["ts"], d["symbol"]) for d in decs if d["action"] == act}
            _, trows = _csv(c, "/api/trades.csv", **params)
            assert trows == _expected(b.conn, "trades", lambda r: (not sym or r["symbol"] == sym) and
                                      (not act or (r["ts"], r["symbol"]) in keys)), params
            # the HTML link for this filter points at exactly this export
            assert f'href="/api/trades.csv{"?" if params else ""}' in c.get("/", params=params).text
        all_t, all_d = _csv(c, "/api/trades.csv")[1], _csv(c, "/api/decisions.csv")[1]
        for bad in INVALID:
            for k in ("symbol", "action"):
                assert _csv(c, "/api/trades.csv", **{k: bad})[1] == all_t, (k, bad)
                assert _csv(c, "/api/decisions.csv", **{k: bad})[1] == all_d, (k, bad)
                assert c.get("/", params={k: bad}).status_code == 200
        # one valid + one invalid: the valid one still applies
        _, rows = _csv(c, "/api/decisions.csv", symbol="SOLUSD", action="bogus")
        assert len(rows) == 5 and {r["symbol"] for r in rows} == {"SOLUSD"}
        _, rows = _csv(c, "/api/decisions.csv", symbol="", action="")
        assert rows == all_d


# ------------------------------------------------------------------ 4. CSV injection
PAYLOADS = ["=1+1", "+1", "-1+cmd", "@SUM(1)", "\t=1+1", "\tplain", "\r=1+1", "\rplain", "\n=1+1", "\nplain",
            " =1+1", "\xa0=1+1", "=HYPERLINK(\"http://e\",\"x\")", "-", "=cmd|' /C calc'!A0"]
TEXT_TR = ("symbol", "side", "kind")
TEXT_DEC = ("symbol", "signal", "action", "reason")


def test_csv_injection_neutralised_in_every_text_column(tmp_path):
    b = Book(tmp_path, ("BTCUSD",))
    for i, p in enumerate(PAYLOADS):
        for col in TEXT_DEC:
            v = {"symbol": "BTCUSD", "signal": "long", "action": "hold", "reason": "ok", col: p}
            b.eng._decision(float(i + 1), v["symbol"], 1, 1.0, 1.0, 1.0, v["signal"], v["action"], v["reason"])
        for col in TEXT_TR:
            v = {"symbol": "BTCUSD", "side": "buy", "kind": "close", col: p}
            b.conn.execute("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,1,1,0,-12.5)",
                           (float(i + 1), v["symbol"], v["side"], v["kind"]))
    with b.client() as c:
        _, trows = _csv(c, "/api/trades.csv")
        _, drows = _csv(c, "/api/decisions.csv")
    assert len(trows) == len(PAYLOADS) * len(TEXT_TR) and len(drows) == len(PAYLOADS) * len(TEXT_DEC)
    seen = set()
    for rows, cols in ((trows, TEXT_TR), (drows, TEXT_DEC)):
        for r in rows:
            for col in cols:
                v = r[col]
                if v.startswith("'"):
                    assert v[1:] in PAYLOADS, (col, v)  # prefixed, original text kept
                    seen.add((col, v[1:]))
                else:
                    assert v not in PAYLOADS and v in ("BTCUSD", "buy", "close", "long", "hold", "ok"), (col, v)
                # nothing a spreadsheet would evaluate: first char never = + - @ tab CR LF, nor after whitespace
                assert v[:1] not in ("=", "+", "-", "@", "\t", "\r", "\n")
                assert v.lstrip(" \t\r\n\xa0")[:1] not in ("=", "+", "-", "@")
    assert seen == {(c, p) for c in TEXT_TR + TEXT_DEC for p in PAYLOADS}
    # numeric negative P&L stays a plain number
    assert {r["pnl"] for r in trows} == {"-12.5"}


def test_csv_numbers_unprefixed_and_nan_empty(tmp_path):
    b = Book(tmp_path, ("BTCUSD",))
    b.conn.execute("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(1,'BTCUSD','sell','close',"
                   "1.5,2,0.25,-12.5)")
    b.conn.execute("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(2,'BTCUSD','sell','close',"
                   "1,1,0,?)", (float("nan"),))
    b.eng._decision(3.0, "BTCUSD", 1, -5.0, float("nan"), -0.001, "short", "hold", "plain text, with comma")
    with b.client() as c:
        rt, trows = _csv(c, "/api/trades.csv")
        _, drows = _csv(c, "/api/decisions.csv")
    assert trows[1]["pnl"] == "-12.5" and float(trows[1]["pnl"]) == -12.5
    assert "BTCUSD,sell,close,1.5,2.0,0.25,-12.5\r\n" in rt.text
    assert trows[0]["pnl"] == ""  # NaN is stored as NULL -> empty cell, never "nan"
    d = drows[0]
    assert (d["close"], d["fast"], d["slow"]) == ("-5.0", "", "-0.001")
    assert d["reason"] == "plain text, with comma"


# ------------------------------------------------------------------ 5. no secrets
def test_no_secrets_in_csv_or_card_row(tmp_path, monkeypatch):
    fake = {"DASH_USER": "SEKRETUSER_dash", "DASH_PASSWORD_HASH": "$2a$14$SEKRETHASHabcdefghijklmnopqrstuv",
            "DELTA_API_KEY": "SEKRETKEY_9f8e7d", "DELTA_API_SECRET": "SEKRETSEC_1a2b3c",
            "DELTA_BASE_URL": "https://u:SEKRETURL_zz@fake-delta.example.test",
            "DATA_DIR": str(tmp_path / "SEKRETDIR_data"), "SYMBOLS": "BTCUSD,ETHUSD,SOLUSD"}
    for k, v in fake.items():
        monkeypatch.setenv(k, v)
    cfg = Config.from_env(os.environ)
    assert cfg.base_url.startswith("https://u:SEKRETURL")
    b, _ = fx_reversal(tmp_path, cfg)
    with b.client() as c:
        bodies = []
        for path in ("/api/trades.csv", "/api/decisions.csv"):
            for sym, act in VALID + [("ZZZ", "bogus")]:
                bodies.append(_csv(c, path, symbol=sym, action=act)[0].text)
        html = c.get("/").text
    row = html[html.index("<h2>Per symbol</h2>"):html.index("<h2>Decisions")]
    blob = "\n".join(bodies + [row, html])
    for needle in ("SEKRET", "fake-delta.example.test", "$2a$14$", str(tmp_path), "paper.db"):
        assert needle not in blob, needle


# ------------------------------------------------------------------ 6. performance guard
def test_trades_csv_action_filter_is_fast_on_large_db(tmp_path):
    """60k decisions, 1.5k trades (3 symbols, about 10 weeks at 5m). The first version of the filter was a
    correlated EXISTS on decisions(ts, symbol) with no index, so it rescanned the decisions table for every trade:
    about 14 s here. The IN-subquery builds the set once: about 0.06 s. The 2 s bound is deliberately generous so a
    slow CI runner stays green while the quadratic query still fails it. (At 20k decisions / 500 trades the old
    query took only about 0.7 s, too close to the fixed query to tell apart with a CI-safe bound.)"""
    syms = ("BTCUSD", "ETHUSD", "SOLUSD")
    b = Book(tmp_path, syms)
    b.conn.execute("BEGIN")
    for i in range(20_000):
        t = ts(i)
        for sym in syms:
            if i % 40 == 0:
                act = "open" if (i // 40) % 2 == 0 else "close"
                b.step(t, sym, act, 100.0 + i % 7, f"{act} {i}", "long")
            else:
                b.step(t, sym, "hold", 100.0 + i % 7, "no cross → hold")
    b.conn.execute("COMMIT")
    assert b.conn.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] == 60_000
    assert b.conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0] == 1_500
    with b.client() as c:
        c.get("/api/trades.csv")  # warm up
        t0 = time.perf_counter()
        _, rows = _csv(c, "/api/trades.csv", action="open")
        elapsed = time.perf_counter() - t0
    assert len(rows) == 750 and {r["kind"] for r in rows} == {"open"}
    assert elapsed < 2.0, f"/api/trades.csv?action=open took {elapsed:.2f}s"


# ------------------------------------------------------------------ 7. bad ts values
def test_bad_ts_values_do_not_500(tmp_path):
    b = Book(tmp_path, ("BTCUSD",))
    b.conn.execute("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                   " VALUES('garbage','BTCUSD','=1+1',1,1,1,'long','hold','x')")
    b.conn.execute("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                   " VALUES(1e300,'BTCUSD',NULL,1,1,1,'long','hold','y')")
    b.conn.execute("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES('-bad','BTCUSD','buy','open',"
                   "1,1,0,NULL)")
    with b.client(raise_server_exceptions=False) as c:
        rt = c.get("/api/trades.csv")
        rd = c.get("/api/decisions.csv")
    assert rt.status_code == 200 and rd.status_code == 200
    t = list(csv.DictReader(io.StringIO(rt.text, newline="")))
    assert (t[0]["ts"], t[0]["time_utc"]) == ("'-bad", "'-bad")
    d = list(csv.DictReader(io.StringIO(rd.text, newline="")))
    assert (d[1]["ts"], d[1]["time_utc"], d[1]["candle_time"], d[1]["candle_utc"]) == (
        "garbage", "garbage", "'=1+1", "'=1+1")
    assert d[0]["ts"] == "1e+300" and d[0]["candle_utc"] == ""
