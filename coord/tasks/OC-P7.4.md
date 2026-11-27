# OC-P7.4 · trade-mcp · expose walk-forward to the AI as `backtest.walkForward`
Branch: oc/OC-P7.4        Base: main @ 6d5cad8
Owner: OC1

Remember: work only in your own worktree `G:\uday-demos.oc1`. Never `git switch` in `G:\uday-demos`.

## Files you may touch (≤5)
- `trade-mcp/src/backtest/client.ts`
- `trade-mcp/src/sdk/bindings.ts` (only the `backtest:` namespace block, around line 292)
- `trade-mcp/src/sdk/api-docs.ts` (only the backtest entries, around line 64)
- `trade-mcp/test/walkforward.test.ts` (new)

## Do not touch
`trade-mcp/src/http.ts`, `src/oauth/*`, `src/risk/*`, `src/config.ts`, and anything in `bt-service/`, `agent-runner/`, `deploy/`.

## Context (read only these)
- `trade-mcp/src/backtest/client.ts:36-95`: `BacktestClient`, its `run()` POST to `/backtest`, `redact()` (:49), and the error mapping (401/503/429/413/422/5xx). Note the 422 path: redact the full text, then slice to 500 chars.
- `trade-mcp/src/sdk/bindings.ts:292-340`: the `backtest.run` binding. It validates args (unknown fields rejected), audits each call with codeLength + codeSha256 and never the code body, downsamples equity to ≤100 points, keeps the first 20 trades, and never touches the risk engine or broker.
- `trade-mcp/src/sdk/api-docs.ts:64`: the `backtest.run` API_DOCS entry.
- `bt-service/bt_service/app.py`: the `/walkforward` route and its request model (fields code, symbols, start, end, train_days, test_days, candidates, metric, interval, capital, costs, source; `extra="forbid"`; no timeout field). `bt-service/bt_service/walkforward.py`: the result shape `{ok, metric, folds:[{train,test,chosen,train_score,test_metrics}], oos_equity, summary:{folds, scored_folds, mean_test_<metric>, positive_folds}, warnings, error?}`.
- `trade-mcp/test/backtest.test.ts`: test style with a fake fetch.

## What to build
1. `BacktestClient.walkForward(req)`: POST `{base}/walkforward` with the same Bearer auth, error mapping, redaction and timeout race as `run()`. Default timeout 660000 ms, because the server budget is 600 s. Send exactly the request-model fields and never send a timeout.
2. Binding `backtest.walkForward({code, symbols, start, end, trainDays, testDays, candidates, metric?, interval?, capital?, costs?, source?})`:
   - camelCase maps to snake_case (`trainDays`→`train_days`, `testDays`→`test_days`).
   - Unknown fields are rejected.
   - It returns `{ok, metric, folds: [{train, test, chosen, trainScore, testMetrics}], oosEquity (≤100 points, first and last kept), summary, warnings, error}`.
   - Audit it exactly like `backtest.run` (codeLength + codeSha256, never the code body). It never touches risk or the broker.
   - Without a configured client it throws "backtest service not configured".
3. API_DOCS entry for `backtest.walkForward`, with a short doc:
   - parameters are tuned on train windows only and frozen for the out-of-sample test windows;
   - trainDays ≥ 20 and testDays ≥ 5 are calendar days;
   - 1–10 candidate param dicts;
   - at most 60 runs in total;
   - a 10-minute server budget;
   - metric is one of sharpe, total_return, calmar.

   `searchApi("walk")` and `searchApi("walkforward")` must return it.
4. The read-only scope (P8.5) keeps the `backtest` namespace, so walkForward must work with a read-only token. Add one test.

## Acceptance criteria
- Request body keys are exactly the bt-service fields. There is no timeout or apikey, and caller-supplied `timeout`/`apikey` are rejected.
- Error mapping and token redaction match `run()`, including the redact-before-truncate rule.
- Downsampling: 100 points and 101 points keep the first and last points.
- The audit has no code body; validation rejections are audited too.
- `test/sdk.edge.test.ts` pins the exact binding surface (16 functions). That test is the Opus test writer's file: do NOT edit it. Note in your report that it must be updated to 17, and the orchestrator will handle that.
- All other existing tests stay green.

## Verify (must pass before you report, except the pinned surface test noted above)
```
cd trade-mcp && npm install && npx vitest run test/walkforward.test.ts && npx vitest run && npx tsc --noEmit && npm run build
```

YAGNI: no polling, no streaming, no new dependencies.
