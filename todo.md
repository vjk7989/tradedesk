# TODO — TradeDesk

Markers at the end of each line: `[ ]` pending · `[.]` ongoing (note) · `[x]` done.
Developers: 3 (resources.py). D1 = trade-mcp core/server · D2 = trade-mcp client/risk/SDK · D3 = bt-service.
Detailed plan: `plan.md`.

## P0 Workspace
- P0.1 · root · git init, .gitignore (vendor/, node_modules, .venv, .env, runtime data), commit plan/docs (a0ac36f) [x]
  verify: `git status --short` clean after commit; `git check-ignore vendor`

## P1 trade-mcp (Node/TS, Code Mode MCP server)
- P1.1 · trade-mcp · scaffold (package.json, tsconfig, vitest) + `src/config.ts` (env + risk config, zod) (3ea27e2) [x]
  files: trade-mcp/package.json, tsconfig.json, vitest.config.ts, src/config.ts, test/config.test.ts   size: S   dev: D1
  AC: loadConfig(env) needs OPENALGO_URL, OPENALGO_API_KEY, MCP_TOKEN (throws, naming the missing key); mode defaults to "paper"; risk limits from RISK_CONFIG json file path or defaults; negative/zero limits rejected; secrets never in error text
  verify: `cd trade-mcp && npm test && npx tsc --noEmit`   deps: P0.1
- P1.2 · trade-mcp · typed OpenAlgo REST client `src/openalgo/client.ts` (b91a7e0) [x]
  files: src/openalgo/client.ts, src/openalgo/types.ts, test/openalgo.test.ts   size: M   dev: D2
  AC: POST {base}/api/v1/<ep> with apikey injected in body; methods quotes, depth, history, search, optionChain, funds, positions, holdings, orders, trades, pnl, analyzerStatus, placeOrder, modifyOrder, cancelOrder, closePosition; `status:"error"` and HTTP errors → OpenAlgoError(message, endpoint) with apikey redacted; timeout; NO analyzer toggle method
  verify: `npm test -- openalgo && npx tsc --noEmit`   deps: P1.1
- P1.3 · trade-mcp · risk engine + audit log + kill switch `src/risk/*` (0bff950) [x]
  files: src/risk/engine.ts, src/risk/hours.ts, src/risk/audit.ts, test/risk.test.ts   size: M   dev: D2
  AC: checkOrder → {allow, reasons[]}: kill switch, exchange/product allowlist, symbol allow/deny, max qty, max notional, daily order count, daily notional, daily loss limit, per-run order cap, market hours (IST NSE/BSE/NFO 09:15–15:30 Mon–Fri, MCX 09:00–23:30, CRYPTO 24×7); daily counters reset at IST midnight and persist to a JSON file; audit JSONL line per decision with no API key
  verify: `npm test -- risk && npx tsc --noEmit`   deps: P1.1
- P1.4 · trade-mcp · QuickJS sandbox executor `src/sandbox/quickjs.ts` (4123477) [x]
  files: src/sandbox/quickjs.ts, test/sandbox.test.ts, package.json   size: M   dev: D1
  AC: runCode(code, bindings, {timeoutMs, memoryBytes, maxLogBytes}) → {ok, result, logs, error}; supports top-level await and async host bindings (`ns.fn(args)` → Promise); JSON-only args/results; no fetch/require/process/import; infinite loop stopped at timeout; memory cap enforced; logs truncated; host errors surface as JS exceptions; each run gets a fresh context
  verify: `npm test -- sandbox && npx tsc --noEmit`   deps: P1.1
- P1.5 · trade-mcp · SDK bindings + `search` docs `src/sdk/*` (4f4c717) [x]
  files: src/sdk/bindings.ts, src/sdk/api-docs.ts, src/sdk/search.ts, test/sdk.test.ts   size: M   dev: D2
  AC: bindings market/account/trade/risk (backtest added in P2.5); every trade.* call goes risk check → client → audit; paper mode forces OpenAlgo analyzer status check (refuse if analyzer off while mode=paper); search(query) returns matching TS declaration blocks, empty query → index of namespaces
  verify: `npm test -- sdk && npx tsc --noEmit`   deps: P1.2, P1.3, P1.4
- P1.6 · trade-mcp · MCP server (tools `search`, `execute`), stdio + Streamable HTTP with bearer auth (4a5723b) [x]
  files: src/server.ts, src/http.ts, src/index.ts, test/server.test.ts   size: M   dev: D1
  AC: exactly two tools with clear descriptions; HTTP POST /mcp requires `Authorization: Bearer <MCP_TOKEN>` (constant-time compare, 401 otherwise); GET /healthz; stdio mode via `--stdio`; execute returns logs + result + risk notices; tool output wrapped as untrusted data
  verify: `npm test -- server && npx tsc --noEmit && npm run build`   deps: P1.5

## P2 bt-service (Python, Vibe-Trading engine)
- P2.1 · bt-service · extract Vibe `agent/backtest` + minimal `src.*` shims into `bt-service/vibe_bt/` (MIT notice kept) (bfb773a) [x]
  files: bt-service/pyproject.toml, bt-service/vibe_bt/** (copied), bt-service/vibe_bt/NOTICE   size: L   dev: D3
  AC: `uv run python -c "import vibe_bt.backtest.runner"` works with deps limited to pandas, numpy, scipy, pydantic, yfinance, ccxt, fastapi, uvicorn, httpx; no LLM/agent modules copied
  verify: `cd bt-service && uv sync && uv run python -c "import vibe_bt.backtest.runner"`   deps: P0.1
- P2.2 · bt-service · `run_backtest(code, symbols, start, end, interval, capital, costs, source)` wrapper with AST check, subprocess isolation, timeout (2284df9) [x]
  files: bt-service/bt_service/runner.py, bt-service/tests/test_runner.py, tests/fixtures/*   size: M   dev: D3
  AC: returns {metrics, equity, trades, warnings}; forbidden imports rejected before run; job killed at timeout; offline test with `local` source fixture CSV (one .NS stock, one crypto pair)
  verify: `uv run pytest -q`   deps: P2.1
- P2.3 · bt-service · `openalgo` data loader (history via /api/v1/history) registered in the india fallback chain (8fdd371) [x]
  files: bt-service/vibe_bt/backtest/loaders/openalgo_loader.py, registry.py, tests/test_openalgo_loader.py   size: S   dev: D3
  AC: maps `RELIANCE.NS`→(RELIANCE, NSE), `.BO`→BSE, NFO/MCX/CRYPTO passthrough; intervals mapped; HTTP mocked in tests; missing env → loader skipped, chain falls back to yfinance
  verify: `uv run pytest -q`   deps: P2.1
- P2.4 · bt-service · FastAPI `POST /backtest`, `GET /healthz`, bearer token (8fdd371) [x]
  files: bt-service/bt_service/app.py, tests/test_app.py   size: S   dev: D3
  AC: 401 without token; 422 on bad body; runs P2.2 wrapper; job concurrency limit 1–2
  verify: `uv run pytest -q`   deps: P2.2
- P2.5 · trade-mcp · `backtest.run` binding + bt-service client (0e3fc1b) [x]
  files: src/backtest/client.ts, src/sdk/bindings.ts, src/sdk/api-docs.ts, test/backtest.test.ts   size: S   dev: D2
  AC: forwards to BT_URL with token; summary returned (metrics + trimmed equity/trades); timeout error is clear
  verify: `npm test && npx tsc --noEmit`   deps: P1.5, P2.4

## P3 Crypto
- P3.1 · trade-mcp · Delta Exchange via OpenAlgo: CRYPTO exchange in risk config (USD notional), symbol docs in `search` (97402ae) [x]
- P3.2 · bt-service · crypto backtest path verified (binance/okx loaders, funding, fees) with offline fixtures (78d038d) [x]
- P3.3 · trade-mcp · (optional) ccxt spot trading binding (deferred: not needed, YAGNI — Delta via OpenAlgo covers crypto trading) [x]

## P4 Deploy (VPS)
- P4.1 · deploy · docker-compose (openalgo, trade-mcp, bt-service, caddy), Dockerfiles, `.env.example` (b1f5d45) [x]
- P4.2 · deploy · VPS runbook (Ubuntu, firewall, static IP registration, daily broker login, backups) (9f94230; verify after P1.6) [x]
- P4.3 · docs · client setup: Claude Code, Codex CLI, Claude Desktop, ChatGPT (dev mode), Fincept via mcp-remote (9f94230; verify after P1.6) [x]
- P4.4 · deploy · paper-mode end-to-end run on the VPS (release gate before live) [ ]

## P5 Remote auth
- P5.1 · trade-mcp · OAuth 2.1 single-user (PKCE, dynamic client registration) for ChatGPT / claude.ai connectors (a71c380) [x]

## P6 Fincept
- P6.1 · Fincept · install release v4.5.3, configure Claude Code harness + our MCP via mcp-remote (guide: docs/fincept-setup.md; install is on your PC) [x]
- P6.2 · Fincept · (optional, source build) OpenAlgoBroker : IBroker + remote backtest provider (deferred: needs Qt source build, ~6 GB disk free; revisit on request) [x]

## P7 Advanced backtesting
- P7.1 · bt-service · NSE F&O engine (lot sizes, expiries/rolls, F&O STT, margin) (78d038d) [x]
- P7.2 · bt-service · intraday interval support (fixing f1: composite MIS squareoff, sparse funding, product validation) [.]
- P7.3 · bt-service · walk-forward / out-of-sample endpoint [ ]

## P8 AI drivers (ADR-7)
- P8.1 · docs · connect guides: Claude Code (`claude mcp add --transport http`), Codex (`~/.codex/config.toml` mcp_servers), Gemini CLI (`settings.json` mcpServers), local stdio mode (9f94230; verify after P1.6) [x]
- P8.2 · agent-runner · interface + `cli` backend (claude -p / codex exec / gemini -p headless, stream parse, timeout, trade-mcp attached) (965b822) [x]
- P8.3 · agent-runner · `api` backend (Anthropic/OpenAI/Gemini keys) behind the same interface (dcbdc99; Anthropic only) [x]
- P8.4 · agent-runner · scheduled jobs (pre-market brief, EOD review, strategy backtest refresh) (357fb45) [x]
- P8.5 · trade-mcp · read-only MCP token scope (MCP_TOKEN_READONLY → trade.* bindings absent) for scheduled jobs (fa9f210) [x]
- P5.2 · deploy · Caddy routes for OAuth paths + OAUTH_* env in compose/.env.example + runbook note (trade-mcp port never published) [ ]
- P8.6 · docs+trade-mcp · document MCP_TOKEN_READONLY for jobs (connect-clients, agent-runner README), F&O lot_sizes/margin_pct + crypto costs in backtest API docs (3c5ef41) [x]
- P7.2b · bt-service · add 3m and 10m intervals (_VALID_INTERVALS, _INTERVAL_SECONDS, _normalize_interval, _BARS_PER_DAY) — OpenAlgo supports them (D1 building) [.]
