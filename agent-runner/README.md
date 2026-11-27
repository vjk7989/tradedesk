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
node dist/main.js --jobs jobs.json --next [N]     # print each job's next N (default 5) run times in its tz and UTC; runs nothing
npm test
```
`--jobs` defaults to `jobs.json`.

## Reports
Each run writes `<outputDir>/<name>/<YYYY-MM-DD>.md` (date in the job's time zone; a repeat run the same day gets `-1`, `-2`, ...). The file has status, duration, any error, the prompt and the result. The MCP token is redacted from the output.

## Windows
On Windows a CLI found only as a `.cmd` or `.bat` shim (typical for npm-installed CLIs) is refused, because passing the prompt through a shell is unsafe. Use a native `.exe`, run under WSL, or run the scheduler on the VPS.
