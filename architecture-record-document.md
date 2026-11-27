# Architecture record (append-only)

## ADR-1: Fincept is the desktop cockpit; the trading core runs on the VPS  (2026-11-27, status: accepted)
Context: The user asked to start from Fincept. The audit shows Fincept is desktop-only (Qt, no headless mode, MCP loopback-only, stdio-only MCP client, no order tool).
Decision: Fincept runs on the user's PC from the release installer. OpenAlgo, trade-mcp and bt-service run on the VPS. Fincept connects to trade-mcp through `mcp-remote`. A Fincept source build (OpenAlgoBroker adapter) is optional, in P6.2.
Consequences: No C++ build is needed to get trading. Fincept's native broker screens are not wired to OpenAlgo until P6.2.

## ADR-2: OpenAlgo runs unmodified as the execution core  (2026-11-27, status: accepted)
Context: It has 39 Indian broker plugins plus Delta Exchange crypto, an analyzer (paper) mode and semi_auto approval. It is AGPL. It has no notional/loss limits.
Decision: Use the upstream OpenAlgo container with no code changes. Only trade-mcp holds its API key. Risk limits live in trade-mcp.
Consequences: AGPL duties stay small for personal use, and upgrades are a version bump. The analyzer toggle must never be exposed by our SDK.

## ADR-3: Code Mode on a self-hosted QuickJS (WASM) sandbox  (2026-11-27, status: accepted)
Context: Cloudflare `@cloudflare/codemode` needs the Workers-only Worker Loader binding and is experimental. The user hosts on a VPS.
Decision: Copy the pattern. The MCP server has two tools (`search`, `execute`). Model code runs in `quickjs-emscripten` 0.32.0 (asyncify) with no network/fs/process. SDK calls are host functions on the supervisor, which holds the keys, risk engine and audit log.
Consequences: Runs on Node anywhere, including Windows dev. QuickJS is slower than V8, which is fine for orchestration. Heavy compute goes to bt-service.

## ADR-4: Backtest engine extracted from Vibe-Trading (MIT) into bt-service  (2026-11-27, status: accepted)
Context: Vibe has mature India-equity and crypto engines, a file-based entry and light `src.*` coupling. OpenAlgo/Fincept have no strategy-backtest API we can call remotely.
Decision: Copy `agent/backtest` plus minimal shims into `bt-service/vibe_bt`, keep MIT NOTICE, and wrap it in `run_backtest(code, …)` with an AST check, subprocess and timeout, behind FastAPI. Strategy contract = Vibe `SignalEngine.generate(data_map)`.
Consequences: Fallback if extraction balloons (>2 days): run Vibe's own MCP/API as a sidecar.

## ADR-5: Risk limits enforced only server-side; live mode is operator config  (2026-11-27, status: accepted)
Decision: `mode` (paper|live), the kill switch and all limits come from server config files/env. The sandbox SDK can read them (`risk.status()`) but never change them. Default mode is paper.
Consequences: A prompt-injected or buggy script cannot go live or lift limits. Optional human approval uses OpenAlgo `semi_auto`.

## ADR-6: bt-service adds PyYAML  (2026-11-27, status: accepted)
Context: Vibe's `local` loader (offline CSV source used for tests and cached data) reads a YAML config. Without PyYAML it silently fails to register.
Decision: Add `pyyaml` to bt-service dependencies (amends the P2.1 dependency list).
Consequences: One small pure dependency. The local loader works offline.

## ADR-7: Two ways to drive the AI: your CLI (subscription) or API keys  (2026-11-27, status: accepted)
Context: The user wants it to work both with LLM API keys and by connecting directly from their own CLIs (Claude Code, Codex, Gemini CLI, etc.) logged in with their own accounts.
Decision:
(a) CLI → MCP (primary): every CLI connects to trade-mcp as an MCP client over HTTPS + token (or stdio locally). The AI runs inside the user's CLI on its own login, and the server needs no LLM key.
(b) Server-side agent runner (P8): a `agent-runner` module with one interface and two backends. `api` (Anthropic/OpenAI/Gemini SDK keys) and `cli` (spawn `claude -p --output-format stream-json`, `codex exec --json`, `gemini -p` headless, with trade-mcp attached via each CLI's MCP config). Used for scheduled research, alerts and strategy reviews. Design reference: Fincept `src/services/harness/adapters/*` and Vibe `agent/src/providers/claude_cli.py`.
Consequences: Using a subscription-logged-in CLI is for the user's own personal automation only. Vendor terms forbid offering it to others, which is why Fincept limits it. Each CLI must be installed and logged in on the host where the runner runs (VPS: one-time `claude auth login` / `codex login` / `gemini` login over SSH).

## ADR-8: Host-side parse of sandbox code with acorn  (2026-11-27, status: accepted)
Context: The edge tests showed that QuickJS's AsyncFunction constructor concatenates source, so code like `}); x(); (async()=>{` escapes the function-body wrapper.
Decision: Parse the code on the host with `acorn` as a standalone script (return/await allowed outside functions) before wrapping it. Reject on parse failure.
Consequences: One small pure-JS dependency. Code that parses on its own cannot close the wrapper.

## ADR-9: Order path is reserve-then-place and fails closed on audit  (2026-11-27, status: accepted)
Context: The edge tests showed that concurrent `trade.place` calls bypassed the per-run and daily caps, that a broker `status:error` counted as an order, and that orders were placed when the audit log was unwritable.
Decision: `RiskEngine.reserve()` checks and reserves count and notional synchronously in one tick; `release()` on failure; `commit()` on success. A non-success broker reply is an error. Before placing, a synchronous writability probe of the audit file runs; if it fails, the order is refused. One result line per call (no separate attempt line).
Consequences: Caps hold under concurrency. A crash between the broker call and the result write leaves no audit line. Accepted for now; OpenAlgo's own order book is the secondary record.

## ADR-10: Crypto notional uses a per-symbol contract value from risk config  (2026-11-27, status: accepted)
Context: Delta Exchange derivatives are sized in contracts; each contract is `contract_value` units of the underlying (e.g. 0.01 ETH). OpenAlgo's API-key REST does not expose contract_value, so qty × price misstates notional.
Decision: Add risk config `contractValues` {SYMBOL: value}. CRYPTO notional = qty × (contractValues[SYMBOL] ?? 1) × price. A missing entry means 1, which overstates notional for Delta's sub-unit contracts and so errs on the safe side.
Consequences: The user lists contract values for traded symbols to get accurate USD caps. Revisit if OpenAlgo exposes contract_value.

## ADR-11: Team shape: 2 Sonnet developers plus OpenCode developers via Markdown coordination  (2026-11-27, status: accepted)
Context: The user wants Opus as orchestrator, two Sonnet developers, an Opus test writer, a Haiku test runner, and extra developer agents running in OpenCode, coordinated through Markdown files. Only the orchestrator merges or pushes.
Decision: Claude developers are capped at 2 (D1, D2). D3 retires after P3.2. OpenCode developers (OC1, OC2) take tasks from `coord/board.md` + `coord/tasks/<ID>.md`, work on `oc/<ID>` branches, and report in `coord/reports/<ID>.md`. Every OpenCode task gets a Sonnet code review, Opus edge-case tests and a Haiku test run (`coord/reviews/<ID>.md`) before the orchestrator merges. The paste-ready prompt is `coord/OPENCODE_PROMPT.md`.
Consequences: Same quality gates for both tool chains. The orchestrator is the single writer of board/todo/ADR/hand-off and the only one who pushes `main`.

## ADR-12: Code graph indexed for discovery  (2026-11-27, status: accepted)
Decision: The repo is indexed in codebase-memory-mcp as project `tradedesk` (vendor/, deploy/, docs/ excluded). Briefs name the first lookup tool (search_graph / get_code_snippet), then exact file:line. Re-index after each batch of merges.

## ADR-13: Intraday semantics for Indian markets  (2026-11-27, status: accepted)
Context: P7.2 added intraday backtests for india_equity, india_fno and crypto.
Decision:
- Sessions are NSE/BSE/NFO/BFO 09:15–15:30 IST and MCX 09:00–23:30 IST. Bars outside the session cannot trade.
- Products: equity CNC (default, T+1, no shorts) or MIS (shorts allowed, same-day exits, no new entries from 15:20, forced square-off at the day's last bar ≤ 15:20; MCX at 23:20). F&O NRML (default, held overnight) or MIS. `product_by_market` overrides the run-level `product`. Unknown values are an error.
- Bars are interpreted as IST wall clock for India. Loaders convert timezone-aware input to IST (India) or UTC (others).
- Crypto funding settles at every 8h UTC slot between bars, deduplicated, and never before entry.
Consequences: Rates (MIS STT, F&O charges, lot sizes) are config-overridable and flagged "verify current". MIS stamp duty is 0.003% buy-side via in_mis_stamp_duty (TM-1).

## ADR-14: OpenCode developers retired  (2026-11-27, status: accepted; amends ADR-11)
Decision: At the user's request, no further tasks go to OpenCode. Two OpenCode tasks were delivered, reviewed through the Claude chain and merged (OC-P7.3, OC-P7.4). OC-P5.2 was withdrawn and done by a Claude developer. The `coord/` protocol stays in the repo for future use.

## ADR-15: Teammate (TM1) works through pull requests with split responsibilities  (2026-11-27, status: accepted)
Context: A teammate on another machine uses Claude Code.
Decision: On TM1's machine, Opus orchestrates and Sonnet subagents implement. TM1 opens PRs from `tm/<ID>`. On the owner's machine, Sonnet reviews the PR, Opus writes edge-case tests, Haiku runs the gates, and the Opus orchestrator merges via `gh pr merge`. Only the owner's orchestrator merges.
Consequences: The same quality gates apply to every contributor. `coord/` plus PR comments carry all communication.
