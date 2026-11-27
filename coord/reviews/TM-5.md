# TM-5 review

## Code review (Sonnet)

Verdict: approve (follow-up noted). Tests not run; read-only review.

1. src/jobs.ts:27, medium (follow-up, per brief): BACKENDS lacks "api-openai", so scheduled jobs cannot select it yet. Needs a separate task.
2. openai.ts:50, low: ok is gated on status==='completed' only; MCP tool failures (mcp_call items with error) are ignored, so a run can report ok with failed tool calls. Same gap exists in api.ts; optional.
3. openai.ts:6, low: default model gpt-5.5 cannot be verified offline; it is overridable via OPENAI_MODEL. Confirm against current docs.
4. openai.ts:66, nit: redact() only masks the exact token; fine for parity with api.ts.
Checked OK: node_modules/openai (7.65.0, exact pin in package.json) resources/responses/responses.d.ts:7302-7361 Tool.Mcp has type 'mcp', server_label, server_url, headers, require_approval 'never' (matches). output_text and refusal content type exist. Validation, https-only, empty-token refusal, redaction in errors and text, raceAbort timeout, refusal and non-completed -> ok:false all match api.ts. Tests use a fake client, no network.

## Edge tests (Opus)
63 new tests on `tm/TM-5` (e6d2089): 60 pass, 3 fail. They found real defects in `src/openai.ts`.

## Fix plan (Opus), fix round 1
Pull `tm/TM-5` first; it contains the new edge tests. Do not edit any test.
1. `src/openai.ts`: the model must fall back to the default when `OPENAI_MODEL` is empty or only whitespace. Use `opts.model || process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL`.
2. A whitespace-only token must be refused before any call. Use `if (!token?.trim())` and send the trimmed token. Apply the same fix in `src/api.ts` (`runApiTask` has the same gap); that file is added to your allowed list for this fix only.
3. Owner ruling: in `src/openai.ts`, a `completed` response with any `mcp_call` output item whose `error` is set gives `ok:false` with error `tool error: <first error text, token-redacted, ≤300 chars>` and the partial text, redacted.
Verify: `cd agent-runner && npx vitest run && npx tsc --noEmit && npm run build`. The 3 failing tests must pass, and nothing else may break. Then push to `tm/TM-5` and append `## Fix round 1` to `coord/reports/TM-5.md`.
