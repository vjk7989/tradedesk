import os
import sqlite3
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


def connect(path: str) -> sqlite3.Connection:
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    # Writer connection: autocommit (engine manages BEGIN/COMMIT itself); used by one thread at a time.
    db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.executescript(SCHEMA)
    return db


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
