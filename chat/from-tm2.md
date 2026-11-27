# Messages from TM2 (buckleson) to the owner


## 2026-11-27 14:52 IST · TM2-1, TM2-2 · status
TM2 started TM2-1 and TM2-2 (branches tm2/TM2-1 and tm2/TM2-2 from main bab2a6c), in parallel with one Sonnet developer each. Role change acknowledged: I won't touch any TM-* task, chat/to-owner.md or chat/to-tm1.md. Env: Opus, Node v24.22.2 (not 22; will flag if it matters), uv 0.13.5, no shellcheck (TM2-1 falls back to `bash -n` per the brief), no Docker needed (fake docker in tests).

## 2026-11-27 14:57 IST · TM2-2 · status
PR opened: https://github.com/vjk7989/tradedesk/pull/11 (tm2/TM2-2). trade-mcp: new tests 25/25, full suite 887 passed + 1 skipped, tsc clean, Node v24.22.2. Report: coord/reports/TM2-2.md.

## 2026-11-27 14:57 IST · TM2-1 · status
PR opened: https://github.com/vjk7989/tradedesk/pull/12 (tm2/TM2-1). `bash -n` clean on both scripts, pytest 10/10, fake docker (no real Docker). The runbook link line is in coord/reports/TM2-1.md for you to add (docs/vps-runbook.md was off-limits).

## 2026-11-27 15:07 IST · TM2-3, TM2-4 · status
TM2 started TM2-3 (tm2/TM2-3) and TM2-4 (tm2/TM2-4) from main 8910516, in parallel with one Sonnet developer each. Fix plans for #11/#12 take priority when they arrive. Chat-only loop e0cbb77c continues, per the updated TM2_PROMPT.md.

## 2026-11-27 15:13 IST · TM2-1, TM2-2 · status
Fix plans received. Both branches are pulled (your edge tests a7b6231 and 67cd161 are in), and fix round 1 is in progress on both, with one Sonnet developer each. I'll post when pushed.

## 2026-11-27 15:13 IST · TM2-3 · status
PR opened: https://github.com/vjk7989/tradedesk/pull/13 (tm2/TM2-3). tsc and build clean; vitest 383 passed, 10 failed. All 10 failures are the pinned-text cases in agent-runner/test/tm7_jobs.edge.test.ts:37-47 (`FIVE` at :20 needs `|api-gemini`), as the brief expected; see the report. Default model gemini-4-hydrogen (recommended by the docs but not badged stable; gemini-3.8-flash is the stable alternative, your call).

## 2026-11-27 15:13 IST · TM2-4 · status
PR opened: https://github.com/vjk7989/tradedesk/pull/14 (tm2/TM2-4). pytest 25/25, standard library only. Report: coord/reports/TM2-4.md.

## 2026-11-27 15:13 IST · TM2-1, TM2-2 · status
Fix round 1 pushed to both.
- #11 TM2-2 (6386d07): retention skips dates that don't round-trip (2026-02-30), plus the single-writer and clock-skew comment. trade-mcp 947 passed + 2 skipped, tsc clean.
- #12 TM2-1 (20573ce): all 6 plan items. test_backup.py + your test_backup_edge.py: 37 passed on Linux; Windows Git Bash not available here. No --stop flag (docs recommend stop → backup → start).
Details are under `## Fix round 1` in each report.

## 2026-11-27 15:19 IST · TM2-5 · status
TM2-5 started on tm2/TM2-5 (main), with one Sonnet developer. Note: the brief says to use "the same writability probe the order path uses", but that probe is a private closure in src/sdk/bindings.ts:167-175, which isn't in TM2-5's file list. I'm replicating its exact logic in src/http.ts with a pointer comment, not exporting it. If you'd rather it be shared, allow bindings.ts (or a small shared module) and I'll switch. TM2-6 waits for TM2-3 to merge.

## 2026-11-27 15:21 IST · TM2-5 · status
PR opened: https://github.com/vjk7989/tradedesk/pull/17 (tm2/TM2-5). trade-mcp 922 passed + 1 skipped, tsc clean. The audit probe is duplicated from bindings.ts:167-175 (see report); the runbook line is in coord/reports/TM2-5.md.

## 2026-11-27 15:39 IST · TM2-1, TM2-2, TM2-3, TM2-4, TM2-5 · status
#12 merge noted, thanks; the tm2/TM2-1 worktree and branch are removed. All four fix rounds are in progress in parallel, branches pulled with your edge tests:
- #11 round 2: 30 s timeout on test :28.
- #13 round 1: late-connect close, gemini-3.8-flash, README line.
- #14 round 1: items 1–5.
- #17 round 1: recompute when now < at.
Next per your queue: TM2-7 CI, then TM2-8, then TM2-9 and TM2-11. TM2-6 and TM2-10 wait on #13 and #17.

## 2026-11-27 15:40 IST · TM2-2 · status
#11 fix round 2 pushed (d908885): 30_000 ms timeout on test :28, assertions unchanged. trade-mcp 946 passed + 2 skipped; the 1 failure is the known server.edge "concurrent executes" clock test. tsc clean.

## 2026-11-27 15:40 IST · TM2-3, TM2-5 · status
- #13 fix round 1 pushed (ec3ab41): late-connect client is closed, default gemini-3.8-flash, and the agent-runner/README.md api-gemini bullet plus the backend table line. agent-runner 507/507, tsc and build clean.
- #17 fix round 1 pushed (fe445b7): recompute when now < at. readyz tests + edge 69/69; full run only fails the known server.edge clock test. tsc clean.
#14 (TM2-4) fix round still in progress.

## 2026-11-27 15:43 IST · TM2-4, TM2-8 · status
- #14 fix round 1 pushed (a988f9e): all 5 items. Own + edge tests 120 passed, 1 skipped (yours).
- TM2-8 started on tm2/TM2-8, with one Sonnet developer.
- TM2-7 (CI) is on hold on my side pending a local permission decision by my user. I'll post when it starts.

## 2026-11-27 15:43 IST · TM2-8 · status
PR opened: https://github.com/vjk7989/tradedesk/pull/21 (tm2/TM2-8). agent-runner 406/406, tsc and build clean, `--help` OK. Only main.ts arg handling, 2 README lines and a new test file.

## 2026-11-27 15:59 IST · TM2-2, TM2-3, TM2-4, TM2-5, TM2-6, TM2-10, TM2-7 · status
- Merges of #11, #13, #14 and #17 noted, thanks; their worktrees and branches are removed.
- TM2-6 (tm2/TM2-6) and TM2-10 (tm2/TM2-10) started from main 0f66303, with one Sonnet developer each.
- TM2-10 note: analyzerStatus() can't take an AbortSignal without editing openalgo/client.ts (not in the file list). The OpenAlgo call stays bounded by the client's own internal timeout; /readyz's race moves to AbortSignal.timeout, and the bt fetch gets redirect:"manual".
- TM2-7: still waiting on my user's decision. TM2-9 and TM2-11 come after these two.

## 2026-11-27 16:02 IST · TM2-6, TM2-10 · status
- PR opened: https://github.com/vjk7989/tradedesk/pull/22 (TM2-6 Telegram). agent-runner 549/549, tsc and build clean.
- PR opened: https://github.com/vjk7989/tradedesk/pull/23 (TM2-10 shared probe). trade-mcp 1100 passed + 3 skipped, tsc clean. One deviation, see the report § 3: the OpenAlgo /readyz check stays a cleared setTimeout race, because AbortSignal.timeout broke your tm2_5 edge fake-timer test, and analyzerStatus() takes no signal (client.ts is off-list). The bt fetch is truly aborted and uses redirect:"manual".
Next: TM2-9 and TM2-11 in parallel. TM2-7 is still waiting on my user.

## 2026-11-27 16:05 IST · ALL · status
Handover accepted, confirmed by my user. Running solo mode per coord/TM2_SOLO.md (separate Sonnet developer, Sonnet reviewer, Opus test writer and Haiku runner; merge only on green; your §4 list goes to you first). #21 merge noted; tm2/TM2-8 worktree removed.
- TM-14 (#19): pulled tm/TM-14. Items 1–4 now pass (TM1's effb4a7 plus main). The only failing test is `test_nan_premium_on_expiry_bar_without_underlying` (item 5). A Sonnet developer is on items 5 and 6; SENSEX stays lot 1 plus a warning (no verified source).
- #22 TM2-6 and #23 TM2-10: Sonnet review and Opus edge tests running in parallel.
- Next: TM-15, TM2-9, TM2-11, TM2-12. TM2-7 is still on hold for my user's local permission decision.

## 2026-11-27 16:10 IST · TM2-6, TM2-10 · done
- #23 TM2-10 merged. Review approved; 58 edge tests, no bugs; Haiku trade-mcp 1178 passed + 3 skipped on main. Follow-up idea: analyzerStatus(signal?).
- #22 TM2-6 merged after fix round 1. Edge tests found 4 real redaction/sending bugs (padded token, overlapping tokens, MCP token as chat_id, emoji cut); all fixed. Haiku agent-runner 729/729 on main.
In flight: TM-14 (#19, items 5–6) and TM-15 (measuring). Next: TM2-9, TM2-11, TM2-12.

## 2026-11-27 16:14 IST · TM-14, TM2-9, TM2-11 · status
- #19 TM-14: fix round 1 items 5–6 pushed (ab49a6f). A NaN expiry without an underlying settles on the last valid close (else 0 plus a warning); invalid weekly dates return None. SENSEX stays lot 1 (no verified source). The 110 TM-14 tests pass. An Opus test writer is adding item 5/6 edge tests, then Haiku runs the full suite.
- Found on main (Linux only): bt-service tests/test_extraction.py::test_safe_run_dir_windows_backslash_path fails on Linux; it builds a backslash path from /tmp, which is only meaningful on Windows. Not caused by TM-14. I'll write a small follow-up task (skip on non-Windows, or fix safe_run_dir); treating it as the baseline for now.
- #24 TM2-9 risk:lint: Sonnet review approved (LOW notes only); edge tests running.
- TM2-11 troubleshooting doc: developer started. TM-15 is still measuring/fixing.

## 2026-11-27 16:21 IST · TM2-9, TM2-11, TM2-12 · done
- #24 TM2-9 risk:lint merged: 52 edge tests, no bugs; Haiku trade-mcp 1245 passed + 3 skipped.
- #25 TM2-11 troubleshooting doc merged: reviewer grep-checked ~130 strings, 0 missing; 3 LOW accuracy fixes applied first.
- #26 TM2-12 --next 1..100 merged: the test writer updated the 3 pinned TM2-8 edge tests (intentional change) and added 35 edge tests; Haiku agent-runner 776/776.
- #19 TM-14: fix round 2 pushed (edge tests caught a look-ahead: with no expiry bar and no underlying, settlement used a post-expiry close; now cut off at the expiry date). 146/146 TM-14 tests pass; the full bt-service Haiku run is in progress.
New tasks (briefs on main):
- TM2-13: make the Windows-only backslash test skip on non-Windows, plus a POSIX counterpart (it's red on Linux main today).
- TM2-14: README + runbook links for troubleshooting, backup, holidays, risk:lint and /readyz.
- TM2-15: /readyz really cancels the OpenAlgo probe via analyzerStatus(signal?).

## 2026-11-27 16:37 IST · TM-14, TM2-13, TM2-14, TM2-15 · done
- #19 TM-14 options engine merged after fix rounds 1 and 2 (round 2: the edge tests caught a look-ahead in expiry settlement with no expiry bar and no underlying). Haiku: bt-service 1573 passed; its only failure was the Linux-only baseline test, fixed by #29, which merged first. Decisions are in ADR-16. SENSEX stays lot 1 plus a warning (unverified).
- #29 TM2-13 merged: the Windows-only backslash test now skips off Windows, with a POSIX counterpart. bt-service on Linux main: 1428 passed, 1 skipped, 0 failed.
- #27 TM2-15 merged: /readyz aborts the OpenAlgo request at its 3 s deadline. 47 edge tests; trade-mcp 1297 passed (run twice).
- #28 TM2-14 merged: README and runbook links. Per review, the runbook lints risk.json inside the trade-mcp image (the host needs only Docker).
- TM-15 resumed: measured 210 warnings (not ~570); 167 come from local_loader.py:128, now fixable since TM-14 merged.
Note for the owner: the deploy suite can't run on my machine (no Docker). The compose tests in deploy/ need a Docker host, which is one more reason for TM2-7 (CI); that's still pending my user's decision.

## 2026-11-27 17:03 IST · TM-15, TM2-16 · done
- #30 TM-15 merged: bt-service warnings 210 → 43 (the brief's ~570 was stale). The cause was `pd.Timedelta("<str>")` triggering numpy's generic-unit DeprecationWarning, in local_loader.py:128 (167) and india_options.py (34, from TM-14). Fixed value-identically; no filters. The remaining warnings are test-origin, third-party, or one india_broker_loader warning where the fix would change values. 151 edge tests, which fail when the fix is reverted. Haiku: 1740 passed, 1 skipped, 0 failed.
- New task TM2-16: run_backtest rejects lowercase "1h" though the loader supports it (found by the TM-15 edge tests). Developer started.
- hand-off.md rewritten with this session's state, in-flight work and next candidates.

## 2026-11-27 17:42 IST · TM2-16 · done
#31 merged after fix round 1. The review and edge tests caught that runner.main() discarded the validator's canonical value, so loaders and run cards still saw "1h". It now writes "1H"/"1D"/"1W" back. m/M are never folded. Haiku: bt-service 1859 passed, 1 skipped, 0 failed. The queue is empty apart from TM2-7 (CI), which waits on my user's local permission decision. Candidates for next briefs are in hand-off.md. Owner: is a non-IST time zone for jobs (e.g. America/New_York) wanted? That's a product call, so I won't brief it without your answer.

## 2026-11-27 20:40 IST · TM2-17, TM2-18, TM2-19, TM2-20 · status
Ack on two-builder mode: I merge only my `tm2/*` PRs, and I rebase and re-run on the latest main before each merge. Jobs tz ruling noted (`Asia/Kolkata`/`UTC` only).
- **TM2-7:** my worktree and local branch are dropped; it's yours.
- **Developers started** on TM2-17, TM2-18, TM2-19 and TM2-20 in parallel; all four touch disjoint files.
- **TM2-19 brief path:** the lint CLI builds to `trade-mcp/dist/src/risk/lint.js` (rootDir "."), not `dist/risk/lint.js`. The developer will use the real paths.

## 2026-11-27 21:15 IST · TM2-18 · merged
- **Merged:** PR #35, head `97fc0f6`, tested on main `ac0e913` → merge `011592b`.
- **agent-runner (PR merged onto main):** 833/833 tests pass, tsc and build clean.
- **Review:** approve, with 2 LOWs:
  - on timeout, `res.body.cancel()` is a no-op on a real Response because the `text()` reader holds the lock; the abort signal does the real cut-off;
  - the abort listener is not removed.
  Both are harmless; I'll fold them into a follow-up.
- **Edge tests:** 49 added, no bugs found.
- **TM2-20:** PR #36 is up (docs/backtesting.md); all 7 examples ran offline on fixtures. The developer flagged a doc mismatch for your O-1: `api-docs.ts:24` says 'busy, retry later', but the client message is `backtest service busy, retry later` (`client.ts:124`).

## 2026-11-27 21:30 IST · TM2-20 · merged
- **Merged:** PR #36 (docs/backtesting.md, 300 lines), head `3cbc643` → merge `10a8e68`.
- **Review:** approve. Every key, default and error string was grepped against the code with no mismatches.
- **Examples:** all 7 ran offline through bt-service on the fixtures.
- **Checks:** docs-only, so no package suite to run; the merge onto main `fe757bd` is clean.
- **Not covered in the doc** (it is at the line cap): the EXECUTE_TIMEOUT_MS clamp to 5000–900000 and the `trades truncated to 1000` warning. I'll fold both into a later docs follow-up.

## 2026-11-27 21:55 IST · TM2-19 · merged
- **Merged:** PR #37, head `66bd748`; smoke goes from 11 to 14 steps (/readyz, risk:lint, jobs --check).
- **Merge test:** PR merged onto main `cfc2cd3`, compared with a baseline main run.
  - Shifted in-hours clock: baseline 11/11, PR 14/14.
  - Real clock (~02:00 IST): steps 4 and 5 fail identically on baseline and PR ("risk denied: market closed for NSE"). This is pre-existing and not caused by the PR.
- **Main moved after the test** (your test files, docs and briefs; no src), so the result still holds.
- **Review:** approve. 3 LOWs, all assertion tightening in step 13/14: assert "MCP_TOKEN: set", anchor "MCP_TOKEN: missing", and check the lint output as well as the exit code.

## 2026-11-27 21:55 IST · TM2-21, TM2-22, TM2-23, TM2-24 · status + question
- **TM2-21 and TM2-23:** developers started. TM2-17 is still running (bt full suite). TM2-22 (docs) starts when a slot frees, to stay at ~3 in parallel.
- **TM2-23:** the cap is strictly additive and off by default. Existing risk checks are untouched, and no key is added to risk.example.json. The api-docs line goes in the report for your O-3.
- **Question: proposed TM2-24 (e2e).** Make smoke deterministic by pinning its clock inside NSE hours. Options:
  - a Date-shift preload passed only to the spawned trade-mcp in smoke;
  - or a test-only clock env.
  It would also fold in the 3 LOWs from #37. It touches nothing in trade-mcp src under the preload option. Because it changes how the market-hours check is exercised, I want your OK first. Shall I brief it?

## 2026-11-27 22:40 IST · TM2-21, TM2-22 · merged
- **TM2-22 (#42), head `d94e108`:** docs-only.
  - Review: approve; every fact was grepped.
  - Fix round 1 corrected one wrong section reference in troubleshooting.
  - backtesting.md is still at 300 lines.
- **TM2-21 (#39), head `60a5412`:**
  - Merge test on main `de9ab4d`: agent-runner 851/851, tsc and build clean. Main moved after that, but only in docs and coord.
  - Review: approve.
  - Edge tests: 15 added. A mutation that removes `removeEventListener` fails 7 of them.
  - `body.cancel()` is kept with a comment: removing it would break the unedited tm2_18 tests, which assert it is called. The abort signal is still the real cut-off.
- **TM2-23 (#40):** review approves. Waiting on edge tests.
- **TM2-17 (#41):** review found a MEDIUM regression. A naive-then-offset column used to drop the offset row as NaT; with `format="ISO8601"` it now gives an object column, and `tz_localize(None)` raises, crashing the load. A fix round follows after the edge tests.
- **Still open:** the TM2-24 question (pin the smoke clock) is waiting on you.

## 2026-11-27 23:20 IST · TM2-23, TM2-24, TM2-17 · merged / status
- **TM2-23 merged (#40), head `4159be7`.**
  - **CI caught a pinned test we missed.** Its first run went red on `deploy/test_deploy.py::test_risk_example_keys_match_schema`, which pins 13 risk keys and requires schema keys == risk.example.json keys. Per the brief, the test writer updated it: count 14, plus `OPTIONAL_OFF_BY_DEFAULT = {"maxShortOptionQtyPerOrder"}`, asserted to be in the schema and NOT in the example. All 4 CI jobs then passed.
  - **Re-run after your O-3 landed:** trade-mcp 1571 passed, 3 skipped; tsc and build clean.
  - **Edge tests:** 70, including a same-engine oracle over 1,440 orders with the key absent and set. I had a first, git-based "compare with origin/main" version rewritten, because it would have gone red on main after the merge.
  - **api-docs line for you,** from coord/reports/TM2-23.md: the optional `maxShortOptionQtyPerOrder` caps the qty of NFO/BFO CE/PE SELL orders; it is off when unset, and a SELL that closes a long position is capped too.
  - **Lesson:** our merge tests now include `pytest deploy/` whenever config or schema changes. I had wrongly assumed deploy needed Docker throughout.
- **TM2-24:** ack, preload option. The brief is on main (coord/tasks/TM2-24.md). The preload goes only into the spawned trade-mcp args, with nothing in src, and the #37 LOWs are folded in. The developer has started.
- **TM2-17 (#41):** fix round 1 is in progress; the plan is in coord/reviews/TM2-17.md.
  - Edge tests found that date-only strings with trailing whitespace become all-NaT, so the symbol silently returns None.
  - The fix strips whitespace and masks rows whose tz-awareness differs from the first row, as the old path did. That also removes the naive-then-offset crash.
- **Sandbox memory tests:** possible flake in `trade-mcp/test/sandbox*.test.ts` memory-limit tests (`/memory/i`). Seen once on a developer machine, not reproduced in 4 later runs. Watching it.

## 2026-11-27 23:50 IST · TM2-25, TM2-26, TM2-27 · status
- **New tasks acked.** Developers are on TM2-26 (Dependabot) and TM2-27 (risk.status limits). TM2-25 waits for #45 (O-5) to merge, as the brief says.
- **TM2-27 boundaries:** status() only, plus a new test. No check logic changes. The api-docs text goes in the report for you.
- **TM2-26 boundaries:** only `.github/dependabot.yml` and a README line. No workflow, settings or auto-merge changes.
- **TM2-24 (#46):**
  - Review: approve; the preload reaches only the trade-mcp spawn, and nothing changed in src.
  - Merge test on main `f3271d0`: smoke 14/14 twice at the real clock (Fri night).
  - CI: agent-runner, trade-mcp and deploy are green, bt-service is pending. I merge when it's green.
- **TM2-17 (#41):** fix round 1 is pushed (strip and awareness mask). The full suite has 2 failures, and both are the expected strict-xfail XPASSes. The test writer is converting them now.

## 2026-11-28 00:30 IST · TM2-24, TM2-26 merged · Dependabot PRs · status · question
- **Merged:**
  - **#46 TM2-24:** smoke clock preload; 14/14 twice at the real clock; all 4 CI jobs green.
  - **#47 TM2-26:** Dependabot, using `uv` for bt-service; all 4 CI jobs green.
- **The first Dependabot PRs** (none merged; CI was still running when I checked):
  - #49 actions/setup-node 4.4.0 → 7.1.0 (major)
  - #50 actions/checkout 4.4.0 → 7.0.1 (major)
  - #51 agent-runner group: @google/genai 3.3.0 → 3.6.1 (minor)
  - #52 bt-service minor/patch group: 2 updates
  - #53 pandas 2.3.3 → 3.1.1 (major). **It also rewrites the pyproject constraint `pandas<3` → `pandas<4`.**
- **Question (who takes these?)** My proposal:
  - I review and merge #51 and #52 once CI is green.
  - #49 and #50 are major action bumps; I'd merge them only after you OK them.
  - #53 I'd **close**. The `pandas<3` pin is deliberate: the engine relies on pandas 2 datetime and offset behaviour, see TM2-16/TM2-17. A pandas 3 move should be its own task. I'd also add a Dependabot `ignore` for pandas major versions in a small follow-up.
  - OK?
- **TM2-27 (#48):**
  - Review: approve. The test writer updated 9 pinned shape tests (an AC change) and added 34 edge tests; no bugs found. Merge test is running.
  - **Your o1 test:** `o1_api_docs_options.edge.test.ts` "unchanged vs main" compares against the live `origin/main` via git. It fails on any branch cut before your O-5 api-docs commits, even though TM2-27 doesn't touch api-docs. It's the same time-bomb pattern I had rewritten out of the TM2-23 edge tests. Suggest pinning it to a fixed baseline.
  - The api-docs text for `risk.status` is in coord/reports/TM2-27.md for you to apply.
- **TM2-17 (#41):** fix round 2 is with the developer.
  - Round 1's awareness mask took its reference from the first string, so a junk first row ("", whitespace, garbage) made every offset row NaT.
  - The round 2 plan: the reference is the first row that actually parses.
  - This is a new defect, not a repeat. If round 2 fails, I stop and ask you.
- **Started:** TM2-31 (walk-forward over options/composite; tests first) and TM2-30 (`--dry-run`), following your order. TM2-25 is next when a slot frees; TM2-28 and TM2-29 after that.

## 2026-11-28 01:40 IST · TM2-27, TM2-25, TM2-30 · merged · notes
Ack on the Dependabot split: you take PRs touching `.github/`; I take the lockfile PRs (#51, #52, #53) with the normal chain. #53 (pandas 3) stays open and unmerged until you've seen my close proposal above.

**Merged:**
- **#48 TM2-27:** risk.status reports every limit.
  - The test writer updated 9 pinned shape tests (AC change) and added 34 edge tests.
  - Merge test: trade-mcp 1766/1766. CI: all 4 green.
  - The api-docs text is in coord/reports/TM2-27.md.
- **#55 TM2-25:** search also matches API_HEADER rules.
  - Your 4 O-5 search tests were rewritten to keep the readonly intent: no trade.* *entry* rendered, and Rules lines are verbatim header lines only. The documented-gap test is flipped.
  - 247 edge tests compare the output with main's searchApi. CI: all 4 green.
- **#54 TM2-30:** `--dry-run`.
  - The edge tests caught a HIGH bug: `--dry-run=<name>` was not recognised and fell through to the real scheduler. Fixed in round 1.
  - Fix rounds 1 and 2 also:
    - redact every printed line, including the url;
    - redact every job's, every backend's and the Telegram secrets;
    - withhold the prompt and url (and the unknown-name list) when any set secret is shorter than 4 characters, instead of over-redacting.
  - Merge test: 948/948, and both dry-run forms exit 0 without "scheduler started". CI: all 4 green.

**For you, owner-side:**
1. **"kill switch" header line.** TM2-25's AC "kill switch returns header lines" can't be met: API_HEADER has no line mentioning the kill switch. A pinned test records the gap. Add a line in api-docs.ts and the test flips.
2. **Search ranking (proposed TM2-32).** Rules lines are the first 8 header matches in header order, unranked. A broad token can push out the wanted line; e.g. "e maxShortOptionQtyPerOrder" drops the cap line. Proposed fix: rank by tokens matched, then header order. search.ts only. OK to brief it myself?
3. **Load-sensitive tests.** In a merge test with 3 suites running in parallel on one machine, these failed once and then passed on rerun; CI was green:
   - O-4 `o4_audit_bounds.edge` perf tests: "10 MB … under 1 s" took 1205 ms, and the 500k-key case hit the 5 s timeout;
   - `sandbox.edge` "memory cap": the timeout fired before the memory error.
   Consider looser perf bounds, or marking them as CI-only.

**Status:**
- TM2-17 (#41): fix round 2 is green on the branch (bt 1931 passed, 0 failed, 403 warnings). Merge test running.
- TM2-28 (smoke options + audit.recent) and TM2-31 (walk-forward options): developers working.
- TM2-29 is next.

## 2026-11-28 04:30 IST · merges · Dependabot · decisions needed
**Merged since my last post:**
- **#41 TM2-17:** broker date format. Two fix rounds: whitespace and mixed awareness, then junk first rows. bt 1931 passed, 403 warnings.
- **#56 TM2-28:** the smoke run adds an options backtest and an audit.recent step.
  - It also fixes a pre-existing smoke bug: every run orphaned bt-service's uvicorn, because only `uv` was killed. I found and killed 19 orphans.
  - Children are now spawned in their own process group, and the whole group is killed on every exit path. I verified 0 survivors after two smoke runs.
- **#58 TM2-29:** connect-clients docs. A review HIGH was fixed first: /readyz is internal-only (use the exec form), and only /healthz is public.
- **#60 TM2-33:** Dependabot ignores pandas major versions. #53 is closed.
- **#61 TM2-32:** Rules ranking.
  - After your O-7 header change, its edge tests (which hard-coded a 9-line header) went red on main. I held the merge.
  - The test writer rewrote them to derive the layout from API_HEADER, and the PR was re-tested on main 5533db5.
- **#62 TM2-34:** pandas 3 readiness report. Under pandas 3.1.1: 80 failed and 1851 passed, all in two test files and all from ns→us resolution.
  - Review caught a wrong reproduce command: plain `pytest` under `uv run --with` still runs pandas 2. It's fixed to `python -m pytest`.

**Dependabot:**
- **#51 merged:** genai 3.6.1. Re-tested on the latest main: 948/948.
- **#52 held:** CI bt-service is red. The PR is labelled a bump but downgrades ccxt 4.5.94 → 4.5.64, and changes the uv.lock revision 3→5. The old ccxt shells out to git on import, which the bt sandbox blocks. I asked `@dependabot recreate`; it won't be merged until it's green with ccxt ≥ 4.5.94.

**Decisions for you:**
1. **pandas 3 unit policy (from the TM2-34 report).** Normalise loader output and `_TIMEFRAME_DELTA` to **ns** (recommended: the engine's int64 view at engines/base.py:298 and the tests assume ns), or accept us? I need this before I can brief P3-A, P3-B and P3-C. Recommended order: P3-A with or before P3-B, then P3-C, which lifts the pin.
2. **Walk-forward src follow-ups (from the TM2-31 review).** Proposed:
   - **TM2-35:** keep completed folds when a later fold's test run fails. Return `ok:false` plus the folds done so far plus the error; today they are dropped. For options this is the normal case once the range passes the last expiry. It updates the 2 existing pins in test_walkforward(.edge).
   - **TM2-36:** add a warning for thin folds below a bar-count threshold.
   OK to brief both?

**Status:** TM2-31 (#63, tests-only) is being reworked by the test writer:
- make the param selection discriminate between candidates;
- add a perturbation test for no look-ahead in fold 1;
- cut the runtime from ~6 min to under 2 min, since it would have doubled bt CI.
