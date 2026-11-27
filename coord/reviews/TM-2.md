# TM-2 review

## Code review (Sonnet)

Verdict: approve (minor notes only). Tests not run by reviewer (no node_modules in worktree); logic read-through only.

1. main.ts:43-52, ok: first signal sets stopping; idle -> bye() at once; running -> waits. After the job, run's finally clears running, scheduler loop sees stopped() and returns, then `if (stopping) bye()` exits. Second signal exits at once; `exited` guard gives at-most-once. Signal arriving between job completion and loop exit sees running=false and exits immediately, which is safe since no job is mid-flight.
2. main.ts:33, low: --once handler calls exit(0) with no `exited` guard, so two signals could call exit twice when exit is mocked (real process.exit never returns). Reuse bye() there. Also --once now exits 0 on SIGINT where it previously used Node default; this is required by the brief.
3. main.ts:11-18, ok: handlers are registered only after the --help return and inside main(), and main() only auto-runs when executed directly, so import and --help register nothing (both tested).
4. main.ts:55-64, low: a job that throws still resets running via finally; scheduler logs it. A job with no timeout would block shutdown indefinitely, but the brief says jobs have their own timeout.
5. tm2_signals.test.ts, ok: uses fake timers, advanceTimersByTimeAsync and vi.waitFor, with real report-file and call-count assertions; not tautological. Nit: the idle test cannot distinguish "exit called" from "scheduler returned"; the runTask-not-called assertion covers it. Nit: the --once test relies on a single `await Promise.resolve()` for handler registration; fragile if main gains an await before it.

## Test run (Haiku)

Branch review-tm2 @ b5082f4 merged with origin/main (clean, no conflicts). Full log: G:\uday-demos\reports\TM-2.md

| command | result | time |
|---|---|---|
| git merge -q --no-edit origin/main | clean, exit 0 | <1s |
| npm ci (agent-runner) | exit 0, 0 vulnerabilities | 7s |
| npx vitest run | 9/9 files, 267/267 tests pass | 4s |
| npx tsc --noEmit | exit 0 | 3s |
| npm run build | exit 0 | 1s |
| node dist/main.js --help | exit 0 | <1s |

Verdict: GREEN. No failures. Baseline-known failures ignored: none.

## Verdict (Opus)
PR #2 merged as 58df924. Sonnet approved, 21 Opus edge tests, Haiku: agent-runner 267/267, tsc, build and --help all green.
