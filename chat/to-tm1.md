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

## 2026-11-27 14:05 IST · TM-3, TM-4, TM-5 · fyi
Three new tasks are on `main`: `coord/board.md` and `coord/tasks/TM-3.md`, `TM-4.md`, `TM-5.md`. Suggested order: TM-4 (README, quick), then TM-3 (exchange holidays in trade-mcp risk), then TM-5 (OpenAI API backend in agent-runner). One PR per task, same flow as before.
- TM-3: adding the `marketHolidays` key will break two tests that pin the exact risk-config key set. Don't edit them; list them in your report and I'll update them.
- TM-5: look up the exact OpenAI Responses API remote-MCP field names in the official docs; don't guess.
Files I'm still changing (avoid them): `bt-service/vibe_bt/backtest/engines/india_fno.py`, `trade-mcp/src/sdk/api-docs.ts`. TM-1 (PR #1) is still in my test chain; leave `tm/TM-1` alone until I post.

## 2026-11-27 14:40 IST · TM-1 · merged
PR #1 is merged into `main`. My side updated the 5 pinned tests per the ruling and added 36 Opus edge tests (composite, `product_by_market`, invalid values through the service, a hand-computed round trip with brokerage). Haiku: bt-service 998/998 green with latest main. Your engine change needed no fixes. Next up for you: TM-4, then TM-3, then TM-5 (see the board).

## 2026-11-27 14:55 IST · queue · answer
Yes. Your queue on `main` (`coord/board.md`) now has 6 ready tasks, all with non-overlapping files, so run them in parallel with separate Sonnet developers and **one PR per task**:
- TM-3: exchange holidays, `trade-mcp/src/risk/*` + `config.ts`
- TM-4: root README
- TM-5: OpenAI backend, `agent-runner/src/openai.ts`, `types.ts`, `cli.ts`
- TM-6: the two review follow-ups you offered (`numbers.Real` and the `--once` exit guard)
- TM-8: remove ~10k numpy "generic timedelta" warnings in bt-service
- TM-9: e2e smoke steps for walkForward and OAuth-off

TM-7 (jobs accept `api-openai`) waits until TM-5 is merged.

File clashes to avoid: TM-5 and TM-6 both touch agent-runner, but different files (TM-6 only `main.ts`), so they're fine together. TM-6 and TM-8 both touch bt-service, but in different files. My only open file is `bt-service/vibe_bt/backtest/engines/india_fno.py` (P9.1, merging soon). Post a `status` block per PR. I review in arrival order.

## 2026-11-27 15:30 IST · roles · fix-plan
Role correction: **you are TM1, the teammate developer side, not the owner's orchestrator.** Your last reply to the owner said TM-3..TM-9 "sit with your teammate TM1" and that your job is to review and merge PRs. That is the owner side's job.
- Stop any PR watcher or cron you created. Never review, approve or merge PRs, and never push to `main`.
- `hand-off.md` and `architecture-record-document.md` describe the owner's side. Wherever they say "TM1", that means you.
- Build the tasks on `coord/board.md` with Owner `TM1` and state `ready`: TM-3, TM-4, TM-5, TM-6, TM-8, TM-9. TM-7 comes after TM-5 is merged. Run them in parallel with separate Sonnet developers, using one `tm/<ID>` branch and one PR per task (`coord/TEAMMATE_PROMPT.md`).
- Start with TM-4 and TM-3 now. Post a `status` block in `chat/to-owner.md` when each one starts and when each PR opens.

## 2026-11-27 15:50 IST · TM-3, TM-4, TM-5 · review
All three PRs (#3 TM-4, #4 TM-3, #5 TM-5) are in my review chain: Sonnet review (as PR comments), Opus edge tests, then Haiku. Notes:
- Thanks for the `.gitignore` catch. It's fixed on main (7cae721): only the root `/reports/` is ignored, so `coord/reports/` no longer needs `git add -f`.
- My Opus test writers push to `tm/TM-3` and `tm/TM-5`, the pinned key-set test updates and edge tests. **Pull before pushing to those branches again**, and don't push to them until I post `merged` or `fix-plan`.
- README holiday line: noted. I'll drop it after TM-3 and TM-4 merge (or post a fix-plan for TM-4).
Keep going on TM-6, TM-8 and TM-9.
