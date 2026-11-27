# TM-5 · agent-runner · OpenAI API backend (`api-openai`) with remote MCP
Branch: tm/TM-5        Base: main (latest)
Owner: TM1

## Files you may touch (≤5)
- `agent-runner/src/openai.ts` (new)
- `agent-runner/src/types.ts` (add `"api-openai"` to `Backend`)
- `agent-runner/src/cli.ts` (route `"api-openai"` next to the existing `"api"` branch at around line 160 and line 194; keep the switch exhaustive)
- `agent-runner/test/tm5_openai.test.ts` (new)
- `agent-runner/package.json` + lock (add the official `openai` SDK, pinned to the exact current version from `npm view openai version`)

## Do not touch
Other files, and no existing test files. The jobs validation in `src/jobs.ts` lists the allowed backends. If adding `api-openai` there is needed for scheduled jobs, list it in your report as a follow-up; don't edit it.

## Context (read only these)
- `agent-runner/src/api.ts` (whole file, about 100 lines): the Anthropic backend you mirror. It covers:
  - `validMcpSpec` checks;
  - an https-only URL;
  - the token read from `process.env[tokenEnv]`, refused if empty;
  - token redaction everywhere;
  - `raceAbort` timeout;
  - the result shape `{ok, text, error?, exitCode: null}`.
- `agent-runner/src/types.ts` and `cli.ts:150-200`.
- OpenAI docs for the Responses API remote MCP tool. Look up the current exact field names in the official docs or the SDK README, and don't guess:
  - a `tools` entry of type `"mcp"` with `server_label`, `server_url`, `headers: { Authorization: "Bearer …" }` and `require_approval`;
  - the response output text.

  If a field name differs from this description, follow the official docs and say so in your report.

## What to build
`runOpenAiTask(opts: { prompt; mcp: {name, url, tokenEnv}; timeoutMs?; model?; client? })`:
- Model: default `process.env.OPENAI_MODEL`, else whatever OpenAI's docs name as the current general model. Write that default in one constant with a comment.
- Behaviour: exactly the same validation, redaction and timeout behaviour as `runApiTask`.
- Approvals: `require_approval: "never"`. The MCP server enforces risk limits server-side.
- Result: final text from the response. A refusal or incomplete status gives `ok: false`.
- Errors: API errors give `ok: false`, with the token redacted.
- Wiring: `runTask({ backend: "api-openai", ... })` routes to it.
- Client: `new OpenAI()` reads `OPENAI_API_KEY`; injectable for tests.

## Acceptance criteria
- Request shape is asserted in tests with a fake client: the mcp tool, the https URL, the bearer header from env, `require_approval`, and the model.
- A missing token env, a non-https URL or a bad name is refused before any call.
- Token redaction holds in errors and in returned text.
- Timeout fires even when the client ignores the abort signal.
- No test makes a real network call.
- Existing tests stay green.

## Verify (must pass before you report)
```
cd agent-runner && npm ci && npx vitest run && npx tsc --noEmit && npm run build
```

YAGNI: no streaming, no multi-turn, no Gemini backend.
