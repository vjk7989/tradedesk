# TM-2 report
Status: done
Branch: tm/TM-2   Commit: 2e94ea7
Files: agent-runner/src/main.ts (+35/-3), agent-runner/test/tm2_signals.test.ts (+110/-0)
Verify: `npm ci && npx vitest run && npx tsc --noEmit && npm run build` → pass
```
 Test Files  8 passed (8)
      Tests  246 passed (246)
> agent-runner@0.1.0 build
> tsc -p tsconfig.build.json
```

Notes / decisions:
- `main(args, deps?)`: `deps.exit` defaults to `process.exit` and `deps.onSignal` to `process.on`. The deps type is exported as `MainDeps`.
- Scheduler mode:
  - First SIGINT/SIGTERM sets `stopping`, which is passed to `runScheduler` as `stopped`, so no new job starts.
  - If idle, it exits 0 immediately. If a job is running, that job finishes (its own timeout applies), then exit 0.
  - A second signal exits 0 immediately.
  - A guard makes the scheduler path call `exit(0)` at most once, because a mocked exit doesn't kill the process.
- `--once` registers SIGINT/SIGTERM → `exit(0)`. `--help` registers nothing. Importing `main.ts` registers nothing.
- Tests use fake timers. The running-job test waits with `vi.waitFor` because the report write uses real file I/O, which fake timers don't drive.
- `scheduler.ts` and existing tests are untouched. No new dependencies or flags.
- developers: 1 sonnet, fix rounds: 0
