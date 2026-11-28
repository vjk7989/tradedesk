import asyncio
import logging
import math
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
        self.ox, self._sent = None, set()
        if cfg.execution == "openalgo":  # TM2-77; sim mode never imports the module
            from .openalgo_exec import OpenAlgoExec
            self.ox = OpenAlgoExec(cfg)
            self._check_positions_fit_sizes()  # sim->openalgo on a used DB: refuse (use a fresh DATA_DIR)
            self.ox.require_analyzer_on()  # fail closed: refuse to start unless analyzer is ON
            for sym in cfg.symbols:
                if self._halted(sym):
                    log.warning("openalgo: %s is HALTED (unreconciled in-flight/unknown order); see %s", sym,
                                self._halt_key(sym))
        if D.get_state(conn, "cash") is None:
            D.set_state(conn, "cash", cfg.capital)
            conn.commit()

    # --- trading primitives -------------------------------------------------
    def _open(self, sym, side, price, ts, qty=None):
        buy = side == "long"
        fp = fill_price(price, "buy" if buy else "sell", self.cfg.slippage)
        qty = self.cfg.notional / fp if qty is None else qty
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
        self._sent.discard(sym)
        pos = self.db.execute("SELECT side FROM positions WHERE symbol=?", (sym,)).fetchone()
        cur = pos["side"] if pos else None
        want = {"up": "long", "down": "short" if cfg.allow_short else "flat"}.get(sig)
        if want is None:
            self._decision(now, sym, ct, close, f, s, "hold", "hold", f"{why} → hold")
        elif want == cur or (want == "flat" and cur is None):
            self._decision(now, sym, ct, close, f, s, want, "hold",
                           f"{why} → already {cur or 'flat'}, hold")
        elif self.ox is not None:
            self._act_ox(sym, want, cur, close, now, (ct, f, s, why))
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

    # --- OpenAlgo analyzer execution (TM2-77) -------------------------------
    def _halt_key(self, sym):
        return f"openalgo_unknown:{sym}"

    def _inflight_key(self, sym):
        return f"openalgo_inflight:{sym}"

    def _halted(self, sym):
        return (D.get_state(self.db, self._halt_key(sym)) is not None
                or D.get_state(self.db, self._inflight_key(sym)) is not None)

    def _howto(self, sym):
        return (f"no orders for {sym} until reconciled: check the OpenAlgo orderbook/positions, then run: "
                f"DELETE FROM state WHERE key IN ('{self._halt_key(sym)}','{self._inflight_key(sym)}')")

    def _check_positions_fit_sizes(self):
        sizes = dict(self.cfg.contract_sizes)
        for p in D.rows(self.db, "SELECT symbol, qty FROM positions"):
            size = sizes.get(p["symbol"])
            if not size or abs(p["qty"] / size - round(p["qty"] / size)) > 1e-9 or round(p["qty"] / size) < 1:
                raise RuntimeError(f"EXECUTION=openalgo refused to start: open position {p['symbol']} qty "
                                   f"{p['qty']:g} is not a whole number of contracts (opened under sim?); "
                                   "use a fresh DATA_DIR when switching to openalgo")

    def _abort_halt(self, sym, why):
        """After a BaseException past the send: drop the uncommitted txn, commit a halt, never raise."""
        try:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            self.db.execute("BEGIN IMMEDIATE")
            D.set_state(self.db, self._halt_key(sym), why)
            self.db.execute("COMMIT")
        except Exception:
            log.exception("could not record halt %s", sym)

    def _ox_order(self, sym, side, contracts, ct):
        """Send one order (never retried). Order of events (crash analysis in coord/reports/TM2-77.md):
        COMMIT work so far, COMMIT an in-flight marker, POST, then the caller writes the result rows and clears
        the marker in the txn that the outer _txn commits."""
        if self._halted(sym):
            return self.ox.refused(self._howto(sym))
        self._sent.add(sym)
        if self.db.in_transaction:  # production always runs inside _txn; guard direct calls
            self.db.execute("COMMIT")
        self.db.execute("BEGIN IMMEDIATE")
        D.set_state(self.db, self._inflight_key(sym), f"candle {ct} {side} {contracts}")
        self.db.execute("COMMIT")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            r = self.ox.place(sym, side, contracts)
        except BaseException:
            self._abort_halt(sym, "interrupted during send")
            raise
        if r.status == "ok":
            D.set_state(self.db, f"openalgo_order:{r.orderid}", f"{sym} {side} {contracts}")
        else:
            if r.status == "unknown":
                D.set_state(self.db, self._halt_key(sym), r.reason)
            self._clear_inflight(sym)  # refused/rejected/unknown: result recorded in this txn
        return r

    def _clear_inflight(self, sym):
        self.db.execute("DELETE FROM state WHERE key=?", (self._inflight_key(sym),))

    def _act_ox(self, sym, want, cur, close, now, info):
        try:
            self._act_ox_inner(sym, want, cur, close, now, info)
        except BaseException as e:
            if sym in self._sent and not isinstance(e, Exception):
                self._abort_halt(sym, f"{type(e).__name__} after send")
            raise

    def _act_ox_inner(self, sym, want, cur, close, now, info):
        """Open/close/reverse via the analyzer. One decision row. Fills are MODELLED from the closed candle
        (as sim does, incl. slippage and fee): the analyzer reply carries only an order id, no fill price."""
        from .openalgo_exec import contracts_for
        ct, f, s, why = info
        size = self.ox.contract_size(sym)

        def decide(sig, act, reason):
            self._decision(now, sym, ct, close, f, s, sig, act, self.ox.redact(reason))
        if self._halted(sym):
            decide(want, "skip", f"{why} → openalgo order outcome unknown/in flight earlier; {self._howto(sym)}")
            return
        note = "fill modelled from candle close"
        closed = None
        if cur:
            p = self.db.execute("SELECT qty FROM positions WHERE symbol=?", (sym,)).fetchone()
            n = contracts_for(p["qty"], size)
            r = self._ox_order(sym, "SELL" if cur == "long" else "BUY", n, ct)
            if r.status != "ok":
                decide(want, "skip", f"{why} → close {cur} not executed: {r.reason}")
                return
            self._close(sym, close, now)
            self._clear_inflight(sym)
            closed = r.orderid
            if want == "flat":
                decide("flat", "close", f"{why} → close {cur} [openalgo order {closed}; {note}]")
                return
        fp = fill_price(close, "buy" if want == "long" else "sell", self.cfg.slippage)
        n = contracts_for(self.cfg.notional / fp, size)
        pre = f"close {cur} [order {closed}], " if closed else ""
        if n < 1:
            decide(want, "close" if closed else "skip", f"{why} → {pre}open {want} not executed: notional "
                   f"{self.cfg.notional:g} is below one contract (size {size:g}); order refused")
            return
        r = self._ox_order(sym, "BUY" if want == "long" else "SELL", n, ct)
        if r.status != "ok":
            decide(want, "close" if closed else "skip", f"{why} → {pre}open {want} not executed: {r.reason}")
            return
        self._open(sym, want, close, now, n * size)
        self._clear_inflight(sym)
        tag = f"[openalgo order {r.orderid}; {note}]"
        if closed:
            decide(want, "reverse", f"{why} → close {cur} [order {closed}], open {want} {tag}")
        else:
            decide(want, "open", f"{why} → open {want} {n} contracts {tag}")

    def snapshot(self, now):
        cash = D.get_cash(self.db, self.cfg.capital)
        unreal = 0.0
        for p in D.rows(self.db, "SELECT * FROM positions"):
            unreal += (p["mark"] - p["entry"]) * p["qty"] * (1 if p["side"] == "long" else -1)
        self.db.execute("INSERT INTO equity(ts,cash,unrealised,total) VALUES(?,?,?,?)",
                        (now, cash, unreal, cash + unreal))

    # --- one tick -----------------------------------------------------------
    def _txn(self, fn):
        """Run fn in its own transaction; rollback (incl. last_candle) on any error, then re-raise."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            fn()
            self.db.execute("COMMIT")
        except BaseException:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise

    def _write(self, sym, result, now):
        """result: closed candles (oldest first) or a DataError. One transaction per symbol."""
        try:
            if isinstance(result, DataError):
                self._txn(lambda: self._decision(now, sym, None, None, None, None, "hold", "skip",
                                                 f"data error: {result}"))
            else:
                self._txn(lambda: self.act(sym, result, now))
        except Exception as e:  # partial writes already rolled back; record skip so the candle retries
            log.exception("tick error %s", sym)
            try:
                def skip():
                    self._decision(now, sym, None, None, None, None, "hold", "skip",
                                   f"internal error: {type(e).__name__}")
                    if self.ox is not None and sym in self._sent:  # an order may exist but its rows rolled back
                        D.set_state(self.db, self._halt_key(sym), "internal error after order sent")
                self._txn(skip)
            except Exception:
                log.exception("could not record skip %s", sym)

    def _finish(self, now):
        def f():
            self.snapshot(now)
            D.set_state(self.db, "last_tick", now)
        try:
            self._txn(f)
        except Exception:
            log.exception("snapshot error")

    async def tick(self, now=None):
        now = now or time.time()
        cfg = self.cfg
        results = {}
        for sym in cfg.symbols:  # network I/O stays on the event loop
            try:
                raw = await fetch_candles(self.client, cfg.base_url, sym, cfg.resolution, cfg.period,
                                          cfg.slow + 5, now)
                candles = closed_only(raw, now, cfg.period)
                if len(candles) < cfg.slow + 1:
                    raise DataError(f"only {len(candles)} closed candles")
                if not all(math.isfinite(c[k]) and c[k] > 0 for c in candles[-(cfg.slow + 1):]
                           for k in ("open", "high", "low", "close")):
                    raise DataError("non-finite price")
                results[sym] = candles
            except DataError as e:
                results[sym] = e
            except Exception as e:
                results[sym] = DataError(f"{type(e).__name__} {e}"[:120])

        def work():
            for sym, r in results.items():
                self._write(sym, r, now)
            self._finish(now)
        await asyncio.to_thread(work)  # all sqlite writes off the event loop
