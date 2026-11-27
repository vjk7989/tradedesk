# TradeDesk

A self-hosted AI trading desk: an MCP server that lets an AI client search, backtest and trade through one sandboxed code tool, paper mode by default.

## What it is

- **trade-mcp**: a Code Mode MCP server exposing two tools, `search` and `execute`, over OpenAlgo (Indian brokers plus Delta crypto).
- **bt-service**: a backtest service built on the engine extracted from Vibe-Trading.
- **agent-runner**: runs scheduled agent jobs with the Claude, Codex or Gemini CLIs, or the Anthropic API.
- **Fincept Terminal**: optional desktop cockpit, connected through `mcp-remote`.

## Architecture

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

## Safety model

- Paper mode is the default. Live mode is switched on only by server config, never by a client.
- Risk limits are enforced server-side in the supervisor, outside the sandbox ([ADR-5](architecture-record-document.md)).
- Orders are reserve-then-place and fail closed if the audit log cannot be written ([ADR-9](architecture-record-document.md)).
- A kill switch halts trading; every action goes to the audit log.
- Scheduled jobs use a read-only token.
- Nothing running in the sandbox can change the mode.

Design records: [ADR-2](architecture-record-document.md) (OpenAlgo unmodified), [ADR-3](architecture-record-document.md) (QuickJS sandbox), [ADR-7](architecture-record-document.md) (CLI or API keys to drive the AI).

## Quick start

Tests, per package (run from the repo root):

```
(cd trade-mcp && npm ci && npx vitest run && npx tsc --noEmit)
(cd bt-service && uv sync && uv run pytest -q)
(cd agent-runner && npm ci && npx vitest run && npx tsc --noEmit && npm run build)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config -q
uv run --with pytest --with pyyaml pytest -q deploy/test_deploy.py
```

Local smoke test (fake OpenAlgo, no broker needed): `node e2e/smoke.mjs`. See [e2e/README.md](e2e/README.md).

- VPS deployment: [docs/vps-runbook.md](docs/vps-runbook.md). Use your own `<DOMAIN>`.
- Connecting clients: [docs/connect-clients.md](docs/connect-clients.md).
- Fincept cockpit: [docs/fincept-setup.md](docs/fincept-setup.md).

Clone: `git clone https://github.com/vjk7989/tradedesk`

## Repo layout

| Folder | What |
|---|---|
| `trade-mcp/` | Node/TS MCP server, QuickJS sandbox, risk engine, OpenAlgo client |
| `bt-service/` | Python/FastAPI backtest service; `vibe_bt/` is the extracted engine |
| `agent-runner/` | Scheduled agent jobs and backends |
| `deploy/` | Docker compose, Caddyfile, example risk config |
| `docs/` | VPS runbook, client and Fincept setup |
| `e2e/` | Fake OpenAlgo and smoke test |
| `coord/` | Team task coordination notes |

## Status and limits

- 1 lot needs margin plus opening fees, so capital exactly equal to margin opens nothing.
- Funding is not charged when a scale-in and a full exit both happen inside one sparse gap.
- OAuth codes and the login rate limiter are in memory.
- Holidays are not modelled until TM-3 lands.
- trade-mcp's port must never be published.
- Verify rates and lot sizes before live trading.

## Licences and credits

- Vibe-Trading code under `bt-service/vibe_bt` is MIT; see [NOTICE](bt-service/vibe_bt/NOTICE).
- OpenAlgo and Fincept are separate AGPL projects, used unmodified and not vendored.
- Not affiliated with Fincept, OpenAlgo, Delta or any broker.

## Disclaimer

Not financial advice. Use at your own risk. Paper-trade first.
