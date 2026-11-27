# e2e smoke test

Runs the real processes together, with no Docker, broker or network:

fake OpenAlgo (`fake_openalgo.mjs`) -> trade-mcp (paper mode, real HTTP server) -> bt-service (real uvicorn), driven by an MCP client calling `search` and `execute`.

```
node e2e/smoke.mjs
```

Prerequisites (installed once): `npm ci` and `npm run build` in `trade-mcp/` and `agent-runner/` (the last two steps run their built `dist/`), `uv sync` in `bt-service/`, Node >= 22, `uv` on PATH.

The script picks free ports, builds trade-mcp (`tsc`), uses temp dirs for runs, data, risk config and the local data config (serving `bt-service/tests/fixtures/aapl.csv`), prints PASS/FAIL per step, kills all children (`taskkill /T /F` on Windows) and exits non-zero on any failure. Each step has a 120 s timeout.

trade-mcp (and only trade-mcp) runs under `--require e2e/clock_shift.cjs`, which shifts `Date.now()`/`new Date()` to a fixed Wednesday 11:00 IST. Steps 4-5 place orders and the risk engine refuses them outside NSE hours, so without the shift smoke fails at night and on weekends. The shift is a test-only preload; production code has no clock option.

Steps: tools/list; search; account.funds; in-limit paper order (1 placeorder recorded); over-limit order (risk denied, no new placeorder); SMA backtest; read-only token has no `trade`; audit log exists and holds no secrets; walk-forward (2 candidates, full token); OAuth disabled (metadata 404, `/mcp` without token 401 with no `resource_metadata`); walk-forward with the read-only token; `GET /readyz` (200, openalgo ok); `risk:lint` on `deploy/risk.example.json` (exit 0); `agent-runner --check` (exit 0 with a fake token, exit 1 with "missing" when unset, fake value never printed).
