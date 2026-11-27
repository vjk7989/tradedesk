# TradeDesk — plan and gap audit

Date: 2026-11-27 · Owner: you (personal use, self-hosted on your VPS/cloud)
Sources audited (shallow clones in `vendor/`): FinceptTerminal `914134d` (AGPL-3.0), OpenAlgo `f83592a` (AGPL-3.0), Vibe-Trading `e0f285f` (MIT).

## 1. Goal

One personal trading stack where:
1. **Claude, Codex, ChatGPT or any MCP client can research, backtest and trade** Indian equities/F&O (via OpenAlgo) and crypto (Delta Exchange via OpenAlgo; ccxt exchanges for data) through **one MCP server**.
2. The MCP server uses **Code Mode** (Cloudflare pattern): the model gets 2 tools, `search` and `execute`, and writes TypeScript/JS against a typed SDK that runs in a sandbox. Keys and risk rules stay outside the sandbox.
3. **Backtesting** of strategies the AI writes, for Indian markets and crypto, reusing Vibe-Trading's engine.
4. **Fincept Terminal** is the desktop cockpit (charts, analytics, research, its own AI chat), connected to the same stack.
5. Hard, server-side **risk limits** that no prompt can switch off.

## 2. What each repo really gives us (gap audit)

### 2.1 Fincept Terminal: desktop cockpit only
| Need | Status in Fincept | Gap / action |
|---|---|---|
| Run on a VPS | Desktop-only Qt app; the Dockerfile only packages the GUI for X11 | **Gap.** It stays on your PC as the viewer. The VPS runs the trading core. |
| Claude Code as the agent | Built-in harness (`src/services/harness/adapters/ClaudeAdapter.cpp`); API-key login only for terminal AI | Works as is. Use an `ANTHROPIC_API_KEY`. |
| Connect to our remote MCP | `McpClient` is **stdio only** (`src/mcp/McpClient.cpp:1`) | **Gap.** Use the `mcp-remote` stdio→HTTP shim as the server command. No C++ change. |
| Fincept's own MCP server | Streamable HTTP on loopback, bearer token, 11 GUI-driving tools; **no order tool**; orders need a human approval dialog | Fine for "AI drives the terminal". Not our trade path. |
| OpenAlgo broker | None; 17 Indian brokers built in natively; `IBroker` interface (`src/trading/BrokerInterface.h:162`), hardcoded registry (`BrokerRegistry.cpp:156`) | **Optional gap.** Write `OpenAlgoBroker : IBroker` → needs a source build (Qt 6.8.3, MSVC). Deferred (P6). |
| Crypto trading | Hyperliquid native; ccxt for data (trading via ccxt unverified) | Not needed: crypto orders go through our MCP. |
| Backtesting | 5 Python providers (backtesting.py, bt, vectorbt, zipline, fincept) behind `BacktestingProviderBase` | Usable in Fincept today. A provider calling our backtest service needs `all_providers()` in C++ → source build (P6). |
| Install | Releases v4.5.3 (Windows setup.exe) | Install the release; do not compile now. **Drive G: has 6 GB free.** |

### 2.2 OpenAlgo: execution core (run unmodified)
| Need | Status | Gap / action |
|---|---|---|
| Indian brokers | 39 plugins, one REST API `/api/v1/*` (POST, `apikey` in body) | Use as is. |
| Crypto | **Delta Exchange only** (futures/options, WebSocket); no spot; Delta needs a registered static IP | Use Delta through OpenAlgo. Spot/other venues = ccxt later (P3b). |
| Paper mode | Analyzer/sandbox (₹1 Cr virtual), `/api/v1/analyzer/toggle` | **Risk:** the toggle is reachable with the API key → our SDK never exposes it; mode is operator config. |
| Human approval | Per-key `semi_auto` mode → orders wait in Action Center; set only from the UI session | **Reuse as our approval step** (no code). |
| Its own MCP | ~60 one-tool-per-call tools, OAuth over HTTP, read-only flag, audit log | Not Code Mode, and the analyzer toggle is exposed. Use only as a reference for safety patterns. |
| Risk limits | Rate limits only. **No** notional/qty caps, symbol allowlist, daily-loss cap or kill switch | **Gap → our risk engine.** |
| Strategy backtest API | Portfolio + SIP backtesters only | **Gap → our backtest service.** |
| OpenAPI spec | None served (`doc=False`) | **Gap → hand-typed SDK** for the endpoints we use. |
| Daily broker login | Manual (TOTP/OAuth) each day; SEBI rules | **Operational gap**: log in each morning; the gateway reports "broker session expired" clearly. |
| Deploy | docker-compose (5000 HTTP, 8765 WS), install scripts with nginx/certbot | Use docker-compose. |

### 2.3 Vibe-Trading: backtest engine (MIT, we copy code)
| Need | Status | Gap / action |
|---|---|---|
| Engine | `agent/backtest/` engines incl. `india_equity.py` (T+1, STT/charges, circuit band) and `crypto.py` (maker/taker, funding, liquidation) | Copy `agent/backtest/` + small `src.*` shims. Keep MIT NOTICE. |
| Strategy format | `SignalEngine.generate(data_map) -> {symbol: Series in [-1,1]}`; next-bar-open fills | Adopt as our strategy contract. |
| Entry point | File-based `runner.main(run_dir)` | **Gap → wrapper** `run_backtest(code, symbols, start, end, interval, capital, costs)`. |
| Safety | AST check of strategy source | Reuse, plus subprocess isolation and timeout (missing). |
| India data | yfinance `.NS/.BO`; broker loader limited | **Gap → `openalgo_loader`** using `/api/v1/history`. |
| Crypto data | okx, binance, ccxt loaders | Use as is. |
| F&O | No NSE F&O engine (lots, expiries, margins) | **Gap → P7** (NSE F&O engine on the `global_futures.py` template). |
| Walk-forward / OOS | `src/research_lab/studies.py` | Reuse in P7 if the shims allow. |
| Intraday | `daily` engine is daily-only | **Gap**: intraday backtests in P7. |

### 2.4 Code Mode (Cloudflare)
`@cloudflare/codemode` (experimental) runs code in V8 isolates through the **Workers-only** Worker Loader binding. **It does not run on a plain VPS.** We copy the *pattern*:
- Tools: `search(query)` returns the matching TypeScript declarations of the SDK. `execute(code)` runs JS in a sandbox and returns the `console.log` output and the return value.
- Sandbox: **QuickJS compiled to WASM** (`quickjs-emscripten` 0.32.0). No `fetch`, file system or process access by construction. Memory and time limits.
- Bindings: SDK calls inside the sandbox are host functions. The supervisor holds the keys, applies the risk engine, and writes the audit log.

## 3. Architecture

```
 Your PC                                    VPS (docker compose, static IP registered with broker/Delta)
 ┌───────────────────────┐   HTTPS + token  ┌──────────────────────────────────────────────────────────┐
 │ Claude Code / Codex   │─────────────────▶│ Caddy (TLS)                                              │
 │ ChatGPT / claude.ai   │  (OAuth, P5)     │   ├─ trade-mcp  (Node/TS)  /mcp                         │
 │ Fincept Terminal      │── mcp-remote ───▶│   │    tools: search, execute                           │
 │  (desktop cockpit)    │                  │   │    QuickJS sandbox ──host calls──▶ supervisor        │
 └───────────────────────┘                  │   │    supervisor: risk engine · audit log · kill switch │
                                            │   │         ├──▶ OpenAlgo REST (:5000)  → brokers, Delta │
                                            │   │         └──▶ bt-service (:8000)    → backtests       │
                                            │   ├─ OpenAlgo UI (login, Action Center approvals)        │
                                            │   └─ bt-service (Python/FastAPI, Vibe engine extract)    │
                                            └──────────────────────────────────────────────────────────┘
```

### 3.1 SDK the model sees (inside `execute`)
```ts
market.quote({symbol, exchange})          market.history({symbol, exchange, interval, start, end})
market.depth(...) · market.optionChain(...) · market.search(query)
account.funds() · account.positions() · account.holdings() · account.orders() · account.trades()
trade.place({symbol, exchange, side, quantity, product, priceType, price?, triggerPrice?})
trade.modify(...) · trade.cancel(orderId) · trade.closePosition(...)
backtest.run({code /* Python SignalEngine */, symbols, start, end, interval, capital, costs?})
risk.status()   // limits, today's usage, mode (paper|live), kill switch
```
Not exposed, on purpose: analyzer toggle, API-key management, strategy host, kill-switch reset.

### 3.2 Risk engine (supervisor, server-side, never in the sandbox)
- `mode`: `paper` (OpenAlgo analyzer) or `live`, set **only** in the server config. Default is paper.
- Per-order caps: max quantity, max notional (₹ / USD), allowed exchanges, products, symbol allow/deny list.
- Per-day caps: order count, total notional, max realised+unrealised loss (via `/pnl`), then auto-block.
- Rate cap per `execute` call (for example ≤5 orders per run). Idempotency key per order.
- Market-hours check for NSE/BSE/MCX. Crypto is 24×7.
- Kill switch: a file or env flag. When it is on, every write call is refused.
- Approval: optional `semi_auto` on the OpenAlgo key, so a human approves in the Action Center.
- Audit: JSONL with every call, its arguments, the risk decision and the result.

### 3.3 Backtest service
`POST /backtest {code, symbols, start, end, interval, capital, costs}` → `{metrics, equity[], trades[], warnings}`.
Runs each job in a subprocess with a timeout, after the AST check. Data comes from `openalgo` (India) or `binance`/`okx`/`ccxt`/`yfinance` (crypto, fallback).

## 4. Licences and hosting (personal use on your VPS)
- **AGPL (Fincept, OpenAlgo):** personal use with no one else reaching the service has no obligation. If others ever reach it, publish your changes to those two. We run OpenAlgo **unmodified** and talk to it over HTTP. Our gateway is separate code.
- **MIT (Vibe-Trading):** copy freely and keep its LICENSE/NOTICE in `bt-service/vibe_bt/`.
- **Fincept trademark:** don't rebrand or redistribute Fincept.
- **Broker/SEBI:** API orders need the VPS static IP registered with your broker. Delta Exchange also requires a static IP. Exchange data is for your own use.

## 5. Phases

| Phase | Output | Depends |
|---|---|---|
| P0 | Workspace: git repo, `vendor/` ignored, docs | — |
| P1 | `trade-mcp`: config, OpenAlgo client, risk engine, QuickJS sandbox, SDK + `search`, MCP server (HTTP + stdio, bearer) | P0 |
| P2 | `bt-service`: Vibe engine extract, `run_backtest` wrapper + isolation, `openalgo_loader`, FastAPI, `backtest.run` in the SDK | P0 (P1.5 for the SDK binding) |
| P3 | Crypto: Delta via OpenAlgo (config + symbol docs); crypto backtests via binance/okx loaders; (P3b) ccxt spot trading | P1, P2 |
| P4 | Deploy: docker-compose (openalgo, trade-mcp, bt-service, caddy), `.env.example`, VPS runbook, client configs (Claude Code, Codex, ChatGPT, Claude Desktop) | P1, P2 |
| P5 | OAuth 2.1 single-user login for the ChatGPT and claude.ai connectors | P4 |
| P6 | Fincept: install release, connect via `mcp-remote`; optional source build with `OpenAlgoBroker` + backtest provider | P4 |
| P7 | NSE F&O + intraday backtest engine, walk-forward/OOS studies | P2 |

Detailed sub-tasks with acceptance criteria are in `todo.md`.

## 6. Testing
- Every sub-task: an Opus test writer writes edge-case tests from the diff and acceptance criteria. Haiku runs them.
- `trade-mcp`: vitest, with a **fake OpenAlgo server** (no real broker in tests).
- `bt-service`: pytest, with offline fixture data (no network in tests).
- Release gate: a full paper-mode run on the VPS (analyzer on) before `mode: live`.

## 7. Risks
- **Broker session expiry** each day → the gateway returns a clear error. You log in each morning.
- **QuickJS speed:** fine for orchestration code. Heavy maths runs in `bt-service` (Python), not the sandbox.
- **Vibe engine coupling:** the `src.*` shims may grow. If extraction exceeds ~2 days, run Vibe's own MCP server as a sidecar instead (fallback ADR).
- **Local machine limits:** 6 GB disk, about 3 GB free RAM → no local Docker build of the whole stack. Integration tests run on the VPS.
