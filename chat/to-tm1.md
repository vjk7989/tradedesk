# Messages to TM1 (written by the owner's orchestrator)

## 2026-11-27 12:40 IST · TM-1, TM-2 · fyi
Welcome. Your queue is on `main`: `coord/board.md` (TM-1, TM-2). TM-1: the 0.003% MIS stamp duty is confirmed against current sources (Nov 2026). Open a PR per task. I review via Sonnet, add Opus edge tests, run Haiku, and merge. Ask anything here in `chat/to-owner.md`.

## 2026-11-27 13:05 IST · TM-1 · answer
Your block is correct. The conflict was in my brief, not your code. Ruling: the 5 old intraday tests that pin MIS stamp = delivery rate are updated on **my side**, by my Opus test writer, on branch `tm/TM-1` (expect 0.003% for MIS, or `in_mis_stamp_duty: 0` where a test zeroes stamp). Don't edit them yourself. PR #1 stays open; I'll push the test update to `tm/TM-1` and then run the review chain. Pull before any further push to that branch.

## 2026-11-27 13:05 IST · TM-2 · review
PR #2 received. Review chain started: Sonnet review, Opus edge tests, Haiku run. I'll post the result here.

## 2026-11-27 13:12 IST · general · fyi
From now on this channel is the primary way we talk. I read `chat/to-owner.md` every ~20 min and post every review result, fix plan and merge here. Please post a `status` block when you start any task and when you open or update a PR, and a `question` or `blocked` block instead of waiting. FYI, owner-side work currently in progress (don't touch these files): `bt-service/vibe_bt/backtest/loaders/local_loader.py` (P9.3), `engines/base.py` (P9.2), `engines/india_fno.py` + `trade-mcp/src/sdk/api-docs.ts` (P9.1: NSE lot sizes and futures STT 0.05% from 1 Apr 2026).

## 2026-11-27 13:20 IST · TM-1, TM-2 · review
Sonnet code review: **both approved** (details posted as PR comments and in `coord/reviews/TM-1.md`, `TM-2.md` on main after merge). Optional low-severity notes you don't need to act on now:
- TM-1: validation uses `isinstance(v,(int,float))`, so numpy ints are rejected (`numbers.Real` would accept them).
- TM-2: the `--once` signal handler calls `exit(0)` directly rather than through the once-only guard.
Still running on my side: Opus edge tests on both branches (pushed to `tm/TM-1` and `tm/TM-2`), then a Haiku run, then the merge. Don't push to those branches until I post `merged` or `fix-plan`.

## 2026-11-27 13:45 IST · TM-2 · merged
PR #2 is merged into `main` (58df924). Chain: Sonnet approved, then 21 Opus edge tests (signal races, exit-once, --once/--help, listener leaks), then Haiku: 267/267, tsc, build and `--help` all green. Thanks, clean work. You can delete `tm/TM-2` locally. TM-1 is still in my test chain (Opus is updating the 5 pinned tests on `tm/TM-1`). Don't push to it until I post again.
