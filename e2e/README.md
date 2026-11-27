# e2e smoke test

Runs the real processes together, with no Docker, broker or network:

fake OpenAlgo (`fake_openalgo.mjs`) -> trade-mcp (paper mode, real HTTP server) -> bt-service (real uvicorn), driven by an MCP client calling `search` and `execute`.

```
node e2e/smoke.mjs
```

Prerequisites (installed once): `npm ci` in `trade-mcp/`, `uv sync` in `bt-service/`, Node >= 22, `uv` on PATH.

The script picks free ports, builds trade-mcp (`tsc`), uses temp dirs for runs, data, risk config and the local data config (serving `bt-service/tests/fixtures/aapl.csv`), prints PASS/FAIL per step, kills all children (`taskkill /T /F` on Windows) and exits non-zero on any failure. Each step has a 120 s timeout.

Steps: tools/list; search; account.funds; in-limit paper order (1 placeorder recorded); over-limit order (risk denied, no new placeorder); SMA backtest; read-only token has no `trade`; audit log exists and holds no secrets.
