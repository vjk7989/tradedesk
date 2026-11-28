# TradeDesk

A self-hosted trading stack: OpenAlgo (Indian brokers plus Delta crypto) behind an MCP server with Code Mode, so Claude, Codex, ChatGPT or Gemini can research, backtest and trade through two tools, `search` and `execute`. Paper mode by default.

Personal project. Not financial advice. Paper-trade first.

## What it is

- **trade-mcp**: Node/TS MCP server with `search` and `execute`. Code you send runs in a QuickJS sandbox and calls OpenAlgo and bt-service through host bindings ([ADR-3](architecture-record-document.md)).
- **OpenAlgo**: the execution core, run unmodified ([ADR-2](architecture-record-document.md)).
- **bt-service**: Python/FastAPI backtests on the engine extracted from Vibe-Trading ([ADR-4](architecture-record-document.md)).
- **agent-runner**: scheduled agent jobs using the Claude, Codex or Gemini CLIs, or the Anthropic, OpenAI or Gemini APIs ([ADR-7](architecture-record-document.md)).
- **Fincept Terminal**: optional desktop cockpit via `mcp-remote` ([ADR-1](architecture-record-document.md)).
- **paper-bot**: coming (PB-1/PB-2).

## Architecture

```
 Your PC / cloud AI client           VPS (docker compose)
 ┌──────────────────────┐  HTTPS   ┌─────────────────────────────────────────────────┐
 │ Claude / Codex /     │─────────▶│ Caddy (TLS)                                     │
 │ ChatGPT / Gemini /   │ token or │   ├─ trade-mcp  /mcp  search, execute           │
 │ Fincept (mcp-remote) │ OAuth    │   │    QuickJS sandbox -> supervisor            │
 └──────────────────────┘          │   │    (risk engine, audit log, kill switch)    │
                                   │   │       ├─> OpenAlgo REST -> brokers, Delta   │
 agent-runner (VPS or any host)    │   │       └─> bt-service    -> backtests        │
  scheduled jobs ─ read-only token ▶│   ├─ OpenAlgo UI (login, Action Center)         │
  (recommended), via /mcp          │   └─ paper-bot (coming, PB-1/PB-2)              │
                                   └─────────────────────────────────────────────────┘
```

## Safety model

- Paper mode is the default; live mode is operator config only, never settable by a client or by sandbox code ([ADR-5](architecture-record-document.md)).
- A server-side risk engine, outside the sandbox, enforces per-run and daily order caps, market hours and holidays. Orders are reserve-then-place and fail closed if the audit log cannot be written ([ADR-9](architecture-record-document.md)).
- Kill switch: if the `KILL` file exists, new orders and modifications (`trade.place`, `trade.modify`) are refused; `trade.cancel` and `trade.closePosition` still work so risk can be reduced ([runbook section 9](docs/vps-runbook.md)).
- Sandbox limits: no binary buffers, capped binding traffic ([ADR-18](architecture-record-document.md)), a hard WASM memory maximum ([ADR-19](architecture-record-document.md)), and an execute timeout.
- Read-only token (`MCP_TOKEN_READONLY`): the `trade` namespace does not exist for that scope. Recommended for scheduled jobs, but not enforced: a job only gets it if you point it at that token ([connect-clients](docs/connect-clients.md)).
- OAuth for ChatGPT and claude.ai is built in and off by default.

Security policy and threat model: [SECURITY.md](SECURITY.md).

## Features

- **Code Mode**: `search` finds the typed SDK, `execute` runs your code against it.
- **Backtests** via `backtest.*`, including `backtest.walkForward`. Engines are picked by symbol: india_equity (CNC, MIS), india_fno, india_options, crypto perpetual with funding, and composite baskets. See [docs/backtesting.md](docs/backtesting.md).
- **Scheduled jobs**: agent-runner with `--check`, `--next`, `--dry-run`, `--history`, per-job reports and optional Telegram notify. See [agent-runner/README.md](agent-runner/README.md).
- **Audit**: `trade.place`, `trade.modify`, `trade.cancel` and `trade.closePosition` (allowed, denied or error), plus `backtest.run`, `backtest.walkForward` and `audit.recent` calls, are written to the audit log; `audit.recent()` returns the latest entries.
- **Operator tools**: `risk.status()`, backup and restore ([docs/backup.md](docs/backup.md)), exchange holidays sync ([docs/holidays.md](docs/holidays.md)), `oauth:revoke-all`.

## Quick start

- VPS deployment: [docs/vps-runbook.md](docs/vps-runbook.md). Use your own `<DOMAIN>`.
- Connecting clients: [docs/connect-clients.md](docs/connect-clients.md).
- Fincept cockpit: [docs/fincept-setup.md](docs/fincept-setup.md).
- Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md).
- Backtesting guide: [docs/backtesting.md](docs/backtesting.md).
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

Local smoke test (fake OpenAlgo, no broker): `node e2e/smoke.mjs`; see [e2e/README.md](e2e/README.md).

Tests, per package (from the repo root):

```
(cd trade-mcp && npm ci && npx vitest run && npx tsc --noEmit)
(cd bt-service && uv sync && uv run pytest -q)
(cd agent-runner && npm ci && npx vitest run && npx tsc --noEmit && npm run build)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config -q
uv run --with pytest --with pyyaml pytest -q deploy/test_deploy.py
```

CI (`.github/workflows/ci.yml`) runs all of these on every PR and push to main. Dependabot (`.github/dependabot.yml`) opens weekly PRs, each reviewed and merged by hand.

Clone: `git clone https://github.com/vjk7989/tradedesk`

## Repo layout

| Folder | What |
|---|---|
| `trade-mcp/` | MCP server, QuickJS sandbox, risk engine, audit, OAuth, OpenAlgo client |
| `bt-service/` | FastAPI backtest service; `vibe_bt/` is the extracted engine |
| `agent-runner/` | Scheduled agent jobs and backends |
| `deploy/` | Docker compose, Caddyfile, example risk config, backup scripts |
| `docs/` | Runbook, clients, Fincept, troubleshooting, backtesting, backup, holidays |
| `e2e/` | Fake OpenAlgo and smoke test |
| `coord/` | Team task coordination notes |

## Status and limits

- Personal project, best effort ([SECURITY.md](SECURITY.md)). Not financial advice. Paper first.
- 1 lot needs margin plus opening fees, so capital exactly equal to margin opens nothing.
- Funding is not charged when a scale-in and a full exit both happen inside one sparse gap.
- OAuth codes and the login rate limiter are in memory.
- trade-mcp's port must never be published.
- Verify rates and lot sizes before live trading.

## Licences and credits

- Vibe-Trading code under `bt-service/vibe_bt` is MIT; see [NOTICE](bt-service/vibe_bt/NOTICE).
- OpenAlgo and Fincept are separate AGPL projects, used unmodified and not vendored.
- Not affiliated with Fincept, OpenAlgo, Delta or any broker.

## Disclaimer

Not financial advice. Use at your own risk. Paper-trade first.
