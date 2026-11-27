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
These require OAuth, not a static bearer token. Available after P5 (OAuth support); not usable yet.

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
- Effect: a request with this token sees no `trade` namespace in `execute` (`trade.place` fails), and `search` hides all `trade.*` entries. `market`, `account`, `backtest` and `risk` work as usual.
- `MCP_TOKEN` and OAuth tokens keep full access. Leave `MCP_TOKEN_READONLY` unset to disable the feature.

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
