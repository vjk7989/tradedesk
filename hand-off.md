# Hand-off 2026-11-27 (build complete)
State: every buildable task is done and merged to `main` at https://github.com/vjk7989/tradedesk (public). Final gate GREEN on 2026-11-27: trade-mcp 789 (+1 skipped), agent-runner 240, bt-service 818, deploy 93, e2e smoke 8/8. Teammate TM1 (buckleson) invited; tasks TM-1 and TM-2 are on the board; flow in ADR-15.
Code graph: codebase-memory project `tradedesk`, re-indexed after the last merge (3,135 nodes).

## What exists
| Package | What | Test command |
|---|---|---|
| `trade-mcp/` | Code Mode MCP server (`search`/`execute`), QuickJS sandbox, OpenAlgo client, risk engine (reserve/commit, kill switch, audit), backtest + walkForward bindings, bearer + read-only token + single-user OAuth 2.1 | `npx vitest run && npx tsc --noEmit && npm run build` |
| `bt-service/` | Vibe-Trading engine extract; india_equity (CNC/MIS intraday), india_fno futures, crypto (fees, funding, -PERP/-SWAP); OpenAlgo loader; 1m–1D incl. 3m/10m; `/backtest` + `/walkforward` | `uv sync && uv run pytest -q` (~5 min) |
| `agent-runner/` | Runs Claude/Codex/Gemini CLIs headless or the Anthropic API (MCP connector) with trade-mcp attached; scheduled jobs (IST) | `npx vitest run && npx tsc --noEmit && npm run build` |
| `deploy/` | Compose (openalgo, trade-mcp, bt-service, caddy), Caddy routes incl. OAuth, `.env.example`, `risk.example.json` | `docker compose ... config -q && uv run --with pytest --with pyyaml pytest -q deploy/test_deploy.py` |
| `e2e/` | Local smoke test with real processes and a fake OpenAlgo | `node e2e/smoke.mjs` |
| `docs/` | VPS runbook, client connection guide, Fincept setup | — |

## Open (needs the user)
- P4.4: paper-mode end-to-end run on the VPS (runbook §§1–13), before setting `MODE=live`.
- Verify against live sources:
  - the Delta perpetual symbol format (BTCUSDFUT vs BTCUSD.P);
  - NSE lot sizes (`lot_sizes`);
  - the F&O, MIS STT and stamp rates;
  - the OpenAlgo `WEBSOCKET_URL` path;
  - the Fincept menu names.
- Fincept install on the PC (`docs/fincept-setup.md`).

## Known limits
- MIS stamp duty uses the delivery rate.
- 10m bar anchoring uses the first bar of the file.
- Funding can miss one slot when a scale-in lands on a sparse gap.
- Composite runs need `product_by_market` for mixed MIS/NRML.
- The agent-runner signal-exit path is untested.
- OAuth codes and the login rate limiter are in memory, so a restart resets them.
- trade-mcp's port must never be published.

## Deferred
- P3.3 ccxt spot trading (YAGNI).
- P6.2 Fincept source build (disk).
- OpenAI/Gemini API backends in agent-runner (CLI backends cover them).

## Team / process
- ADR-11 + ADR-14: Opus orchestrator, Sonnet developers, Opus test writer, Haiku runner. OpenCode retired; the `coord/` protocol is kept.
- Worktrees left: `G:\uday-demos.d1`, `G:\uday-demos.d2` (both merged; safe to remove).

## Gotchas
- Haiku runners need absolute `cd /g/uday-demos.<wt>/...` paths.
- Test writers own test edits; send AC changes to them.
- Drive G: has ~6 GB free.
