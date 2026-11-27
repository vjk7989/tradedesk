# TM-5 report
Status: done
Branch: tm/TM-5   Commit: 47c6f2c
Files: agent-runner/src/openai.ts (new, +71), src/types.ts (+1/-1), src/cli.ts (+4/-1), test/tm5_openai.test.ts (new), package.json + package-lock.json (openai pinned 7.65.0)
Verify: npx vitest run → 279 passed (10 files); tsc --noEmit clean; npm run build clean
Decisions:
- Responses API with tool {type:"mcp", server_label, server_url, headers:{Authorization:"Bearer <token>"}, require_approval:"never"}. Field names checked against node_modules/openai/resources/responses/responses.d.ts (Mcp tool :7302-7370, output_text :799, ResponseStatus :6598, ResponseOutputRefusal :5752).
- DEFAULT_OPENAI_MODEL = "gpt-5.5" (openai SDK README Responses example, README.md:39). Precedence: opts.model > OPENAI_MODEL > default.
- A refusal gives ok:false "refused". Any status other than "completed" gives ok:false "response <status>", with the text kept but redacted.
- Same validation, https-only URL, empty-token refusal, redaction and raceAbort timeout as runApiTask. raceAbort/redact are duplicated locally (api.ts doesn't export them and wasn't in the file list).
Follow-up (TM-7): src/jobs.ts must accept "api-openai" before scheduled jobs can use it. Not edited here, per the brief.
developers: 1 sonnet, fix rounds: 0
