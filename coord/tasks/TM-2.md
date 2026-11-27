# TM-2 · agent-runner · make clean shutdown on Ctrl+C / SIGTERM testable and tested
Branch: tm/TM-2        Base: main @ 46000ed
Owner: TM1

## Files you may touch (≤5)
- `agent-runner/src/main.ts`
- `agent-runner/test/tm2_signals.test.ts` (new)

## Do not touch
Any other file. In particular, no existing test files.

## Context (read only these)
- `agent-runner/src/main.ts:12-45`:
  - `export async function main(args = process.argv.slice(2))`;
  - the signal handlers at `:29`, `for (const sig of ["SIGINT","SIGTERM"]) process.on(sig, () => process.exit(0))`;
  - the error exit at `:41`;
  - the "auto-run only when executed directly" check.
- `agent-runner/src/scheduler.ts`: `runScheduler(jobs, {now, sleep, run, stopped?})`, which already accepts a `stopped` callback.
- `agent-runner/test/main.edge.test.ts`: how tests call the exported `main` with `vi.mock("../src/cli.js")`.

## What to build
1. Let `main` take an optional second argument, `deps?: { exit?: (code: number) => void; onSignal?: (sig: string, fn: () => void) => void }`. It defaults to `process.exit` and `process.on`. No behaviour change when it isn't passed.
2. On SIGINT or SIGTERM in scheduler mode:
   - Stop the scheduler loop through its `stopped` callback, so no new job starts after the signal.
   - Let a job that is already running finish, or time out on its own timeout.
   - Then exit 0.
   - A second signal exits 0 immediately.

## Acceptance criteria
- Signal while idle (sleeping) → exit 0 right away, no job runs afterwards.
- Signal while a job runs → that job's report file is still written, then exit 0, and no further job starts.
- Second signal during a running job → immediate exit 0.
- `--once` mode: signal → exit 0.
- `--help` is unchanged. Importing `main.ts` does not register signal handlers.
- All existing tests stay green.

## Verify (must pass before you report)
```
cd agent-runner && npm ci && npx vitest run && npx tsc --noEmit && npm run build
```

YAGNI: no new dependencies, no new CLI flags.
