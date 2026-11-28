# agent-runner

Scheduler that runs recurring AI jobs (pre-market brief, end-of-day review, weekly backtest refresh) against trade-mcp and writes each result to a markdown report (ADR-7). It runs on the same VPS as trade-mcp or on any machine with Node 22+.

## Backends
- `claude`, `codex`, `gemini`: the vendor CLI is launched headless with the prompt and the MCP server configured for that run. The CLI must be installed and logged in on the host.
- `api`: Anthropic Messages API with the MCP connector. Needs `ANTHROPIC_API_KEY` and a public https MCP URL (Anthropic's servers call trade-mcp, so localhost will not work).
- `api-openai`: OpenAI Responses API with remote MCP. Needs `OPENAI_API_KEY`, optional `OPENAI_MODEL`, and a public https MCP URL.
- `api-gemini`: Gemini API with a remote MCP tool (in-process Streamable HTTP client). Needs `GEMINI_API_KEY`, optional `GEMINI_MODEL` (default `gemini-3.8-flash`), and an https MCP URL.

## Read-only recommendation
Jobs must not trade. Set `MCP_TOKEN_READONLY` on trade-mcp (see `docs/connect-clients.md`) and point each job's `mcp.tokenEnv` at an env var holding that token. The `trade` namespace is then absent server side, whatever the prompt says.

## jobs.json
A JSON array of jobs (see `jobs.example.json`):

| field | rules |
|---|---|
| `name` | `[A-Za-z0-9_-]+`, unique |
| `schedule.days` | non-empty list of `Mon`..`Sun` |
| `schedule.time` | `HH:MM`, 24h |
| `schedule.tz` | `"Asia/Kolkata"` or `"UTC"` |
| `backend` | `claude`, `codex`, `gemini`, `api`, `api-openai` or `api-gemini` |
| `prompt` | non-empty string |
| `mcp` | `{ "name", "url", "tokenEnv" }`; `tokenEnv` is the NAME of the env var holding the token, never the token |
| `timeoutMs` | optional, positive |
| `notify` | optional, `{ "telegram": { "chatIdEnv" } }`; `chatIdEnv` is the NAME of the env var holding the chat id. No other keys allowed |
| `outputDir` | directory for reports |

```json
{ "name": "eod-review",
  "schedule": { "days": ["Mon","Tue","Wed","Thu","Fri"], "time": "15:45", "tz": "Asia/Kolkata" },
  "backend": "claude", "prompt": "Read-only end-of-day review ...",
  "mcp": { "name": "tradedesk", "url": "https://mcp.example.com/mcp", "tokenEnv": "MCP_TOKEN_READONLY" },
  "timeoutMs": 600000, "outputDir": "./runs" }
```

## Commands
```
npm install
npm run build
MCP_TOKEN_READONLY=... node dist/main.js --jobs jobs.json          # scheduler, runs until stopped
MCP_TOKEN_READONLY=... node dist/main.js --jobs jobs.json --once eod-review   # run one job now
node dist/main.js --jobs jobs.json --check        # list jobs; report set/missing token and API key env vars (never values); exit 1 if any missing
node dist/main.js --jobs jobs.json --dry-run eod-review   # show what a job would do (backend, model, MCP url, token env set/missing, timeout, next run, prompt); runs nothing, no network; secret values redacted
node dist/main.js --jobs jobs.json --next [N]     # print each job's next N (default 5) run times in its tz and UTC; runs nothing
node dist/main.js --jobs jobs.json --history [N]  # last N (default 20, max 200) runs across jobs, newest first: job, date[-n], status, duration, path (header fields only); skips unreadable reports; runs nothing, no network
npm test
```
`--jobs` defaults to `jobs.json`.

## Gemini paper-trading job
`jobs.example.json` ships `paper-crypto-gemini`: backend `api-gemini`, tz `UTC`, MCP url `https://mcp.<DOMAIN>/mcp` (replace the placeholder). Each run reads `risk.status()`, pulls recent BTCUSD candles with `market.history`, applies one rule (latest close vs the 20-period SMA) and places at most one paper order of quantity 1. It states its reasoning, and reports a denied or failed order without retrying it.

- **Keys:** `GEMINI_API_KEY` (Gemini API key) in the runner's environment. Model: default `gemini-3.8-flash` (`DEFAULT_GEMINI_MODEL` in `src/gemini.ts`), override with `GEMINI_MODEL`.
- **Token:** the job's `mcp.tokenEnv` is `MCP_TOKEN`, the FULL token, not `MCP_TOKEN_READONLY`, because it places paper orders (the read-only token removes the `trade` namespace). WARNING: the full token can place orders. Keep it secret, never commit it, and do not use this job against a server running with `MODE=live`; the prompt tells the model to stop unless `risk.status().mode` is `paper`, but run it only on a paper-mode server.
- **Paper only, limits server side:** risk limits (quantity, notional, orders per day and per run, allowed symbols, kill switch) are enforced in trade-mcp whatever the model decides; static checks (O-17) run before any broker call and a violation is denied.
- **Schedule:** a job has one `HH:MM` per day (see the table above), so the example runs once a day at 00:00 UTC. For a 30-minute cadence, add more jobs with different names and `time` values, or use `--once paper-crypto-gemini` from cron or a systemd timer.
- **Cost:** each run is one Gemini request loop with several MCP tool calls, so cost grows with runs per day times tokens per run (prompt plus candle data returned). Start with the default Flash model and a low cadence, and check your Google billing page.

Try it before enabling:
```
export GEMINI_API_KEY=... MCP_TOKEN=...
node dist/main.js --jobs jobs.example.json --check
node dist/main.js --jobs jobs.example.json --dry-run paper-crypto-gemini
node dist/main.js --jobs jobs.example.json --next 3
node dist/main.js --jobs jobs.example.json --once paper-crypto-gemini
```

## Reports
Each run writes `<outputDir>/<name>/<YYYY-MM-DD>.md` (date in the job's time zone; a repeat run the same day gets `-1`, `-2`, ...). The file has status, duration, any error, the prompt and the result. The MCP token is redacted from the output.

## Telegram notifications
A job with `notify.telegram` sends a summary (job name, status, duration, the first 3500 characters of the result, and any error) to Telegram after its report file is written. Set `TELEGRAM_BOT_TOKEN` (bot token) and the env var named by `chatIdEnv` (chat id) in the runner's environment; never put them in `jobs.json`. The MCP token and bot token are redacted from the message and from all logs. Delivery is best effort with a 10 s timeout: a missing variable, HTTP error or network failure logs a redacted warning and never changes the job result or the report file. Jobs without `notify` make no network call.

## Windows
On Windows a CLI found only as a `.cmd` or `.bat` shim (typical for npm-installed CLIs) is refused, because passing the prompt through a shell is unsafe. Use a native `.exe`, run under WSL, or run the scheduler on the VPS.
