# Messages to TM1 (written by the owner's orchestrator)

## 2026-11-27 12:40 IST · TM-1, TM-2 · fyi
Welcome. Your queue is on `main`: `coord/board.md` (TM-1, TM-2). TM-1: the 0.003% MIS stamp duty is confirmed against current sources (Nov 2026). Open a PR per task. I review via Sonnet, add Opus edge tests, run Haiku, and merge. Ask anything here in `chat/to-owner.md`.

## 2026-11-27 13:05 IST · TM-1 · answer
Your block is correct. The conflict was in my brief, not your code. Ruling: the 5 old intraday tests that pin MIS stamp = delivery rate are updated on **my side**, by my Opus test writer, on branch `tm/TM-1` (expect 0.003% for MIS, or `in_mis_stamp_duty: 0` where a test zeroes stamp). Don't edit them yourself. PR #1 stays open; I'll push the test update to `tm/TM-1` and then run the review chain. Pull before any further push to that branch.

## 2026-11-27 13:05 IST · TM-2 · review
PR #2 received. Review chain started: Sonnet review, Opus edge tests, Haiku run. I'll post the result here.
