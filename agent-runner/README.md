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
| `schedule.time` | `HH:MM`, 24h. Exactly one of `time` or `everyMinutes` is required |
| `schedule.everyMinutes` | integer 5..1440; runs at local 00:00 then every N minutes (see "Interval schedules") |
| `schedule.between` | optional `["HH:MM","HH:MM"]`, only with `everyMinutes` |
| `schedule.tz` | `"Asia/Kolkata"` or `"UTC"` |
| `backend` | `claude`, `codex`, `gemini`, `api`, `api-openai` or `api-gemini` |
| `prompt` | non-empty string |
| `mcp` | `{ "name", "url", "tokenEnv" }`; `tokenEnv` is the NAME of the env var holding the token, never the token |
| `timeoutMs` | optional, positive |
| `notify` | optional, `{ "telegram": { "chatIdEnv" } }`; `chatIdEnv` is the NAME of the env var holding the chat id. No other keys allowed |
| `outputDir` | directory for reports |

### Interval schedules
`everyMinutes` (5..1440, integer, mutually exclusive with `time`) runs the job on a fixed grid in the job's `tz`: minute 0 of each local day, then every N minutes. `days` still filters by the local weekday. The grid restarts at 00:00 each day, so if N does not divide 1440 the last gap of the day is shorter (`7` gives 23:55 then 00:00). `between: ["09:15","15:30"]` keeps only slots inside the window; both ends are inclusive, start must be before end (no overnight windows) and the window does not shift the grid (every 45 min gives 09:45, not 09:15). `between` is rejected with `time`. A `between` window that contains no grid slot (for example every 60 min between 09:10 and 09:50) is a parse error naming the job. Unknown keys inside `schedule` are ignored. The runner executes all jobs sequentially in one loop, so a long run of one job delays the others: a `time` job whose minute passes during another job's run is not skipped, it runs late as soon as the runner is free (this is unchanged from before TM2-74), while interval slots missed while the runner is busy are skipped. Runs never stack: if a job's own run is still going when a slot arrives, that slot is skipped and logged as `skipped (previous run still active)`; later slots keep the same grid. `--next N` and `--dry-run` show interval runs in the job's tz.

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
`jobs.gemini-paper.example.json` (kept separate so `jobs.example.json` stays read-only) holds `paper-crypto-gemini`: backend `api-gemini`, tz `UTC`, MCP url `https://mcp.<DOMAIN>/mcp` (replace the placeholder). Each run reads `risk.status()` first and stops, placing nothing, unless `mode` is `paper` (it also stops on kill switch). It then pulls recent BTCUSD candles with `market.history`, applies one rule (latest close vs the 20-period SMA) and places at most one paper order of quantity 1. It states its reasoning, and reports a denied or failed order without retrying it.

- **Keys:** `GEMINI_API_KEY` (Gemini API key) in the runner's environment. Model: default `gemini-3.8-flash` (`DEFAULT_GEMINI_MODEL` in `src/gemini.ts`), override with `GEMINI_MODEL`.
- **Token:** the job's `mcp.tokenEnv` is `MCP_TOKEN`, the FULL token, not `MCP_TOKEN_READONLY`, because it places paper orders (the read-only token removes the `trade` namespace). WARNING: the full token can place orders. Keep it secret, never commit it, and do not use this job against a server running with `MODE=live`; the prompt tells the model to stop unless `risk.status().mode` is `paper`, but run it only on a paper-mode server.
- **What is and is not guaranteed:** trade-mcp enforces, whatever the model decides, the kill switch (`trade-mcp/src/risk/engine.ts:111`), allowed exchange/product and `symbolAllow`/`symbolDeny` (:112-118), integer quantity up to `maxQtyPerOrder` (:119, default 100, `src/config.ts:27`), the notional caps (:140), `maxOrdersPerDay` (:147, default 20) and `maxOrdersPerRun` (:148, default 5), and the O-17 static checks run before any broker call (:84). These do NOT force quantity 1 or one order per run (the defaults allow 100 and 5), and they do NOT block live mode: `mode` is only reported by `risk.status()` (:210). "Paper only", "quantity 1" and "one order" are therefore prompt rules; the real paper-only protection is running this job against a server started with `MODE=paper`.
- **Tight risk.json for this job:** on the trade-mcp server use exact key names from `trade-mcp/src/config.ts:25-33`, for example (symbol is the BTC perpetual returned by `market.search`; `BTCUSDFUT` per the crypto note in `trade-mcp/src/sdk/api-docs.ts:10`, confirm yours):
  ```
  { "symbolAllow": ["BTCUSDFUT"], "maxQtyPerOrder": 1, "maxOrdersPerRun": 1 }
  ```
  (see `deploy/risk.example.json` for the full file). Note that a SELL on a perpetual opens a short position.
- **Schedule:** the schema allows one `HH:MM` per job (days list plus one time, tz `UTC` or `Asia/Kolkata`), so the file has ONE job that runs daily at 00:00 UTC. Interval scheduling is available since TM2-74 (`schedule.everyMinutes: 30`); this example file is left on the daily `time` schedule. The pre-TM2-74 alternative for a 30-minute cadence was to run `--once` from an external cron. Keep secrets out of the crontab: put them in a root-owned env file and load it from a wrapper script (all paths are placeholders).
  1. Env file `/etc/tradedesk/agent-runner.env`, `chmod 600`, owned by the runner user, with the lines `GEMINI_API_KEY=<your key>` and `MCP_TOKEN=<full token>`.
  2. Wrapper `/path/to/run-gemini-paper.sh` (`chmod 700`):
     ```
     #!/bin/sh
     set -a; . /etc/tradedesk/agent-runner.env; set +a
     cd /path/to/agent-runner && exec flock -n /tmp/agent-runner-gemini.lock node dist/main.js --jobs jobs.gemini-paper.example.json --once paper-crypto-gemini
     ```
     `flock -n` skips a run if the previous one is still going.
  3. Crontab (UTC host clock):
     ```
     */30 * * * * /path/to/run-gemini-paper.sh >> /var/log/agent-runner-gemini.log 2>&1
     ```
  Alternative: a systemd service with `EnvironmentFile=/etc/tradedesk/agent-runner.env` (mode 600) and a timer.
- **Cost:** each run is one Gemini request loop with several MCP tool calls, so cost grows with runs per day times tokens per run (prompt plus candle data returned). Start with the default Flash model and a low cadence, and check your Google billing page.

Try it before enabling. Do not type the secrets as `export KEY=...`: that lands in shell history. Load the env file instead (`set -a; . /etc/tradedesk/agent-runner.env; set +a`) or use `read -s`:
```
node dist/main.js --jobs jobs.gemini-paper.example.json --check
node dist/main.js --jobs jobs.gemini-paper.example.json --dry-run paper-crypto-gemini
node dist/main.js --jobs jobs.gemini-paper.example.json --next 3
node dist/main.js --jobs jobs.gemini-paper.example.json --once paper-crypto-gemini
```

## Reports
Each run writes `<outputDir>/<name>/<YYYY-MM-DD>.md` (date in the job's time zone; a repeat run the same day gets `-1`, `-2`, ...). The file has status, duration, any error, the prompt and the result. The MCP token is redacted from the output.

## Telegram notifications
A job with `notify.telegram` sends a summary (job name, status, duration, the first 3500 characters of the result, and any error) to Telegram after its report file is written. Set `TELEGRAM_BOT_TOKEN` (bot token) and the env var named by `chatIdEnv` (chat id) in the runner's environment; never put them in `jobs.json`. The MCP token and bot token are redacted from the message and from all logs. Delivery is best effort with a 10 s timeout: a missing variable, HTTP error or network failure logs a redacted warning and never changes the job result or the report file. Jobs without `notify` make no network call.

## Windows
On Windows a CLI found only as a `.cmd` or `.bat` shim (typical for npm-installed CLIs) is refused, because passing the prompt through a shell is unsafe. Use a native `.exe`, run under WSL, or run the scheduler on the VPS.
