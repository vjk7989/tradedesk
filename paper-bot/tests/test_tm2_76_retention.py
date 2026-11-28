"""TM2-76: bounded storage for the long-running paper-bot.

Guards the two things the live VM must never lose:
  * the audit trail: decisions (and trades) are never deleted or changed by maintenance;
  * exact numbers: after equity snapshots older than EQUITY_DETAIL_DAYS are thinned, the dashboard's max drawdown
    (stats.max_drawdown with the start capital prepended), final equity, min and max equity are bit-identical (==).

Also covers the daily maintenance gate, migration of a DB written by the pre-TM2-76 schema, index use (EXPLAIN
QUERY PLAN), keyset pagination of /api/decisions and the dashboard, EQUITY_DETAIL_DAYS validation, byte-for-byte
API output pinned against origin/main, and a performance guard on one year of 5 m data.

Only attribute access on the paper_bot modules (D.downsample_equity, W.page_params, ...) so this file imports
against the pre-TM2-76 sources too (used for the pre-fix proof in coord/reports/TM2-76.md).
"""
import asyncio
import hashlib
import random
import re
import sqlite3
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_bot import db as D
from paper_bot import stats as S
from paper_bot import web as W
from paper_bot.config import Config

HOUR = 3600
H0 = 1_700_000_000 // HOUR * HOUR  # an hour boundary (UTC)
KEEP = 6  # max rows per thinned hour
DAY = 86400


# ------------------------------------------------------------------ helpers
def mem():
    return D.connect(":memory:")


def bulk(db, sql, rows):
    """executemany in one transaction (the writer connection is autocommit: one fsync per row otherwise)."""
    db.execute("BEGIN")
    db.executemany(sql, rows)
    db.execute("COMMIT")


def add_equity(db, pts):
    """pts: [(ts, total)]; cash/unrealised vary so we can see that kept rows keep every column."""
    bulk(db, "INSERT INTO equity(ts,cash,unrealised,total) VALUES(?,?,?,?)",
         [(t, v - (i % 5) * 0.25, (i % 5) * 0.25, v) for i, (t, v) in enumerate(pts)])


def hour_pts(h, values, offsets=None):
    """Points of hour index h (relative to H0), evenly spread inside the hour unless offsets are given."""
    n = len(values)
    offs = offsets or [k * (HOUR // max(n, 1)) for k in range(n)]
    return [(float(H0 + h * HOUR + o), v) for o, v in zip(offs, values)]


def equity_rows(db):
    return [tuple(r) for r in db.execute("SELECT id, ts, cash, unrealised, total FROM equity ORDER BY id")]


def facts(db, capital):
    """Everything the dashboard derives from the equity table, exactly as it computes it."""
    totals = [r[0] for r in db.execute("SELECT total FROM equity ORDER BY id")]
    s = S.summary(db, Config(symbols=("BTCUSD",), capital=capital))
    return {"mdd": S.max_drawdown([capital] + totals), "mdd_raw": S.max_drawdown(totals),
            "mdd_pct": s["max_drawdown_pct"], "final": totals[-1], "equity": s["equity"], "pnl": s["pnl"],
            "min": min(totals), "max": max(totals)}


def now_for_cutoff(cutoff_hour, detail_days=1):
    """A wall clock whose EQUITY_DETAIL_DAYS cutoff is exactly the start of hour index cutoff_hour."""
    return H0 + cutoff_hour * HOUR + detail_days * DAY + 1234.5


def thin_and_check(db, capital, cutoff_hour, detail_days=1):
    """Run the real maintenance and assert every exactness / safety property. Returns rows deleted."""
    before_rows = equity_rows(db)
    before = facts(db, capital)
    cutoff = H0 + cutoff_hour * HOUR
    now = now_for_cutoff(cutoff_hour, detail_days)
    n = D.maintain(db, detail_days, now=now)
    after_rows = equity_rows(db)
    after = facts(db, capital)
    assert after == before  # == on floats: bit-identical, not approx
    assert n == len(before_rows) - len(after_rows)
    # kept rows are untouched originals (all columns), nothing inserted or rewritten
    assert set(after_rows) <= set(before_rows)
    # recent rows (inside the detail window) are all still there, unchanged
    assert [r for r in before_rows if r[1] >= cutoff] == [r for r in after_rows if r[1] >= cutoff]
    # old rows: at most 6 per hour; hours that already had <= 6 rows are untouched
    per_hour_before, per_hour_after = {}, {}
    for r in before_rows:
        if r[1] < cutoff:
            per_hour_before.setdefault(int(r[1] // HOUR), []).append(r)
    for r in after_rows:
        if r[1] < cutoff:
            per_hour_after.setdefault(int(r[1] // HOUR), []).append(r)
    assert set(per_hour_after) == set(per_hour_before)  # never empties an hour
    for h, rs in per_hour_after.items():
        assert len(rs) <= KEEP
        if len(per_hour_before[h]) <= KEEP:
            assert rs == per_hour_before[h]
        # the first and last row of every hour survive
        assert rs[0] == per_hour_before[h][0] and rs[-1] == per_hour_before[h][-1]
    # idempotent: a second run deletes nothing
    assert D.downsample_equity(db, detail_days, now=now) == 0
    assert D.maintain(db, detail_days, now=now, force=True) == 0
    assert equity_rows(db) == after_rows
    return n


def four_point_oracle(totals):
    """The brief's recipe (first, last, max, min per hour) applied to one hour: the indices it would keep."""
    return sorted({0, len(totals) - 1, totals.index(max(totals)), totals.index(min(totals))})


def table_hash(db, table):
    h = hashlib.sha256()
    for r in db.execute(f"SELECT * FROM {table} ORDER BY rowid"):
        h.update(repr(tuple(r)).encode())
    return h.hexdigest()


# ------------------------------------------------------------------ 1. exact drawdown
COUNTEREXAMPLE = [100, 120, 90, 130, 95, 99, 101]


def test_counterexample_hour_is_exact_and_four_points_are_not():
    full = S.max_drawdown([100] + COUNTEREXAMPLE)
    assert full == (130 - 95) / 130
    # oracle: first/last/max/min only keeps 100, 90, 130, 101 -> the 130 -> 95 drop is lost
    four = [COUNTEREXAMPLE[i] for i in four_point_oracle(COUNTEREXAMPLE)]
    assert four == [100, 90, 130, 101]
    assert S.max_drawdown([100] + four) == (130 - 101) / 130
    assert S.max_drawdown([100] + four) != full  # the extra (peak, trough) pair is needed

    db = mem()
    add_equity(db, hour_pts(0, COUNTEREXAMPLE) + hour_pts(30, [100.0]))  # one recent point after the cutoff
    assert thin_and_check(db, capital=100.0, cutoff_hour=1) == 2
    kept = [r[0] for r in db.execute("SELECT total FROM equity WHERE ts < ? ORDER BY id", (H0 + HOUR,))]
    assert kept == [100, 90, 130, 95, 101]  # first, min, max, the drawdown trough 95, last
    assert facts(db, 100.0)["mdd"] == full


def test_peak_in_one_hour_trough_in_a_later_hour():
    a = [100, 101, 102, 103, 104, 150, 105, 106, 107, 108, 109, 110]  # peak mid-hour, not first/last
    b = [110] * 12
    c = [120, 119, 118, 117, 116, 80, 118, 119, 121, 122, 123, 124]  # trough mid-hour
    db = mem()
    add_equity(db, hour_pts(0, a) + hour_pts(1, b) + hour_pts(5, c) + hour_pts(40, [124.0, 125.0]))
    assert facts(db, 100.0)["mdd"] == (150 - 80) / 150
    thin_and_check(db, capital=100.0, cutoff_hour=6)
    totals = [r[0] for r in db.execute("SELECT total FROM equity ORDER BY id")]
    assert 150 in totals and 80 in totals


def test_ties_single_row_and_skipped_hours():
    pts = (hour_pts(0, [100.0] * 12)                                     # all equal
           + hour_pts(1, [100, 130, 90, 130, 90, 130, 90, 130, 95, 130, 90, 100])  # repeated max/min
           + hour_pts(2, [101.0])                                        # single row
           + hour_pts(6, [97, 97, 140, 140, 60, 60, 140, 60, 99, 99])  # after 3 skipped hours
           + hour_pts(7, [99, 98])                                       # 2 rows: untouched
           + hour_pts(9, [99.5] * 7)                                     # 7 ties: just above KEEP
           + hour_pts(20, [80.0 + k for k in range(12)]))                # recent, untouched
    for capital in (120.0, 50.0, 200.0):  # start capital below, between and above the series
        db = mem()
        add_equity(db, pts)
        thin_and_check(db, capital=capital, cutoff_hour=20)


@pytest.mark.parametrize("cutoff_hour", [0, 3, 4, 7, 100])
def test_cutoff_inside_before_and_after_the_data(cutoff_hour):
    r = random.Random(cutoff_hour)
    db = mem()
    v, pts = 100.0, []
    for h in range(8):
        vals = []
        for _ in range(12):
            v = max(1.0, v * (1 + r.choice([-0.12, -0.01, 0, 0.01, 0.15])))
            vals.append(v)
        pts += hour_pts(h, vals)
    add_equity(db, pts)
    n = thin_and_check(db, capital=100.0, cutoff_hour=cutoff_hour)
    assert (n == 0) == (cutoff_hour == 0)
    old = db.execute("SELECT COUNT(*) FROM equity WHERE ts >= ?", (H0 + cutoff_hour * HOUR,)).fetchone()[0]
    assert old == 12 * max(0, 8 - cutoff_hour)  # the hours from the cutoff on keep all 12 rows


def random_series(r):
    """One adversarial equity series: random walk, ties, intra-hour spikes, skipped and sparse hours."""
    mode = r.choice(["walk", "spiky", "ints", "ties"])
    v = r.uniform(50, 200)
    pts, h = [], 0
    for _ in range(r.randint(1, 24)):
        h += 1 + (r.random() < 0.15) * r.randint(1, 5)  # skipped hours
        n = r.choice([1, 2, 3, 6, 7, 8, 12, 12, 12, 13, 20])
        offs = sorted(r.sample(range(HOUR), n))
        vals = []
        for _ in range(n):
            x = r.random()
            if mode == "ties" and x < 0.4:
                pass  # repeat the previous value
            elif mode != "walk" and x < 0.35:
                v *= 1 + r.choice([-1, 1]) * r.uniform(0.02, 0.25)  # spike
            else:
                v *= 1 + r.gauss(0, 0.004)
            v = max(v, 0.01)
            if mode == "ints":
                v = float(max(1, round(v)))
            vals.append(v)
        pts += hour_pts(h, vals, offs)
    return pts, h


def test_random_adversarial_series_are_exact():
    """Seeded generator, 400 series. Also counts how often the 4-point recipe would have been wrong."""
    r = random.Random(7676)
    oracle_wrong = 0
    for _ in range(400):
        pts, last_h = random_series(r)
        cutoff_hour = r.randint(0, last_h + 1)
        capital = pts[0][1] * r.choice([0.5, 1.0, 2.0])
        # 4-point oracle on the same data (hours older than the cutoff with > KEEP rows)
        hours = {}
        for t, v in pts:
            hours.setdefault(int(t // HOUR), []).append(v)
        four = []
        for hh in sorted(hours):
            vals = hours[hh]
            if hh < H0 // HOUR + cutoff_hour and len(vals) > KEEP:
                four += [vals[i] for i in four_point_oracle(vals)]
            else:
                four += vals
        full_mdd = S.max_drawdown([capital] + [v for _, v in pts])
        oracle_wrong += S.max_drawdown([capital] + four) != full_mdd
        db = mem()
        add_equity(db, pts)
        thin_and_check(db, capital, cutoff_hour)
        db.close()
    assert oracle_wrong > 0  # the generator does hit the case first/last/max/min gets wrong


# ------------------------------------------------------------------ 2. decisions / trades never deleted
def audit_db(path):
    db = D.connect(str(path))
    r = random.Random(3)
    bulk(db, "INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
         " VALUES(?,?,?,?,?,?,?,?,?)",
         [(float(H0 + i * 300 + 5), ("BTCUSD", "ETHUSD")[i % 2], H0 + i * 300, 100.0 + i, 1.0, 2.0,
                     "long", r.choice(W.ACTIONS), f"r{i} — “q” 'x'") for i in range(3000)])
    bulk(db, "INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,?,?,?,?)",
         [(float(H0 + i * 3000 + 5), "BTCUSD", "long", ("open", "close")[i % 2], 0.01, 100.0, 0.05,
                     None if i % 2 == 0 else 1.5 - i % 3) for i in range(300)])
    add_equity(db, [(float(H0 + i * 300 + 5), 10000 + 50 * ((i * 7919) % 13) - i * 0.5) for i in range(1500)])
    return db


def test_maintenance_never_deletes_decisions_or_trades(tmp_path):
    db = audit_db(tmp_path / "paper.db")
    dec_n, dec_h, tr_h = (db.execute("SELECT COUNT(*) FROM decisions").fetchone()[0],
                          table_hash(db, "decisions"), table_hash(db, "trades"))
    stmts = []
    db.set_trace_callback(stmts.append)
    n = D.maintain(db, 1, now=H0 + 1500 * 300 + 2 * DAY)
    db.set_trace_callback(None)
    assert n > 0  # equity really was thinned
    assert db.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] == dec_n == 3000
    assert table_hash(db, "decisions") == dec_h
    assert table_hash(db, "trades") == tr_h
    writes = [s for s in stmts if re.match(r"\s*(DELETE|UPDATE|INSERT|REPLACE|DROP)", s, re.I)]
    assert writes and all(re.search(r"\b(equity|state)\b", s) for s in writes), writes


# ------------------------------------------------------------------ 3. maintenance: gate, optimize, no VACUUM, rollback
def old_hours(db, hours, per_hour=12, start=0):
    r = random.Random(hours + start)
    v, pts = 1000.0, []
    for h in range(start, start + hours):
        vals = []
        for _ in range(per_hour):
            v = max(1.0, v * (1 + r.choice([-0.08, -0.002, 0.0, 0.002, 0.09])))
            vals.append(v)
        pts += hour_pts(h, vals)
    add_equity(db, pts)


def test_daily_gate(tmp_path):
    db = D.connect(str(tmp_path / "paper.db"))
    old_hours(db, 10)
    t = now_for_cutoff(10)
    assert D.maintain(db, 1, now=t) > 0
    assert float(D.get_state(db, "last_maintenance")) == t
    old_hours(db, 5, start=10)  # more thinnable rows appear, but within 24 h nothing runs
    rows = equity_rows(db)
    assert D.maintain(db, 1, now=t + 3600) is None
    assert D.maintain(db, 1, now=t + DAY - 1) is None
    assert equity_rows(db) == rows
    assert float(D.get_state(db, "last_maintenance")) == t
    assert D.maintain(db, 1, now=t + DAY) > 0  # 24 h later it runs again
    assert float(D.get_state(db, "last_maintenance")) == t + DAY


def test_optimize_runs_and_never_vacuum(tmp_path, monkeypatch):
    seen = []
    real = sqlite3.connect

    def traced(*a, **k):
        c = real(*a, **k)
        c.set_trace_callback(seen.append)
        return c

    monkeypatch.setattr(sqlite3, "connect", traced)
    db = D.connect(str(tmp_path / "paper.db"))  # startup
    assert any(s.strip().upper() == "PRAGMA OPTIMIZE" for s in seen)
    seen.clear()
    old_hours(db, 3)
    seen.clear()
    assert D.maintain(db, 1, now=now_for_cutoff(3)) > 0  # daily step
    assert any(s.strip().upper() == "PRAGMA OPTIMIZE" for s in seen)
    assert not any("VACUUM" in s.upper() for s in seen)
    for f in Path(D.__file__).parent.glob("*.py"):
        assert "VACUUM" not in f.read_text().upper().replace("VACUUM-FREE", "").replace("NO VACUUM", ""), f


class FailInSecondBatch:
    """Proxy around the writer connection that raises on the 2nd DELETE of the 2nd batch transaction (after
    one DELETE of that batch has already executed, so the rollback has something to undo)."""

    def __init__(self, db):
        self.db, self.begins, self.dels = db, 0, 0

    def execute(self, sql, *a):
        if sql.startswith("BEGIN"):
            self.begins += 1
            self.dels = 0
        return self.db.execute(sql, *a)

    def executemany(self, sql, *a):
        if self.begins == 2:
            self.dels += 1
            if self.dels == 2:
                raise RuntimeError("injected failure")
        return self.db.executemany(sql, *a)


def test_failure_inside_a_batch_rolls_back_to_an_exact_state(tmp_path):
    hours = 400  # > 2 batches of 168 hours
    db = D.connect(str(tmp_path / "a.db"))
    old_hours(db, hours)
    add_equity(db, hour_pts(hours + 30, [990.0, 1001.0]))
    ref = D.connect(str(tmp_path / "b.db"))  # identical DB for a clean run
    old_hours(ref, hours)
    add_equity(ref, hour_pts(hours + 30, [990.0, 1001.0]))
    before = facts(db, 1000.0)
    now = now_for_cutoff(hours)

    with pytest.raises(RuntimeError, match="injected"):
        D.maintain(FailInSecondBatch(db), 1, now=now)
    assert not db.in_transaction
    assert D.get_state(db, "last_maintenance") is None  # not marked done, so the next tick retries
    assert facts(db, 1000.0) == before  # the committed state is drawdown-exact
    counts = dict(db.execute("SELECT CAST(ts/3600 AS INTEGER) - ?, COUNT(*) FROM equity GROUP BY 1",
                             (H0 // HOUR,)).fetchall())
    assert all(counts[h] <= KEEP for h in range(168))  # batch 1 committed
    assert all(counts[h] == 12 for h in range(168, hours))  # batch 2 rolled back (incl. its first DELETE)

    assert D.maintain(db, 1, now=now) > 0  # retry completes
    D.maintain(ref, 1, now=now)
    assert facts(db, 1000.0) == before
    assert equity_rows(db) == equity_rows(ref)  # same end state as a run that never failed


# ------------------------------------------------------------------ 4. migration from the pre-TM2-76 schema
OLD_SCHEMA = """
CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, candle_time INTEGER,
  close REAL, fast REAL, slow REAL, signal TEXT, action TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, side TEXT, kind TEXT,
  qty REAL, price REAL, fee REAL, pnl REAL);
CREATE TABLE IF NOT EXISTS positions(symbol TEXT PRIMARY KEY, side TEXT, qty REAL, entry REAL,
  entry_fee REAL, mark REAL);
CREATE TABLE IF NOT EXISTS equity(id INTEGER PRIMARY KEY, ts REAL, cash REAL, unrealised REAL, total REAL);
CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
"""  # verbatim from origin/main paper-bot/paper_bot/db.py (pre-TM2-76), opened the way its connect() did

NEW_INDEXES = {("decisions", ("symbol", "ts")), ("decisions", ("action", "ts")), ("decisions", ("symbol", "id")),
               ("decisions", ("action", "id")), ("trades", ("ts", "symbol")), ("equity", ("ts",))}


def indexes(db):
    out = set()
    for name, tbl in db.execute("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"):
        out.add((tbl, tuple(r[2] for r in db.execute(f"PRAGMA index_info({name})"))))
    return out


def test_startup_migrates_an_old_db(tmp_path):
    path = str(tmp_path / "paper.db")
    old = sqlite3.connect(path, isolation_level=None)
    old.execute("PRAGMA journal_mode=WAL")
    old.executescript(OLD_SCHEMA)
    old.execute("BEGIN")
    old.executemany("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                    " VALUES(?,?,?,?,?,?,?,?,?)",
                    [(float(H0 + i * 300), ("BTCUSD", "ETHUSD")[i % 2], H0 + i * 300, 1.0 * i, None, 2.0, None,
                      W.ACTIONS[i % 5], f"r{i} ✓") for i in range(500)])
    old.executemany("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,?,?,?,?)",
                    [(float(H0 + i * 300), "BTCUSD", "long", "open", 0.1, 10.0, 0.01, None) for i in range(20)])
    old.executemany("INSERT INTO equity(ts,cash,unrealised,total) VALUES(?,?,?,?)",
                    [(float(H0 + i * 300), 1.0, 0.0, 10000.0 - i) for i in range(500)])
    old.execute("INSERT INTO positions VALUES('BTCUSD','long',0.1,10.0,0.01,11.0)")
    old.execute("INSERT INTO state VALUES('cash','9999.5')")
    old.execute("COMMIT")
    assert indexes(old) == set()
    hashes = {t: table_hash(old, t) for t in ("decisions", "trades", "equity", "positions", "state")}
    old.close()

    db = D.connect(path)  # what startup does
    assert NEW_INDEXES <= indexes(db)
    assert {t: table_hash(db, t) for t in hashes} == hashes
    db.close()
    db = D.connect(path)  # second start: idempotent
    assert NEW_INDEXES <= indexes(db)
    assert {t: table_hash(db, t) for t in hashes} == hashes
    cfg = Config(symbols=("BTCUSD", "ETHUSD"), data_dir=str(tmp_path))
    with TestClient(W.create_app(cfg, db, run_loop=False)) as c:
        assert c.get("/").status_code == 200
        assert len(c.get("/api/decisions?limit=1000").json()) == 500


# ------------------------------------------------------------------ 5. EXPLAIN QUERY PLAN
def plan(db, sql):
    return [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql)]


def captured(db, fn):
    """The SQL a real code path runs (expanded, with its bound values)."""
    seen = []
    db.set_trace_callback(seen.append)
    try:
        fn()
    finally:
        db.set_trace_callback(None)
    return seen


def uses_index(lines, table):
    mine = [p for p in lines if re.match(rf"(SEARCH|SCAN) {table}\b", p)]
    return bool(mine) and all(p.startswith(f"SEARCH {table} USING ") for p in mine)


@pytest.mark.parametrize("symbol,action,before", [
    ("BTCUSD", "", ""), ("", "open", ""), ("BTCUSD", "open", ""), ("ETHUSD", "skip", "2500"), ("", "", "2500"),
    ("BTCUSD", "", "2500")])
def test_dashboard_decisions_query_uses_an_index(tmp_path, symbol, action, before):
    db = audit_db(tmp_path / "paper.db")
    cfg = Config(symbols=("BTCUSD", "ETHUSD"), data_dir=str(tmp_path))
    sqls = [s for s in captured(db, lambda: W.render(db, cfg, symbol, action, before=before))
            if s.startswith("SELECT * FROM decisions") and "LIMIT" in s]
    assert len(sqls) == 1
    assert uses_index(plan(db, sqls[0]), "decisions"), plan(db, sqls[0])


def test_unfiltered_first_page_walks_the_primary_key(tmp_path):
    """No filter, no `before`: a backwards walk of the rowid b-tree stopped by LIMIT (no sort, no index needed)."""
    db = audit_db(tmp_path / "paper.db")
    cfg = Config(symbols=("BTCUSD", "ETHUSD"), data_dir=str(tmp_path))
    sqls = [s for s in captured(db, lambda: W.render(db, cfg)) if s.startswith("SELECT * FROM decisions")
            and "LIMIT" in s]
    assert plan(db, sqls[0]) == ["SCAN decisions"]


@pytest.mark.parametrize("symbol,action", [("BTCUSD", ""), ("", "open"), ("ETHUSD", "close")])
def test_decisions_csv_uses_an_index(tmp_path, symbol, action):
    db = audit_db(tmp_path / "paper.db")
    cfg = Config(symbols=("BTCUSD", "ETHUSD"), data_dir=str(tmp_path))
    sqls = [s for s in captured(db, lambda: W.decisions_csv(db, cfg, symbol, action)) if "FROM decisions" in s]
    assert len(sqls) == 1
    assert uses_index(plan(db, sqls[0]), "decisions"), plan(db, sqls[0])


@pytest.mark.parametrize("symbol", ["", "BTCUSD"])
def test_trades_csv_action_filter_uses_indexes(tmp_path, symbol):
    """TM2-72's `(ts, symbol) IN (SELECT ts, symbol FROM decisions WHERE action=?)` filter."""
    db = audit_db(tmp_path / "paper.db")
    cfg = Config(symbols=("BTCUSD", "ETHUSD"), data_dir=str(tmp_path))
    sqls = [s for s in captured(db, lambda: W.trades_csv(db, cfg, symbol, "open")) if "FROM trades" in s]
    assert len(sqls) == 1 and "(ts, symbol) IN" in sqls[0]
    p = plan(db, sqls[0])
    assert uses_index(p, "trades") and uses_index(p, "decisions"), p


# ------------------------------------------------------------------ 6. pagination
def page_db(tmp_path, n=1000):
    db = D.connect(str(tmp_path / "paper.db"))
    bulk(db, "INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
         " VALUES(?,?,?,?,?,?,?,?,?)",
         [(float(H0 + i * 300), ("BTCUSD", "ETHUSD", "SOLUSD")[i % 3], H0 + i * 300, 1.0, 1.0, 1.0,
                     "long", W.ACTIONS[(i * 7) % 5], f"r{i + 1}") for i in range(n)])  # reason r<id>
    cfg = Config(symbols=("BTCUSD", "ETHUSD", "SOLUSD"), data_dir=str(tmp_path))
    return db, cfg


@pytest.fixture
def paged(tmp_path):
    db, cfg = page_db(tmp_path)
    with TestClient(W.create_app(cfg, db, run_loop=False), raise_server_exceptions=False) as c:
        yield db, c


def test_api_decisions_default_and_max(paged):
    _, c = paged
    r = c.get("/api/decisions")
    assert r.status_code == 200 and [d["id"] for d in r.json()] == list(range(1000, 800, -1))
    assert len(c.get("/api/decisions?limit=1000").json()) == 1000
    assert [d["id"] for d in c.get("/api/decisions?before=5").json()] == [4, 3, 2, 1]
    assert c.get("/api/decisions?before=1").json() == []
    assert [d["id"] for d in c.get("/api/decisions?before=10&limit=3").json()] == [9, 8, 7]
    r = c.get(f"/api/decisions?before={2 ** 63 - 1}")
    assert r.status_code == 200 and len(r.json()) == 200


@pytest.mark.parametrize("param,value", [(p, v) for p in ("limit", "before")
                                         for v in ("%C2%B2", "abc", "-1", "0", str(2 ** 63), "1.5", "")]
                         + [("limit", "1001")])
def test_api_decisions_rejects_bad_values(paged, param, value):
    _, c = paged
    r = c.get(f"/api/decisions?{param}={value}")
    assert r.status_code == 422, (param, value, r.status_code)


@pytest.mark.parametrize("limit", [3, 7, 200, 1000])
def test_api_walk_covers_every_row_once(paged, limit):
    db, c = paged
    seen, before = [], None
    for _ in range(1000 // limit + 2):  # bounded: a server that ignores `before` must fail, not hang
        page = c.get("/api/decisions", params={"limit": limit, **({"before": before} if before else {})}).json()
        if not page:
            break
        assert len(page) <= limit
        seen += [d["id"] for d in page]
        before = page[-1]["id"]
    else:
        pytest.fail("pagination did not reach the end")
    assert seen == [r[0] for r in db.execute("SELECT id FROM decisions ORDER BY id DESC")]


def ids_on_page(html):
    return [int(x) for x in re.findall(r'<td class="reason">r(\d+)</td>', html)]


def link(html, text):
    m = re.search(rf'<a href="(/[^"]*)">{text}</a>', html)
    return m and m.group(1)


@pytest.mark.parametrize("symbol,action,limit", [("", "", ""), ("ETHUSD", "", "7"), ("", "hold", ""),
                                                 ("SOLUSD", "open", "13"), ("BTCUSD", "close", "1000")])
def test_dashboard_walk_covers_every_row_once_and_links_keep_filters(paged, symbol, action, limit):
    db, c = paged
    conds = [c_ for c_ in (f"symbol='{symbol}'" if symbol else "", f"action='{action}'" if action else "") if c_]
    want = [r[0] for r in db.execute("SELECT id FROM decisions" + (" WHERE " + " AND ".join(conds) if conds else "")
                                     + " ORDER BY id DESC")]
    q = "&".join(f"{k}={v}" for k, v in (("symbol", symbol), ("action", action), ("limit", limit)) if v)
    url, seen, pages = "/" + ("?" + q if q else ""), [], 0
    while url:
        r = c.get(url)
        assert r.status_code == 200
        html = r.text
        seen += ids_on_page(html)
        pages += 1
        assert pages <= 200, "older-decisions links do not terminate"
        if pages > 1:
            assert link(html, "newest decisions") == "/" + ("?" + q if q else "")
        else:
            assert link(html, "newest decisions") is None
        url = link(html, "older decisions")
        if url:
            for k, v in (("symbol", symbol), ("action", action), ("limit", limit)):
                assert (f"{k}={v}" in url) == bool(v), url
            assert "before=" in url
    assert seen == want
    assert pages == max(1, -(-len(want) // int(limit or 200)))


@pytest.mark.parametrize("value", ["%C2%B2", "abc", "-1", "0", str(2 ** 63), "1.5", "%E0%A5%A8", "", "+5", "%205"])
def test_dashboard_ignores_bad_page_values(paged, value):
    _, c = paged
    default = ids_on_page(c.get("/").text)
    assert default == list(range(1000, 800, -1))
    for param in ("before", "limit"):
        r = c.get(f"/?{param}={value}")
        assert r.status_code == 200, (param, value)
        assert ids_on_page(r.text) == default
        assert "Decisions (latest 200)" in r.text
    r = c.get("/?limit=1001")
    assert r.status_code == 200 and ids_on_page(r.text) == default


def trades_db(tmp_path, n):
    db = D.connect(str(tmp_path / "paper.db"))
    bulk(db, "INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,?,?,?,?)",
         [(float(H0 + i * 60), "BTCUSD", "long", "open", 0.01, 1000.0 + i, 0.5, None) for i in range(n)])
    return db, Config(symbols=("BTCUSD",), data_dir=str(tmp_path))


def trade_rows(html):
    sec = html.split("<h2>Trades</h2>", 1)[1]
    return re.findall(r"<td class=r>([\d,]+\.\d\d)</td><td class=r>0\.5000</td>", sec)


NOTE = 'latest 500 trades shown; <a href="/api/trades.csv">trades.csv</a> has all of them'


def test_dashboard_trades_capped_at_500_with_csv_note(tmp_path):
    db, cfg = trades_db(tmp_path, 501)
    with TestClient(W.create_app(cfg, db, run_loop=False)) as c:
        html = c.get("/").text
        prices = trade_rows(html)
        assert len(prices) == 500
        assert prices[0] == "1,500.00" and prices[-1] == "1,001.00"  # newest 500 (ids 501..2)
        assert NOTE in html
        assert len(c.get("/api/trades").json()) == 501  # the API still returns every trade
        assert c.get("/api/trades.csv").text.count("\r\n") == 502


def test_dashboard_trades_at_500_has_no_note(tmp_path):
    db, cfg = trades_db(tmp_path, 500)
    with TestClient(W.create_app(cfg, db, run_loop=False)) as c:
        html = c.get("/").text
        assert len(trade_rows(html)) == 500 and NOTE not in html and "trades shown" not in html


# ------------------------------------------------------------------ 7. EQUITY_DETAIL_DAYS
@pytest.mark.parametrize("value", ["0", "36501", "abc", "-1", "1.5", ""])
def test_bad_equity_detail_days_fails_startup(tmp_path, monkeypatch, value):
    monkeypatch.setenv("EQUITY_DETAIL_DAYS", value)
    cfg = Config(data_dir=str(tmp_path))
    with pytest.raises(ValueError, match="invalid config: EQUITY_DETAIL_DAYS"):
        W.create_app(cfg, run_loop=False)


@pytest.mark.parametrize("value,want", [(None, 30), ("1", 1), ("36500", 36500), ("7", 7)])
def test_equity_detail_days_reaches_the_loop(tmp_path, monkeypatch, value, want):
    if value is None:
        monkeypatch.delenv("EQUITY_DETAIL_DAYS", raising=False)
    else:
        monkeypatch.setenv("EQUITY_DETAIL_DAYS", value)
    got = []

    async def fake_loop(engine, cfg, *a, **k):
        got.append(a[0] if a else k.get("detail_days"))
        await asyncio.sleep(0)

    monkeypatch.setattr(W, "loop", fake_loop)
    cfg = Config(data_dir=str(tmp_path))
    with TestClient(W.create_app(cfg)):
        pass
    assert got == [want]
    assert D.EQUITY_DETAIL_DAYS == 30


# ------------------------------------------------------------------ 8. API output pinned to origin/main
def pin_db(tmp_path):
    """Small fixture with unicode, quotes, backslashes, newlines, awkward floats and NULLs."""
    db = D.connect(str(tmp_path / "paper.db"))
    db.executemany("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                   " VALUES(?,?,?,?,?,?,?,?,?)", [
                       (1700000005.125, "BTCUSD", 1700000000, 37000.5, 36990.25, 36950.0, "long", "open",
                        "fast > slow → open long ✓ 日本語"),
                       (1700000305.0, "ETHUSD", None, None, None, None, None, "skip", "data error: \"timeout\" 'x'"),
                       (1700000605.5, "BTCUSD", 1700000600, 0.1 + 0.2, 1e-7, 1e22, "flat", "close",
                        "back\\slash\nnew line\ttab"),
                       (1700000905.0, "ETHUSD", 1700000900, -0.0, 2000.0, 2001.0, "short", "reverse", None),
                       (1700001205.0, "BTCUSD", 1700001200, 37100.0, 37000.0, 36999.0, "long", "hold", "=1+1 <b>"),
                   ])
    db.executemany("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,?,?,?,?)", [
        (1700000005.125, "BTCUSD", "long", "open", 0.027027, 37007.4, 0.5000999, None),
        (1700000605.5, "BTCUSD", "long", "close", 0.027027, 36992.6, 0.4999, -1.4001),
        (1700000905.0, "ETHUSD", "short", "open", 0.5, 1999.6, 0.4999, None),
        (1700001205.0, "ETHUSD", "short", "close", 0.5, 1900.0, 0.475, 48.825),
    ])
    db.executemany("INSERT INTO equity(ts,cash,unrealised,total) VALUES(?,?,?,?)", [
        (1700000005.125, 9999.4999001, 0.0, 9999.4999001),
        (1700000305.0, None, None, 10012.25),
        (1700000605.5, 9997.6, 1e-7, 9997.6000001),
        (1700001205.0, 10046.42, -0.0, 10046.42),
    ])
    db.execute("INSERT INTO positions VALUES('ETHUSD','short',0.5,1999.6,0.4999,1950.0)")
    D.set_state(db, "cash", 10046.42)
    D.set_state(db, "last_tick", 1700001205.0)
    return db, Config(symbols=("BTCUSD", "ETHUSD"), data_dir=str(tmp_path))


# Generated once from origin/main (567e6575) web.py, stats.py and db.py on pin_db(); bytes, not parsed JSON.
PINNED = {  # noqa: E501
    '/api/equity': b'[{"ts":1700000005.125,"cash":9999.4999001,"unrealised":0.0,"total":9999.4999001},{"ts":1700000305.0,"cash":null,"unrealised":null,"total":10012.25},{"ts":1700000605.5,"cash":9997.6,"unrealised":1e-07,"total":9997.6000001},{"ts":1700001205.0,"cash":10046.42,"unrealised":0.0,"total":10046.42}]',
    '/api/trades': b'[{"id":4,"ts":1700001205.0,"symbol":"ETHUSD","side":"short","kind":"close","qty":0.5,"price":1900.0,"fee":0.475,"pnl":48.825},{"id":3,"ts":1700000905.0,"symbol":"ETHUSD","side":"short","kind":"open","qty":0.5,"price":1999.6,"fee":0.4999,"pnl":null},{"id":2,"ts":1700000605.5,"symbol":"BTCUSD","side":"long","kind":"close","qty":0.027027,"price":36992.6,"fee":0.4999,"pnl":-1.4001},{"id":1,"ts":1700000005.125,"symbol":"BTCUSD","side":"long","kind":"open","qty":0.027027,"price":37007.4,"fee":0.5000999,"pnl":null}]',
    '/api/summary': b'{"mode":"PAPER","equity":10046.42,"start_capital":10000.0,"pnl":46.42000000000007,"pnl_pct":0.4642000000000007,"unrealised":0.0,"realised":46.42000000000007,"trades":4,"closed_trades":2,"win_rate":50.0,"max_drawdown_pct":0.1463207560738165,"last_tick":1700001205.0}',
    '/api/decisions': b'[{"id":5,"ts":1700001205.0,"symbol":"BTCUSD","candle_time":1700001200,"close":37100.0,"fast":37000.0,"slow":36999.0,"signal":"long","action":"hold","reason":"=1+1 <b>"},{"id":4,"ts":1700000905.0,"symbol":"ETHUSD","candle_time":1700000900,"close":0.0,"fast":2000.0,"slow":2001.0,"signal":"short","action":"reverse","reason":null},{"id":3,"ts":1700000605.5,"symbol":"BTCUSD","candle_time":1700000600,"close":0.30000000000000004,"fast":1e-07,"slow":1e+22,"signal":"flat","action":"close","reason":"back\\\\slash\\nnew line\\ttab"},{"id":2,"ts":1700000305.0,"symbol":"ETHUSD","candle_time":null,"close":null,"fast":null,"slow":null,"signal":null,"action":"skip","reason":"data error: \\"timeout\\" \'x\'"},{"id":1,"ts":1700000005.125,"symbol":"BTCUSD","candle_time":1700000000,"close":37000.5,"fast":36990.25,"slow":36950.0,"signal":"long","action":"open","reason":"fast > slow \xe2\x86\x92 open long \xe2\x9c\x93 \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e"}]',
    '/api/decisions?limit=1000': b'[{"id":5,"ts":1700001205.0,"symbol":"BTCUSD","candle_time":1700001200,"close":37100.0,"fast":37000.0,"slow":36999.0,"signal":"long","action":"hold","reason":"=1+1 <b>"},{"id":4,"ts":1700000905.0,"symbol":"ETHUSD","candle_time":1700000900,"close":0.0,"fast":2000.0,"slow":2001.0,"signal":"short","action":"reverse","reason":null},{"id":3,"ts":1700000605.5,"symbol":"BTCUSD","candle_time":1700000600,"close":0.30000000000000004,"fast":1e-07,"slow":1e+22,"signal":"flat","action":"close","reason":"back\\\\slash\\nnew line\\ttab"},{"id":2,"ts":1700000305.0,"symbol":"ETHUSD","candle_time":null,"close":null,"fast":null,"slow":null,"signal":null,"action":"skip","reason":"data error: \\"timeout\\" \'x\'"},{"id":1,"ts":1700000005.125,"symbol":"BTCUSD","candle_time":1700000000,"close":37000.5,"fast":36990.25,"slow":36950.0,"signal":"long","action":"open","reason":"fast > slow \xe2\x86\x92 open long \xe2\x9c\x93 \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e"}]',
}


@pytest.mark.parametrize("path", list(PINNED))
def test_api_output_matches_origin_main(tmp_path, path):
    db, cfg = pin_db(tmp_path)
    with TestClient(W.create_app(cfg, db, run_loop=False)) as c:
        r = c.get(path)
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/json"
        assert r.content == PINNED[path]


# ------------------------------------------------------------------ 9. performance guard (not a benchmark)
def year_db(tmp_path):
    """1 year x 2 symbols of 5 m data, bulk-inserted: 210,240 decisions, 105,120 equity rows, ~3k trades."""
    db = D.connect(str(tmp_path / "paper.db"))
    r = random.Random(76)
    ticks, syms = 365 * 288, ("BTCUSD", "ETHUSD")
    t0 = H0 - ticks * 300
    acts = ["hold"] * 130 + ["open", "close"]
    db.execute("BEGIN")
    db.executemany("INSERT INTO decisions(ts,symbol,candle_time,close,fast,slow,signal,action,reason)"
                   " VALUES(?,?,?,?,?,?,?,?,?)",
                   ((float(t0 + i * 300 + 5), s, t0 + i * 300, 100.0 + i % 97, 100.0, 99.0, "long",
                     acts[(i * 31 + j) % len(acts)], "fast > slow → hold") for i in range(ticks)
                    for j, s in enumerate(syms)))
    db.executemany("INSERT INTO trades(ts,symbol,side,kind,qty,price,fee,pnl) VALUES(?,?,?,?,?,?,?,?)",
                   ((ts, s, "long", a, 1.0, 100.0, 0.05, None if a == "open" else r.uniform(-5, 5))
                    for ts, s, a in db.execute("SELECT ts, symbol, action FROM decisions WHERE action IN "
                                               "('open','close')").fetchall()))
    v, eq = 10000.0, []
    for i in range(ticks):
        v *= 1 + r.gauss(0, 0.001)
        eq.append((float(t0 + i * 300 + 5), v, 0.0, v))
    db.executemany("INSERT INTO equity(ts,cash,unrealised,total) VALUES(?,?,?,?)", eq)
    db.execute("INSERT INTO positions VALUES('BTCUSD','long',1.0,100.0,0.05,101.0)")
    D.set_state(db, "cash", v)
    D.set_state(db, "last_tick", float(H0))
    db.execute("COMMIT")
    return db, Config(symbols=syms, data_dir=str(tmp_path)), H0 + 1


def test_perf_guard_one_year_after_maintenance(tmp_path):
    """GUARD, not a benchmark: catches an accidental full-table regression (e.g. a lost index or an unbounded
    trades table), with a CI-safe bound. The acceptance target is < 300 ms; locally (shared VM, in-process
    TestClient, best of 3) this fixture measured about: / 0.13 s, /api/summary 0.05 s, /api/equity 0.18 s."""
    db, cfg, now = year_db(tmp_path)
    before = facts(db, cfg.capital)
    dec = db.execute("SELECT COUNT(*) FROM decisions").fetchone()[0]
    assert D.maintain(db, 30, now=now) > 50_000
    assert facts(db, cfg.capital) == before
    assert db.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] == dec == 2 * 365 * 288
    with TestClient(W.create_app(cfg, db, run_loop=False)) as c:
        for path in ("/", "/api/summary", "/api/equity"):
            best = float("inf")
            for _ in range(3):
                t = time.perf_counter()
                r = c.get(path)
                best = min(best, time.perf_counter() - t)
                assert r.status_code == 200
            assert best < 1.5, (path, best)
