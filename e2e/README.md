# e2e smoke test

Runs the real processes together, with no Docker, broker or network:

fake OpenAlgo (`fake_openalgo.mjs`) -> trade-mcp (paper mode, real HTTP server) -> bt-service (real uvicorn), driven by an MCP client calling `search` and `execute`.

Then fake Delta (`fake_delta.mjs`) -> paper-bot (real uvicorn, `EXECUTION=sim`), checked over its HTTP API (steps 19-23).

```
node e2e/smoke.mjs
```

Prerequisites (installed once): `npm ci` and `npm run build` in `trade-mcp/` and `agent-runner/` (the last two steps run their built `dist/`), `uv sync` in `bt-service/`, Node >= 22, `uv` on PATH (also used to run paper-bot; run `uv sync --frozen` in `paper-bot/` once, with Python 3.12 as CI does, e.g. `UV_PYTHON=3.12`). If `uv` is missing, steps 19-23 print `SKIP: uv not found` instead of failing (steps 6+ already need uv for bt-service, so this only matters if bt-service is not used).

The script picks free ports, builds trade-mcp (`tsc`), uses temp dirs for runs, data, risk config and the local data config (serving `bt-service/tests/fixtures/aapl.csv` and `nifty_opt_1d.csv`), prints PASS/FAIL per step, kills all children (`taskkill /T /F` on Windows) and exits non-zero on any failure. Each step has a 120 s timeout.

trade-mcp (and only trade-mcp) runs under `--require e2e/clock_shift.cjs`, which shifts `Date.now()`/`new Date()` to a fixed Wednesday 11:00 IST. Steps 4-5 place orders and the risk engine refuses them outside NSE hours, so without the shift smoke fails at night and on weekends. The shift is a test-only preload; production code has no clock option.

Steps: tools/list; search; account.funds; in-limit paper order (1 placeorder recorded); over-limit order (risk denied, no new placeorder); SMA backtest; read-only token has no `trade`; audit log exists and holds no secrets; walk-forward (2 candidates, full token); OAuth disabled (metadata 404, `/mcp` without token 401 with no `resource_metadata`); walk-forward with the read-only token; `GET /readyz` (200, openalgo ok); `risk:lint` on `deploy/risk.example.json` (exit 0); `agent-runner --check` (exit 0 with a fake token, exit 1 with "missing" when unset, fake value never printed); `backtest.run` on the india_options symbol `NIFTY25NOV24000CE@NFO` (local fixture, ok, tradeCount >= 1, an `expiry` trade); `audit.recent({limit:5})` (returns `{entries, skipped}`, holds the earlier backtest, no token value anywhere in the JSON). Trade-mcp runs with `EXECUTE_MAX_CONCURRENT=2`; step 17 fires 5 concurrent ~1 s executes (exactly 2 succeed, 3 get the exact `busy: too many concurrent executes, retry shortly`, a follow-up succeeds); step 18 exhausts the sandbox memory with string arrays (`memory limit exceeded`), then checks the next `return 1+1` gives 2 and `/healthz` answers. Steps 1-16 run serially, so the cap of 2 is inert for them. Step 17's executes loop on `account.funds()` (an HTTP round-trip to the fake OpenAlgo) so the host event loop runs and the executes truly overlap; a pure promise spin would be drained synchronously and not overlap.

## paper-bot against a fake Delta API (steps 19-23)

`fake_delta.mjs <port> [periodSec]` serves `GET /v2/history/candles?symbol&resolution&start&end` in the real Delta India shape (recorded in `coord/reports/PB-1.md`, parsed by `paper-bot/paper_bot/data.py`): `{"success":true,"result":[{time,open,high,low,close,volume}, ...]}`, newest first, `time` = candle open time. It answers 400 `bad_schema` if a param is missing or malformed. It scripts a crossover by counting candles requests: request 1 returns a series where fast SMA(2) is already below slow SMA(5) (no cross, hold); request 2 onwards adds one new closed candle at 120, so the latest closed candle makes fast cross above slow. Closed-candle timestamps are anchored to the server start time (one period apart between request 1 and 2, all `time + period <= now`). A forming candle with close 1000 is always included first; paper-bot must drop it (a bot that kept it would cross on tick 1 and step 19 would fail).

paper-bot is started as `uv run --directory paper-bot python -c ...` (so the smoke can bind a free port; `paper_bot.main` always uses port 8090) with `DELTA_BASE_URL` at the fake, `INTERVAL_SEC=2`, `RESOLUTION=1m`, `SYMBOLS=BTCUSD`, `FAST=2`, `SLOW=5`, `EXECUTION=sim`, and a temp `DATA_DIR` (removed on exit with the process group).

Steps: 19 decision rows appear (first is a "no cross" hold on close 90, so the forming candle was ignored); 20 exactly one open trade (buy, BTCUSD) plus a single `open` decision "crossed above" and a long position; 21 `/api/summary` equity equals capital - fee (notional x taker fee = 0.5) - slippage cost (0.2), below capital - fee; 22 `/api/trades.csv` is 200, `text/csv`, has a header row and the one trade; 23 `/` is 200 HTML with the `paper-bot` title, `PAPER` tag and `BTCUSD`.
