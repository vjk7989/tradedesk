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

## Fix round 1
Commit: 971e705. Files: agent-runner/src/openai.ts, agent-runner/src/api.ts (token line only).
1. Model: `opts.model || process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL`.
2. Token: `process.env[tokenEnv]?.trim()`, refused if empty (openai.ts and api.ts). The trimmed token is the one sent and the one redacted.
3. A completed response with any `mcp_call` item whose `error` is set gives ok:false with `tool error: <text, redacted, ≤300 chars>` and the redacted partial text. The error text is taken from a string, else `.message` (protocol/http), else `.content` (tool execution), else JSON (McpToolCallError union, responses.d.ts:721-737; McpCall :4475, error :4505).
Verify: vitest 341/342; tsc and build clean. The 3 target tests pass.
Remaining failure, a test conflict and not a code bug: test/tm5_openai.edge.test.ts:258 "mcp_call item with error, status completed (documents behaviour: reported as ok:true, error not surfaced)" pins the pre-fix behaviour that plan item 3 reverses. Not edited, per the rules. It needs to expect ok:false, an error starting "tool error: tool failed [redacted]", text "done", and no token.
developers: 1 sonnet (same), fix rounds: 1
