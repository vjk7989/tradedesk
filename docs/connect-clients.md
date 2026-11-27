# Connecting clients to trade-mcp

Endpoint: `https://mcp.<DOMAIN>/mcp` (Streamable HTTP), header `Authorization: Bearer <MCP_TOKEN>`.
Local stdio: `node <path>/dist/src/index.js --stdio` with the same env vars as `deploy/.env` (OPENALGO_URL, OPENALGO_API_KEY, MCP_TOKEN, MODE, ...).
Tools: `search` (discover the API) and `execute` (run a call).

```
export MCP_TOKEN=<your MCP_TOKEN>
```

## Claude Code
Remote:
```
claude mcp add --transport http tradedesk https://mcp.<DOMAIN>/mcp --header "Authorization: Bearer $MCP_TOKEN"
```
Local stdio:
```
claude mcp add tradedesk -e OPENALGO_URL=http://127.0.0.1:5000 -e OPENALGO_API_KEY=... -e MCP_TOKEN=... -e MODE=paper -- node <path>/dist/src/index.js --stdio
```
(verify: `claude mcp add --help`; flag order may differ by version.)

## Codex CLI
`~/.codex/config.toml`:
```toml
[mcp_servers.tradedesk]
url = "https://mcp.<DOMAIN>/mcp"
bearer_token_env_var = "TRADEDESK_MCP_TOKEN"
```
`export TRADEDESK_MCP_TOKEN=$MCP_TOKEN` before starting codex. Stdio form:
```toml
[mcp_servers.tradedesk]
command = "node"
args = ["<path>/dist/src/index.js", "--stdio"]
env = { OPENALGO_URL = "http://127.0.0.1:5000", OPENALGO_API_KEY = "...", MCP_TOKEN = "...", MODE = "paper" }
```
(verify: `codex mcp --help`.)

## Gemini CLI
`~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "tradedesk": {
      "httpUrl": "https://mcp.<DOMAIN>/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```
(verify: `gemini mcp --help`. Do not commit this file; it holds the token.)

## Claude Desktop
`claude_desktop_config.json`, via the `mcp-remote` bridge:
```json
{
  "mcpServers": {
    "tradedesk": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.<DOMAIN>/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer <MCP_TOKEN>" }
    }
  }
}
```
The no-space `Authorization:${AUTH}` form avoids an argument-with-space bug on Windows. (verify: `npx mcp-remote --help`.)

## ChatGPT (developer-mode connectors) and claude.ai custom connectors
These require OAuth, not a static bearer token. OAuth is built in but off by default: enable it with `OAUTH_ENABLED=1`, `OAUTH_ISSUER_URL` (https) and `OAUTH_PASSWORD_HASH` (see `vps-runbook.md`), then add the connector URL `https://mcp.<DOMAIN>/mcp`. Default allowed redirect hosts are `chatgpt.com,claude.ai,claude.com` (`OAUTH_ALLOWED_REDIRECT_HOSTS`). OAuth tokens get full access. Put these variables in `deploy/.env`, generate `OAUTH_PASSWORD_HASH` as in `vps-runbook.md` section 13, and never publish trade-mcp's port 8787: it is reached only through Caddy.

## Fincept Terminal
Fincept's MCP client is stdio-only. Settings -> MCP servers -> add a stdio server:
- Command: `npx`
- Args: `-y mcp-remote https://mcp.<DOMAIN>/mcp --header Authorization:${AUTH}`
- Env: `AUTH=Bearer <MCP_TOKEN>`

To use Fincept's Claude Code harness, set `ANTHROPIC_API_KEY` in its environment and add the server as in the Claude Code section. (verify the exact menu names in your Fincept version.)

## Read-only token for scheduled jobs
Scheduled AI jobs (agent-runner) should be technically unable to trade, not just told not to. On trade-mcp set a second token:
- `MCP_TOKEN_READONLY=<random, at least 24 characters, different from MCP_TOKEN>` (e.g. `openssl rand -hex 32`), then restart trade-mcp.
- Give that value to the job through its `mcp.tokenEnv` (the env var name in `jobs.json`; see `agent-runner/README.md`).
- Effect: a request with this token sees no `trade` namespace in `execute` (`trade.place` fails), and `search` hides all `trade.*` entries. `market`, `account`, `backtest`, `risk` (including `risk.status`) and `audit` (`audit.recent`) work as usual.
- Calling any `trade.*` (place, modify, cancel, closePosition) with this token fails: the `trade` binding does not exist in its sandbox.
- `MCP_TOKEN` and OAuth tokens keep full access. Leave `MCP_TOKEN_READONLY` unset to disable the feature.

## Scheduled jobs (agent-runner)
`jobs.json` jobs pick a `backend`; the three API backends need the key in the runner's environment and a public https MCP URL:

| backend | key env | model (default) |
|---|---|---|
| `api` (Anthropic) | `ANTHROPIC_API_KEY` | `claude-opus-5-5` (fixed in code) |
| `api-openai` | `OPENAI_API_KEY` | `gpt-5.5`; override with `OPENAI_MODEL` |
| `api-gemini` | `GEMINI_API_KEY` | `gemini-3.8-flash`; override with `GEMINI_MODEL` |

Before enabling the schedule:
- `node dist/main.js --jobs jobs.json --check`: per job, shows whether the MCP token env and the API key env are set or missing (exit 1 if not).
- `node dist/main.js --jobs jobs.json --next 3`: next N run times per job (N 1-100, default 5); cannot be combined with `--check`.
- `--dry-run <name>`: prints what that job would run (including the model); secret values are not printed; not combinable with `--once`, `--check` or `--next`.

Telegram: add `"notify": { "telegram": { "chatIdEnv": "TG_CHAT_ID" } }` to a job (`chatIdEnv` is an env var NAME). Set `TELEGRAM_BOT_TOKEN` and that variable in the runner's environment. Failures only log a warning; they never fail the job.

## Asking what the agent did, and limits
In `execute`, both calls also work with the read-only token:
- `audit.recent({ limit?: number })` returns `{ entries, skipped }`: the last N audit entries (limit 1-200, default 20; newest last, secrets redacted). Prompt: "Use `audit.recent` with limit 50 and summarize what the agent did today."
- `risk.status()` returns `{ mode, killSwitch, limits, today: { date, orders, notional } }`. Prompt: "Use `risk.status` and tell me how much of today's order and notional limits is used."

## Health
Only `/healthz` is public (`curl https://mcp.<DOMAIN>/healthz` returns `{ ok, mode }`). `/readyz` is internal only (Caddy does not route it); run `docker compose exec trade-mcp wget -qO- http://127.0.0.1:8787/readyz`. It needs no token and returns 200 or 503 with `{ "ok": boolean, "checks": { "openalgo": "ok"|"fail", "bt": "ok"|"fail"|"not_configured", "auditWritable": "ok"|"fail" } }`. If something fails, see `troubleshooting.md` (sections 2-5); for backtest limits see `backtesting.md` section 5.

## Timeouts
`execute` stops code that runs longer than `EXECUTE_TIMEOUT_MS` (default 60000 ms, clamped to 5000-900000). Walk-forward backtests can take up to ~10 minutes, so set `EXECUTE_TIMEOUT_MS=660000` or more on the server. Your MCP client may also enforce its own tool-call timeout; raise it too if long backtests get cut off.

## First prompts
- "Use `search` to list the API, then show my funds."
- "Backtest a 20/50 SMA crossover on RELIANCE.NS from 2022 to 2025 and summarize the results."
- "Place a paper LIMIT buy of 1 RELIANCE at 2400 on NSE (product CNC)."
- "Show my open positions and today's orders."

## Safety
- Paper by default: `MODE=paper` plus OpenAlgo Analyzer mode. Going live is a deliberate server-side change (see `vps-runbook.md`); a client or prompt cannot switch it.
- Limits from `risk.json` (allowed exchanges/products, symbol allow/deny, max qty and notional per order, orders and notional per day, daily loss, orders per run) are enforced in trade-mcp; clients cannot raise them.
- Kill switch: `docker compose exec trade-mcp touch /data/KILL` stops all orders; `rm` it to resume.
- Approvals: set the OpenAlgo key to `semi_auto` so every order waits for your approval in the Action Center.
- Treat `MCP_TOKEN` as a secret; rotate with `openssl rand -hex 32` and restart trade-mcp.
