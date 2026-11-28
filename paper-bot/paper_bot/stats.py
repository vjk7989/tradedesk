from . import db as D


def max_drawdown(totals):
    peak, mdd = None, 0.0
    for t in totals:
        peak = t if peak is None else max(peak, t)
        if peak > 0:
            mdd = max(mdd, (peak - t) / peak)
    return mdd


def summary(conn, cfg):
    # only the totals are scanned (not every column of every row) and the last row is fetched on its own:
    # same numbers as before, but cheap on a year of 5 m snapshots.
    totals = [r[0] for r in conn.execute("SELECT total FROM equity ORDER BY id")]
    cash = D.get_cash(conn, cfg.capital)
    last = D.rows(conn, "SELECT * FROM equity ORDER BY id DESC LIMIT 1")
    last = last[0] if last else {"cash": cash, "unrealised": 0.0, "total": cash}
    total = last["total"]
    closes = [r[0] for r in conn.execute("SELECT pnl FROM trades WHERE kind='close'")]
    wins = sum(1 for c in closes if c > 0)
    ntr = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    return {"mode": "PAPER", "equity": total, "start_capital": cfg.capital, "pnl": total - cfg.capital,
            "pnl_pct": (total - cfg.capital) / cfg.capital * 100, "unrealised": last["unrealised"],
            "realised": total - cfg.capital - last["unrealised"], "trades": ntr, "closed_trades": len(closes),
            "win_rate": wins / len(closes) * 100 if closes else None,
            "max_drawdown_pct": max_drawdown([cfg.capital] + totals) * 100,
            "last_tick": float(D.get_state(conn, "last_tick", 0)) or None}


def per_symbol(conn, cfg):
    """Per-symbol breakdown built from the same tables and formulas as summary().

    realised   = sum(close pnl) - entry fee of the still-open position. Global realised is cash - capital, and cash
                 pays every open fee when it is charged, so this is what makes the symbols sum to summary()["realised"].
    unrealised = (mark - entry) * qty * side, the formula the engine uses for the equity snapshot.
    win_rate   = closed trades with pnl > 0 / closed trades (None if none), as in summary().
    """
    pos = {p["symbol"]: p for p in D.rows(conn, "SELECT * FROM positions")}
    trades = [{"symbol": a, "kind": b, "pnl": c} for a, b, c in conn.execute("SELECT symbol, kind, pnl FROM trades")]
    last = {d["symbol"]: d for d in D.rows(
        conn, "SELECT * FROM decisions WHERE id IN (SELECT MAX(id) FROM decisions GROUP BY symbol)")}
    syms = list(cfg.symbols) + sorted({r["symbol"] for r in trades} | set(pos) | set(last) - set(cfg.symbols))
    by_sym_closes, by_sym_n = {}, {}
    for t in trades:  # one pass instead of one scan of all trades per symbol (ids order, so sums are unchanged)
        by_sym_n[t["symbol"]] = by_sym_n.get(t["symbol"], 0) + 1
        if t["kind"] == "close":
            by_sym_closes.setdefault(t["symbol"], []).append(t["pnl"])
    out = []
    for sym in dict.fromkeys(syms):
        closes = by_sym_closes.get(sym, [])
        p = pos.get(sym)
        unreal = (p["mark"] - p["entry"]) * p["qty"] * (1 if p["side"] == "long" else -1) if p else 0.0
        out.append({"symbol": sym, "realised": sum(closes) - (p["entry_fee"] if p else 0.0), "unrealised": unreal,
                    "trades": by_sym_n.get(sym, 0), "closed_trades": len(closes),
                    "win_rate": sum(1 for c in closes if c > 0) / len(closes) * 100 if closes else None,
                    "side": p["side"] if p else "flat", "last_decision": last.get(sym)})
    return out
