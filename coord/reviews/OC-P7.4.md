# OC-P7.4 review

## Code review (Sonnet)

Verdict: approve (no blocking findings).

Checks passed:
- Body keys match WalkForwardRequest (app.py:61-75, extra=forbid): code, symbols, start, end, train_days, test_days, candidates, metric, interval, capital, costs, source. No timeout/apikey. camelCase->snake_case at bindings.ts walkForward body. Unknown fields rejected by check() (bindings.ts:29-33).
- Error mapping and redact-before-truncate are shared: run() and walkForward() both go through post() (client.ts:89+), so they are identical by construction.
- Default timeout 660000 (client.ts walkForwardTimeoutMs); the race and abort logic is unchanged and parametrised.
- oosEquity uses downsample(...,100); first and last kept (bindings.ts:92-96). Folds map train_score->trainScore, test_metrics->testMetrics.
- Audit strips code, adds codeLength/codeSha256, built before validation so rejections are audited. No risk/broker use. Readonly scope kept. API_DOCS entry present (api-docs.ts); searchApi("walk") test.
- Sharing via post() is better than copying run(); acceptable.

Findings:
1. Low, client.ts: no test asserts the default 660000 ms. Only the override (20ms) is tested. Fix: construct without the option and assert via fake timers, or expose the value.
2. Low, bindings.ts walkForward: trainDays/testDays are only checked as finite numbers. The server needs int and le=3650, so a float or 9999 gives a 422 round trip. Mapped correctly, so it is cosmetic. Fix (optional): Number.isInteger check client-side.
3. Low, bindings.ts: the `not configured` check happens after check()/str(), so bad args report as validation errors first. Fine and consistent with run().
4. Info, walkforward.test.ts: the "never touches risk" test is a real Proxy trap, though the broker `client` is `{}` (it would throw on any call). Mapping and audit tests assert exact calledWith/toEqual, so they are not tautological. The downsample test covers n=100 and 101 only; adding a large n would be nicer.
5. Info: the brief G:\uday-demos.oc1\coord\tasks\OC-P7.4.md does not exist in the worktree (it is under G:\uday-demos\coord\tasks), and I did not read it or the report coord/reports/OC-P7.4.md. AC coverage was judged from your check list only.

tools: graph 0 / graft 0 / graphify 0 / headroom 0 / grep 1 / read 0

## Edge tests (Opus)
- New: `trade-mcp/test/walkforward.edge.test.ts`, 118 tests, all pass. Updated the pinned surface in `trade-mcp/test/sdk.edge.test.ts` to 17 functions (added `backtest.walkForward`).
- Full suite: 22 files, 789 passed, 1 skipped. `tsc --noEmit` is clean (tsconfig includes test/).
- Covered: the exact body keys (required only, all 12, each optional alone, explicit undefined left out); timeout/apikey/train_days/test_days/signal_parameters/params rejected without a fetch; non-object args, missing fields, NaN/Infinity/string days, bad candidates, symbols and metric, and bad optionals; 401/503/429/413/5xx/404 mapping with no token in the message; a 422 token straddling the 500-char cut, plus redact-then-truncate to exactly 500; non-JSON, empty and broken 200 bodies; network error redaction; the default 660000 ms timeout (pending at 659999, rejects at 660001, abort only at the timeout); run() keeps its separate 180000 ms timeout; the override is honoured; oosEquity with 0/1/100 points kept as-is and 101/5000 downsampled to 100 with first and last kept; folds mapped snake to camel with defaults for missing fields, and train_score 0 preserved; ok:false "time budget exceeded" passed through and audited ok:false; audit codeLength and sha256 on unicode code, no code body on success, validation or error paths, no token; non-object args audited with a placeholder; readonly scope has walkForward and no trade; kill switch on (paper and live) never touches the risk engine, broker or run(); concurrent calls stay independent, including one failing; searchApi("walk"/"walkforward"/"out-of-sample"/"WalkForward") works, including in readonly.
- What the client lets through (bt-service validates these): trainDays/testDays that are non-integer, 0, negative, huge, or below the minimum (19 and 4); candidates of length 0, 11 or 100. The client has no range or count checks. That is consistent with the AC but differs from the doc ("1-10 candidates"). Not a bug if bt-service rejects these with 422.

## Test run (Haiku)

| command | result | time |
|---|---|---|
| npm install | PASS (exit 0; npm warn about pending esbuild postinstall script, not a failure) | 2s |
| npx vitest run | PASS: 22/22 files, 789 passed, 1 skipped | 11s |
| npx tsc --noEmit | PASS (no type errors) | 2s |
| npm run build | PASS (exit 0) | 1s |

Overall: GREEN. Full log: G:\uday-demos\reports\OC-P7.4.md

## Verdict (Opus)
merged f51d06d into main (trade-mcp 789 green).
