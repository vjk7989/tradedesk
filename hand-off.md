# Hand-off 2026-11-27 (late session)
State: main @ a71c380+ pushed to https://github.com/vjk7989/tradedesk (private).
- Done and merged: P0, P1.1–P1.6, P2.1–P2.5, P3.1, P4.1–P4.3, P5.1, P8.1–P8.3, plus the sandbox flake fix.
- Code graph: codebase-memory project `tradedesk`. Re-index after this batch of merges.

## In flight
| Work | Who / where | Status |
|---|---|---|
| P8.5 read-only MCP token | D1 (fresh Sonnet), G:\uday-demos.d1 | done; Opus edge tests running |
| P7.1 india_fno engine + P3.2-f1 crypto fixes + P8.4-f1 scheduler fixes | D2, G:\uday-demos.d2 (branch also contains merged d3 P3.2) | done; Opus edge tests for P7.1 running; P8.4 main tests being added |
| OC-P7.3 walk-forward endpoint | OpenCode OC1, G:\uday-demos.oc1, branch oc/OC-P7.3 | picked up |
| OC-P5.2 Caddy OAuth routes + env + runbook | OpenCode OC2, G:\uday-demos.oc2, branch oc/OC-P5.2 | picked up |

Blocked: none.

## Next steps
1. Green → merge d2 (P7.1/P3.2/P8.4) and d1 (P8.5), push, re-index the graph.
2. P7.2 intraday backtests (fresh Sonnet developer; bt-service runner/engines).
3. Review the OpenCode reports when `coord/reports/*.md` appear: Sonnet review → Opus tests → Haiku run → merge.
4. Update the docs for the new features: lot_sizes/margin_pct in the trade-mcp backtest doc; MCP_TOKEN_READONLY in deploy env, the runbook and connect-clients.
5. Needs the user:
   - P4.4: VPS paper end-to-end.
   - P6.1: Fincept install plus the mcp-remote config.
   - Verify the Delta perpetual symbol format (BTCUSDFUT vs BTCUSD.P), the NSE lot sizes and the F&O tax rates.

## Team (ADR-11)
- D1 and D2 are Sonnet. Old D1 and D2 agents are retired (context too large or stuck), so spawn fresh lean-developer agents with exact file:line from the graph.
- D3 retired after P3.2.
- OpenCode works through `coord/`.

Resources: 16 CPU, ~3 GB RAM free, GTX 1650, drive G: ~6 GB free (no Docker builds, no Fincept source build).

Tools: trail, graphify, headroom present; wt missing → `git worktree`; graft → trail.

## Gotchas
- Haiku runners sometimes run in G:\uday-demos instead of the worktree. Always give the absolute `cd /g/uday-demos.dN/...` path.
- Test writers own test edits. When the AC changes, send the update to the original test writer.
- Full bt-service suite is ~3 min (the @CRYPTO fallback test is ~65 s).
- On Windows, npm .cmd CLI shims can't be spawned without a shell. agent-runner refuses them by design (ADR via P8.2-f1).
- OAuth rate limiting assumes trade-mcp is reachable only through Caddy.

## Commands
- trade-mcp: `npx vitest run && npx tsc --noEmit && npm run build`
- bt-service: `uv sync && uv run pytest -q`
- agent-runner: `npx vitest run && npx tsc --noEmit && npm run build`
- deploy: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config -q && uv run --with pytest --with pyyaml pytest -q deploy/test_deploy.py`
