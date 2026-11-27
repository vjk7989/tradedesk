# TM-7 review
## Code review (Sonnet)
Verdict: approve

1. agent-runner/src/jobs.ts:27,51 - OK. BACKENDS has all five; error lists all five. Routing already exists (src/cli.ts:197), and the test confirms main --once reaches runOpenAiTask.
2. agent-runner/README.md:8 and :22 - OK. One backend line plus the table row; the table row is a small addition beyond "one line" but avoids a contradiction (nit, no action).
3. agent-runner/test/tm7_jobs_openai.test.ts - OK. Uses vi.mock with no network; rejects "openai", "API-OPENAI" and "".
4. coord/reports/TM-7.md is included (normal for coordination). Nothing else changed.
