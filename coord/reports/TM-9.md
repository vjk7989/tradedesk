# TM-9 report
Status: done (one product finding for the owner below)
Branch: tm/TM-9   Commit: 3a0de80
Files: e2e/smoke.mjs (+36/-0), e2e/README.md (+1/-1)
Verify: node e2e/smoke.mjs twice back to back → PASS 1..11 + ALL PASS both times (1m06s, 1m10s; limit 3 min)
Decisions:
- Step 6's SMA hard-codes 20/50. bt-service passes candidate params to SignalEngine as constructor kwargs, so steps 9/11 use SMA_P, a copy with `__init__(self, fast=20, slow=50)`. Step 6 is unchanged.
- Walk-forward window: 2024-01-02..2024-02-29 with trainDays 30 and testDays 10 (at least 1 fold). Over the full fixture range (~11 folds) the run exceeded the 60 s limit.
Finding for the owner (not fixed; outside this task's files): trade-mcp's `execute` sandbox timeout is 60 s (src/server.ts executeTimeoutMs default 60000), and the MCP client's default request timeout is also 60 s. `backtest.walkForward` is documented with a 10-minute server budget and a 660 s client timeout, so a realistic walk-forward through `execute` times out after 60 s while bt-service keeps working (the next call then gets "busy"). Suggest a follow-up: a longer execute timeout when backtest.* is used, or an async walk-forward job API.
developers: 1 sonnet, fix rounds: 0
