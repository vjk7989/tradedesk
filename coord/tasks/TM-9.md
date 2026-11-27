# TM-9 · e2e · extend the smoke test with walk-forward and OAuth-off checks
Branch: tm/TM-9        Base: main (latest)        Owner: TM1

## Files you may touch
- `e2e/smoke.mjs`
- `e2e/fake_openalgo.mjs`: only if a new fake endpoint is needed.
- `e2e/README.md`

## Context
- `e2e/smoke.mjs`: the `step(name, fn)` helper at around line 71, the existing 8 steps, and `ALL PASS` at around line 218.
- `trade-mcp/src/sdk/api-docs.ts`: the `backtest.walkForward` signature. Read it; don't edit it.
- `trade-mcp/src/http.ts`: OAuth routes return 404 when OAuth is disabled.

## What to build
Add these steps, keeping all existing ones:
- **Step 9:** `execute` runs `await backtest.walkForward({...})` on the same fixture symbol with `trainDays: 30`, `testDays: 10` and 2 candidates `[{fast:5,slow:20},{fast:10,slow:30}]` (use whatever params the existing SMA SignalEngine in step 6 reads). Expect `ok:true`, `folds.length >= 1` and `oosEquity.length >= 1`. Pick start and end dates that fit the fixture.
- **Step 10:** with OAuth disabled (the default), `GET /.well-known/oauth-authorization-server` returns 404, and `POST /mcp` with no token returns 401 with no `resource_metadata` in `WWW-Authenticate`.
- **Step 11:** with the read-only token, `backtest.walkForward` is still callable. Make one call with 1 candidate and expect `ok:true`.

## Acceptance criteria
- `node e2e/smoke.mjs` prints PASS for steps 1 through 11 and `ALL PASS`, and exits 0.
- A second run immediately after also passes, so cleanup works.
- Total runtime under 3 minutes.
- No secrets are printed.

## Verify
```
cd trade-mcp && npm ci && cd ../bt-service && uv sync && cd .. && node e2e/smoke.mjs && node e2e/smoke.mjs
```
