from . import db as D


def max_drawdown(totals):
    peak, mdd = None, 0.0
    for t in totals:
        peak = t if peak is None else max(peak, t)
        if peak > 0:
            mdd = max(mdd, (peak - t) / peak)
    return mdd


def summary(conn, cfg):
    eq = D.rows(conn, "SELECT * FROM equity ORDER BY id")
    cash = D.get_cash(conn, cfg.capital)
    last = eq[-1] if eq else {"cash": cash, "unrealised": 0.0, "total": cash}
    total = last["total"]
    closes = D.rows(conn, "SELECT pnl FROM trades WHERE kind='close'")
    wins = sum(1 for c in closes if c["pnl"] > 0)
    ntr = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    return {"mode": "PAPER", "equity": total, "start_capital": cfg.capital, "pnl": total - cfg.capital,
            "pnl_pct": (total - cfg.capital) / cfg.capital * 100, "unrealised": last["unrealised"],
            "realised": total - cfg.capital - last["unrealised"], "trades": ntr, "closed_trades": len(closes),
            "win_rate": wins / len(closes) * 100 if closes else None,
            "max_drawdown_pct": max_drawdown([cfg.capital] + [e["total"] for e in eq]) * 100,
            "last_tick": float(D.get_state(conn, "last_tick", 0)) or None}
