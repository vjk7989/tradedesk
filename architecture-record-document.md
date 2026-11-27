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
