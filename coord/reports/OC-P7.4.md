# OC-P7.4 report

Status: done (one known, pre-approved failure: the pinned binding-surface test)
Branch: oc/OC-P7.4   Base: main @ 6d5cad8
Files:
- `trade-mcp/src/backtest/client.ts` (+58/-8: `WalkForwardRequest`/`WalkForwardFold`/`WalkForwardResult`, `walkForwardTimeoutMs`, shared `post()`, `walkForward()`)
- `trade-mcp/src/sdk/bindings.ts` (+66/-1: `backtest.walkForward`, import of `WalkForwardRequest`)
- `trade-mcp/src/sdk/api-docs.ts` (+7: `WALKFORWARD_NOTE`, `backtest.walkForward` entry)
- `trade-mcp/test/walkforward.test.ts` (new, 18 tests)

Verify:
```
cd trade-mcp && npm install && npx vitest run test/walkforward.test.ts && npx vitest run && npx tsc --noEmit && npm run build
```
- `npx vitest run test/walkforward.test.ts` → 18 passed
- `npx vitest run` → 1 failed | 670 passed | 1 skipped; the only failure is `test/sdk.edge.test.ts::exposes exactly the AC namespaces/functions` (pinned 16-name list; brief says do not edit and the orchestrator will bump it to 17)
- `npx tsc --noEmit` → exit 0
- `npm run build` → exit 0

What was built:
- `BacktestClient.walkForward(req)` POSTs `{base}/walkforward` with the same Bearer header, `AbortController` + timeout race, `redact()`, and 401/503/429/413/422/5xx mapping as `run()`. Both methods now share one private `post(path, body, timeoutMs)` so the mapping cannot drift. Default `walkForwardTimeoutMs = 660000` (server budget 600 s); `run()` keeps 180000. No timeout/apikey field is ever sent.
- 422 path redacts the full response text first, then slices to 500 chars (test uses a >600-char body containing the token and asserts `[REDACTED]`, no token, length bound).
- Binding `backtest.walkForward` requires `code, symbols, start, end, trainDays, testDays, candidates`; optional `metric, interval, capital, costs, source`. `check()` rejects any other key, so caller `timeout`/`apikey`/snake_case `train_days` all throw `unknown field`. Maps `trainDays→train_days`, `testDays→test_days`; validates symbols are strings, candidates are objects, metric ∈ sharpe|total_return|calmar.
- Result reshaping: `folds[].train_score→trainScore`, `test_metrics→testMetrics` (defaults `[]`/`{}`/`null`), `oos_equity→oosEquity` downsampled to ≤100 with the existing `downsample()` (first and last kept for both 100 and 101 points), `summary`, `warnings`, `error`.
- Auditing is identical to `backtest.run`: one line per call with `action`, `args` minus `code` plus `codeLength` + `codeSha256`, `decision`, `ok`, `error`. Rejections (unknown field, bad metric, not configured) are audited with `decision: "error"`; the code body never reaches the audit file.
- Read-only scope: `createBindings(..., {scope:"readonly"})` still deletes only `trade`, so `backtest.walkForward` works with a read-only token (test covers `trade === undefined` + a successful call).
- API_DOCS: `backtest.walkForward` entry states train-only tuning / frozen OOS, trainDays ≥ 20 and testDays ≥ 5 as calendar days, 1–10 candidate dicts, ≤60 runs, 10-minute server budget, metric values. `searchApi("walk")` and `searchApi("walkforward")` both return it (tested).
- No polling, streaming, new dependencies, risk-engine or broker calls; `src/http.ts`, `src/oauth/*`, `src/risk/*`, `src/config.ts`, `bt-service/`, `agent-runner/`, `deploy/` untouched.

Known follow-up (orchestrator-owned): `trade-mcp/test/sdk.edge.test.ts:55-59` pins the 16-name binding surface; it now needs `backtest.walkForward` added (17). I did not edit it per the brief.
