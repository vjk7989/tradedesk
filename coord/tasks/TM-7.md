# TM-7 · agent-runner · allow the `api-openai` backend in scheduled jobs (after TM-5 is merged)
Branch: tm/TM-7        Base: main after TM-5 is merged        Owner: TM1
Start this only after TM-5 shows `done` on the board.

## Files you may touch
- `agent-runner/src/jobs.ts`: the `BACKENDS` list at around line 27 and the error text at around line 51.
- `agent-runner/jobs.example.json`: nothing to change unless you add a commented example. JSON has no comments, so leave it alone.
- `agent-runner/README.md`: add one line about the `api-openai` backend and `OPENAI_API_KEY`.
- New: `agent-runner/test/tm7_jobs_openai.test.ts`.

## Acceptance criteria
- `parseJobs` accepts `backend: "api-openai"` and rejects unknown backends with an error message that lists all five.
- `--once` with an `api-openai` job routes to `runOpenAiTask`. Test this with `vi.mock`; no network.
- Existing jobs tests stay green. If one pins the exact error text listing four backends, don't edit it: list it in your report and I'll update it.

## Verify
```
cd agent-runner && npm ci && npx vitest run && npx tsc --noEmit && npm run build
```
