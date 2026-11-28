import os
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, candle_time INTEGER,
  close REAL, fast REAL, slow REAL, signal TEXT, action TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, side TEXT, kind TEXT,
  qty REAL, price REAL, fee REAL, pnl REAL);
CREATE TABLE IF NOT EXISTS positions(symbol TEXT PRIMARY KEY, side TEXT, qty REAL, entry REAL,
  entry_fee REAL, mark REAL);
CREATE TABLE IF NOT EXISTS equity(id INTEGER PRIMARY KEY, ts REAL, cash REAL, unrealised REAL, total REAL);
CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
"""

# IF NOT EXISTS, so an already-running live DB gains them on the next start (no data is rewritten).
# *_id variants serve the dashboard's `WHERE symbol=? ORDER BY id DESC LIMIT n` and keyset pagination (`id < ?`).
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_decisions_symbol_ts ON decisions(symbol, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_action_ts ON decisions(action, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_symbol_id ON decisions(symbol, id);
CREATE INDEX IF NOT EXISTS idx_decisions_action_id ON decisions(action, id);
CREATE INDEX IF NOT EXISTS idx_trades_ts_symbol ON trades(ts, symbol);
CREATE INDEX IF NOT EXISTS idx_equity_ts ON equity(ts);
"""

EQUITY_DETAIL_DAYS = 30
HOUR = 3600
KEEP_MAX = 6  # rows kept per downsampled hour: first, last, max, min, drawdown peak, drawdown trough


def connect(path: str) -> sqlite3.Connection:
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    # Writer connection: autocommit (engine manages BEGIN/COMMIT itself); used by one thread at a time.
    db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.executescript(SCHEMA + INDEXES)
    db.execute("PRAGMA optimize")  # cheap; analyses only what the planner statistics are missing
    return db


def equity_detail_days(env=os.environ) -> int:
    """EQUITY_DETAIL_DAYS, validated like the Config knobs (ValueError 'invalid config: ...')."""
    raw = env.get("EQUITY_DETAIL_DAYS", str(EQUITY_DETAIL_DAYS))
    try:
        v = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"invalid config: EQUITY_DETAIL_DAYS={raw!r} must be an integer") from None
    if not 1 <= v <= 36500:
        raise ValueError(f"invalid config: EQUITY_DETAIL_DAYS={v} must be in [1, 36500]")
    return v


def _keep_indices(totals):
    """Indices of one hour's points to keep so max drawdown (and final/min/max equity) stay EXACT.

    max_drawdown is the max over pairs i<=j of (x_i - x_j) / x_i. Across hours the best pair uses the earlier
    hour's max and the later hour's min; inside an hour it is the hour's own best (peak, trough) pair. Keeping
    first, last, max, min and that pair therefore preserves the result (proof in coord/reports/TM2-76.md).
    """
    n = len(totals)
    keep = {0, n - 1, totals.index(max(totals)), totals.index(min(totals))}
    peak_i, best, pair = 0, 0.0, None
    for j in range(n):
        if totals[j] > totals[peak_i]:
            peak_i = j
        p = totals[peak_i]
        if p > 0 and (p - totals[j]) / p > best:
            best, pair = (p - totals[j]) / p, (peak_i, j)
    if pair:
        keep.update(pair)
    return keep


def downsample_equity(db, detail_days, now=None, max_hours=168):
    """Thin equity snapshots older than detail_days to <= KEEP_MAX rows per whole hour.

    Safe and idempotent: only whole hours before the cutoff are touched; an hour with <= KEEP_MAX rows is left
    alone (so a second run finds nothing to do); an hour whose ids are not contiguous, or that holds a NULL
    total, is skipped. Each batch of up to max_hours hours is one short transaction (rolled back on error), so
    the writer lock is never held for long. Returns the number of rows deleted. Decisions are never touched.
    """
    now = time.time() if now is None else now
    cutoff = int((now - detail_days * 86400) // HOUR) * HOUR
    todo = [r[0] for r in db.execute(
        "SELECT CAST(ts/? AS INTEGER) h FROM equity WHERE ts < ? GROUP BY h HAVING COUNT(*) > ? ORDER BY h",
        (HOUR, cutoff, KEEP_MAX)).fetchall()]
    deleted = 0
    for k in range(0, len(todo), max_hours):
        db.execute("BEGIN IMMEDIATE")
        try:
            for h in todo[k:k + max_hours]:
                rs = db.execute("SELECT id, total FROM equity WHERE ts >= ? AND ts < ? ORDER BY id",
                                (h * HOUR, (h + 1) * HOUR)).fetchall()
                ids, totals = [r[0] for r in rs], [r[1] for r in rs]
                if len(rs) <= KEEP_MAX or None in totals:
                    continue
                if db.execute("SELECT COUNT(*) FROM equity WHERE id BETWEEN ? AND ?",
                              (ids[0], ids[-1])).fetchone()[0] != len(ids):
                    continue  # another hour's rows interleave (clock jump): not one contiguous run, leave it
                keep = {ids[i] for i in _keep_indices(totals)}
                drop = [(i,) for i in ids if i not in keep]
                db.executemany("DELETE FROM equity WHERE id=?", drop)
                deleted += len(drop)
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
    return deleted


def maintain(db, detail_days, now=None, force=False):
    """Daily maintenance: equity downsampling + PRAGMA optimize (no VACUUM). Returns rows deleted, or None if
    it already ran in the last 24 h."""
    now = time.time() if now is None else now
    last = float(get_state(db, "last_maintenance", 0))
    if not force and now - last < 86400:
        return None
    n = downsample_equity(db, detail_days, now)
    db.execute("PRAGMA optimize")
    set_state(db, "last_maintenance", now)
    return n


def db_file(db) -> str:
    return db.execute("PRAGMA database_list").fetchone()["file"]


def connect_ro(path: str) -> sqlite3.Connection:
    """Short-lived read-only connection for web requests (sees committed data only)."""
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=5000")
    return db


def get_state(db, key, default=None):
    r = db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def set_state(db, key, value):
    db.execute("INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               (key, str(value)))


def get_cash(db, capital: float) -> float:
    return float(get_state(db, "cash", capital))


def rows(db, sql, args=()):
    return [dict(r) for r in db.execute(sql, args).fetchall()]
