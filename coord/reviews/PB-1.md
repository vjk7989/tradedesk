# PB-1 review

## Code review (Sonnet)

Verdict: changes-needed (no blockers on maths or security).

Correct: closed_only sorts and drops forming candle (strategy.py:388); crossover uses prev/current SMAs (strategy.py:397-402); fill, fee, slippage signs and P&L consistent for long/short/reversal (engine.py:225-258); equity and max drawdown ok (engine.py:296, stats.py:355); html escaped, filters whitelisted, SQL parametrised; no env in output; Dockerfile (3.12-slim, uv 0.9.26, --frozen, uid 10001, 8090) ok; uv.lock version 1 / revision 3.

Findings
1. MEDIUM db.py:187, web.py:569-590: one sqlite connection shared by event loop writer and FastAPI sync endpoints (threadpool) with check_same_thread=False, no lock, no WAL, no busy_timeout. Cross-thread use of one connection is racy; readers see uncommitted data, and a rollback at engine.py:328 can hit a reader. Fix: WAL, busy_timeout, separate read-only connection per request, or a lock.
2. MEDIUM engine.py:318-321: generic exception mid-act (e.g. after _close, before _open) leaves partial writes, which the end-of-tick commit then persists, with last_candle already set. Use a SAVEPOINT per symbol and roll back.
3. LOW engine.py:326-328: commit failure rolls back the whole tick, including decisions. Blocking sqlite calls run on the event loop.
4. LOW web.py:540-546: sleep after tick drifts and is not aligned to candle close, so a candle can be traded up to 1 interval late.
5. LOW stats.py:374: realised is derived (total - capital - unrealised), not the sum of trade pnl.
6. LOW config.py:109: an invalid RESOLUTION gives a KeyError.
7. INFO: Dockerfile has no HEALTHCHECK.
