import logging
import time

from . import db as D
from .data import DataError, fetch_candles
from .strategy import closed_only, evaluate

log = logging.getLogger("paper_bot")


def fill_price(price, side, slippage):
    """side = buy/sell; slippage always worsens the fill."""
    return price * (1 + slippage) if side == "buy" else price * (1 - slippage)


class Engine:
    def __init__(self, cfg, conn, client):
        self.cfg, self.db, self.client = cfg, conn, client
        if D.get_state(conn, "cash") is None:
            D.set_state(conn, "cash", cfg.capital)
            conn.commit()

    # --- trading primitives -------------------------------------------------
    def _open(self, sym, side, price, ts):
        buy = side == "long"
        fp = fill_price(price, "buy" if buy else "sell", self.cfg.slippage)
        qty = self.cfg.notional / fp
        fee = qty * fp * self.cfg.fee
        self.db.execute("INSERT INTO positions VALUES(?,?,?,?,?,?)", (sym, side, qty, fp, fee, price))
        self.db.execute("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,?,?,?,NULL)",
                        (ts, sym, "buy" if buy else "sell", "open", qty, fp, fee))
        D.set_state(self.db, "cash", D.get_cash(self.db, self.cfg.capital) - fee)

    def _close(self, sym, price, ts):
        p = self.db.execute("SELECT * FROM positions WHERE symbol=?", (sym,)).fetchone()
        long = p["side"] == "long"
        fp = fill_price(price, "sell" if long else "buy", self.cfg.slippage)
        fee = p["qty"] * fp * self.cfg.fee
        gross = (fp - p["entry"]) * p["qty"] * (1 if long else -1)
        net = gross - fee - p["entry_fee"]  # realised = full round trip, net of both fees
        self.db.execute("DELETE FROM positions WHERE symbol=?", (sym,))
        self.db.execute("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,?,?,?,?)",
                        (ts, sym, "sell" if long else "buy", "close", p["qty"], fp, fee, net))
        D.set_state(self.db, "cash", D.get_cash(self.db, self.cfg.capital) + gross - fee)

    def _decision(self, ts, sym, ct, close, f, s, signal, action, reason):
        self.db.execute("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                        " VALUES(?,?,?,?,?,?,?,?,?)", (ts, sym, ct, close, f, s, signal, action, reason))

    # --- one symbol ---------------------------------------------------------
    def act(self, sym, candles, now):
        """candles: closed, oldest first. Writes exactly one decision row."""
        cfg = self.cfg
        last = candles[-1]
        ct, close = last["time"], last["close"]
        self.db.execute("UPDATE positions SET mark=? WHERE symbol=?", (close, sym))
        sig, f, s, why = evaluate([c["close"] for c in candles], cfg.fast, cfg.slow)
        key = f"last_candle:{sym}"
        if D.get_state(self.db, key) == str(ct):
            self._decision(now, sym, ct, close, f, s, "hold", "hold", f"candle {ct} already processed → hold")
            return
        D.set_state(self.db, key, ct)
        pos = self.db.execute("SELECT side FROM positions WHERE symbol=?", (sym,)).fetchone()
        cur = pos["side"] if pos else None
        want = {"up": "long", "down": "short" if cfg.allow_short else "flat"}.get(sig)
        if want is None:
            self._decision(now, sym, ct, close, f, s, "hold", "hold", f"{why} → hold")
        elif want == cur or (want == "flat" and cur is None):
            self._decision(now, sym, ct, close, f, s, want, "hold",
                           f"{why} → already {cur or 'flat'}, hold")
        elif want == "flat":
            self._close(sym, close, now)
            self._decision(now, sym, ct, close, f, s, "flat", "close", f"{why} → close {cur}")
        elif cur:
            self._close(sym, close, now)
            self._open(sym, want, close, now)
            self._decision(now, sym, ct, close, f, s, want, "reverse", f"{why} → close {cur}, open {want}")
        else:
            self._open(sym, want, close, now)
            self._decision(now, sym, ct, close, f, s, want, "open", f"{why} → open {want}")

    def snapshot(self, now):
        cash = D.get_cash(self.db, self.cfg.capital)
        unreal = 0.0
        for p in D.rows(self.db, "SELECT * FROM positions"):
            unreal += (p["mark"] - p["entry"]) * p["qty"] * (1 if p["side"] == "long" else -1)
        self.db.execute("INSERT INTO equity(ts,cash,unrealised,total) VALUES(?,?,?,?)",
                        (now, cash, unreal, cash + unreal))

    # --- one tick -----------------------------------------------------------
    async def tick(self, now=None):
        now = now or time.time()
        cfg = self.cfg
        for sym in cfg.symbols:
            try:
                raw = await fetch_candles(self.client, cfg.base_url, sym, cfg.resolution, cfg.period,
                                          cfg.slow + 5, now)
                candles = closed_only(raw, now, cfg.period)
                if len(candles) < cfg.slow + 1:
                    raise DataError(f"only {len(candles)} closed candles")
                self.act(sym, candles, now)
            except DataError as e:
                self._decision(now, sym, None, None, None, None, "hold", "skip", f"data error: {e}")
            except Exception as e:  # never crash the loop
                log.exception("tick error %s", sym)
                self._decision(now, sym, None, None, None, None, "hold", "skip",
                               f"data error: {type(e).__name__} {e}"[:120])
        try:
            self.snapshot(now)
            D.set_state(self.db, "last_tick", now)
            self.db.commit()
        except Exception:
            log.exception("commit error")
            self.db.rollback()
