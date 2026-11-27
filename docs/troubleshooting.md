# Troubleshooting

Symptom, cause, fix. Error text is quoted exactly as the code emits it. Risk
limits live in `risk.json` (the server reads the path in `RISK_CONFIG`; in
compose that is fixed to `/config/risk.json`, and the host file mounted there is
chosen by `RISK_CONFIG_FILE` in `deploy/.env`, default `./risk.example.json`). Changing `risk.json` or `.env` needs
`docker compose up -d trade-mcp` to take effect.

## 1. Orders refused by risk

A refused order fails with `risk denied: <reason>; <reason>...`. Every failing
check is listed, not just the first. Source: `trade-mcp/src/risk/engine.ts`.

| Reason (exact) | Triggers when | Change it with |
|---|---|---|
| `kill switch active` | The kill switch file exists | Delete the file (see below) |
| `exchange <X> not allowed` | Exchange not in `allowedExchanges` | `allowedExchanges` in `risk.json` |
| `product <X> not allowed` | Product not in `allowedProducts` (CRYPTO too) | `allowedProducts` |
| `symbol <X> is denied` | Symbol is in `symbolDeny` | `symbolDeny` |
| `symbol <X> not in allow list` | `symbolAllow` is non-empty and lacks the symbol | `symbolAllow` (empty list = allow all) |
| `quantity must be a positive integer` | Quantity is zero, negative or fractional | Fix the order |
| `quantity <N> exceeds maxQtyPerOrder <M>` | Quantity over the cap | `maxQtyPerOrder` |
| `price required for notional check` | No usable limit price or LTP | Fix the order, or check quotes work |
| `notional <N> exceeds per-order limit <M>` | Qty x price over the cap | `maxNotionalPerOrder` (non-CRYPTO), `maxNotionalPerOrderUsd` (CRYPTO) |
| `day notional <N> exceeds maxNotionalPerDay <M>` | Today's total (non-CRYPTO) over the cap | `maxNotionalPerDay` |
| `maxOrdersPerDay <N> reached` | Orders today (IST date) at the cap | `maxOrdersPerDay` |
| `maxOrdersPerRun <N> reached` | Too many orders in one `execute` run | `maxOrdersPerRun` |
| `day P&L unavailable/invalid` | Live mode: P&L value was not a finite number | Check OpenAlgo/broker session (section 2) |
| `daily loss limit <N> hit` | Live mode: day P&L is at or below -`maxDailyLoss` | `maxDailyLoss` |
| `market closed for <X>` | Outside trading hours or on a holiday | See "Market hours" |

CRYPTO notional is `quantity x contractValues[SYMBOL] x price` (`contractValues`
defaults to 1 per symbol). CRYPTO has no daily notional cap.

Other pre-trade errors from `trade-mcp/src/sdk/bindings.ts`:

| Error (exact) | Meaning |
|---|---|
| `could not determine LTP for notional check` | Market order and the quote had no valid `ltp` |
| `paper mode requires OpenAlgo analyzer ON` | `MODE=paper` but OpenAlgo Analyzer is off (section 2) |
| `broker rejected: <message>` | OpenAlgo/broker answered but not with success; read the message |
| `audit log unavailable — order refused` | See "Audit fail-closed" |

A `warning` of `day P&L unavailable; daily loss check skipped` appears in the
audit record when live P&L could not be read; the order is not blocked for it.

### Kill switch

The kill switch is a file. It defaults to `$DATA_DIR/KILL` (`DATA_DIR` is
`/data` in compose); `KILL_SWITCH_FILE` overrides the path. If the file exists,
`trade.place` and `trade.modify` are refused with `kill switch active`.
`trade.cancel` and `trade.closePosition` still work so you can reduce risk.
To resume: remove the file (for example `docker compose exec trade-mcp rm /data/KILL`).
`risk.status()` shows `killSwitch: true/false`.

### Market hours and holidays

Hours are IST, independent of the server timezone (`trade-mcp/src/risk/hours.ts`):

| Exchanges | Open (Mon-Fri) |
|---|---|
| NSE, BSE, NFO, BFO, CDS | 09:15 to before 15:30 |
| MCX | 09:00 to before 23:30 |
| CRYPTO | always open |

Saturday and Sunday are closed. An exchange outside this list is treated as
closed. Holidays come from `marketHolidays` in `risk.json`:
`{"NSE": ["YYYY-MM-DD"], "MCX": [...]}`. The `NSE` list covers NSE, BSE, NFO,
BFO and CDS; `MCX` covers MCX. A bad date format makes the server fail at
startup (`RISK_CONFIG: invalid field marketHolidays (<code>)`).

- Holiday not honoured: the date is missing from `marketHolidays`. Run
  `deploy/sync_holidays.py` (see `docs/holidays.md`), then restart `trade-mcp`.
- Check the file before restarting: `cd trade-mcp && npm run build && npm run risk:lint -- /path/to/risk.json [--strict]`.
  Exit 0 = valid (warnings allowed), 1 = invalid, 2 = warnings under `--strict`.
  A good file prints `risk config OK`, the caps, and a per-year holiday count for NSE and MCX.
  Warnings: `NSE: no holidays listed for <year>` (same for `MCX`), `duplicate holiday <date>`,
  and `holiday <date> falls on a Saturday` / `Sunday`. An invalid file prints
  `error: risk config is invalid` followed by `<field>: <message>` lines; other errors are
  `error: file is not valid JSON` and `error: cannot read file <path>`.

### Startup errors from `risk.json` and env

| Error (exact) | Cause |
|---|---|
| `RISK_CONFIG file is unreadable or not valid JSON` | `RISK_CONFIG` path wrong inside the container, or bad JSON |
| `RISK_CONFIG: unknown key(s) present` | A key not in the schema (typos are rejected) |
| `RISK_CONFIG: invalid field <name> (<code>)` | Wrong type or non-positive number for that field |
| `MODE must be "paper" or "live"` | `MODE` has another value |
| `MCP_TOKEN must be at least 24 characters` | Short token |
| `MCP_TOKEN_READONLY must differ from MCP_TOKEN` | Same value used twice |

### Audit fail-closed

Before every `trade.place` and `trade.modify` the server checks that the audit
file is writable. If not, the order is refused with
`audit log unavailable — order refused` (any reserved count is released). Check
that `$DATA_DIR` is mounted and writable, and that the disk is not full:
`docker compose exec trade-mcp ls -l /data`. `/readyz` reports
`auditWritable` (section 6).

## 2. OpenAlgo and the broker

| Symptom | Cause | Fix |
|---|---|---|
| `OPENALGO_API_KEY is required` at startup (compose: `set OPENALGO_API_KEY`) | Variable missing or blank in `deploy/.env` | Set it, then `docker compose up -d` |
| `HTTP <status>: ...` (for example 401 or 403) or `broker rejected: ...` on every call | Wrong or revoked `OPENALGO_API_KEY` | Create/copy the key in the OpenAlgo UI, update `.env`, restart `trade-mcp` and `bt-service` (both use it) |
| Quotes/orders fail the morning after it worked | The broker session expires daily (typically early morning IST) | Log in to OpenAlgo at `https://openalgo.<DOMAIN>` and finish the broker login before market open |
| Orders rejected only from the VPS | Broker rejects orders from an IP that is not registered (static-IP rule). The broker's own wording varies and is not in this repo | Register the VPS public IP in the broker API app settings (and Delta key whitelist for CRYPTO); see `docs/vps-runbook.md` |
| `paper mode requires OpenAlgo analyzer ON` | `MODE=paper` but Analyzer (paper/sandbox) is off in OpenAlgo | Turn Analyzer on in the OpenAlgo UI, or move deliberately to live |
| Orders go to the real broker unexpectedly | `MODE=live` and Analyzer off | Set `MODE=paper` in `deploy/.env` and enable Analyzer; `/healthz` shows the current `mode` |
| `request timeout after` / `network error:` | trade-mcp cannot reach `OPENALGO_URL` (http://openalgo:5000 in compose) | `docker compose ps`, `docker compose logs openalgo` |

`MODE` is `paper` by default. In paper mode every order first checks that
Analyzer is on; in live mode the daily-loss check reads P&L from the broker.
Switching to live is a server-side change only (see `docs/vps-runbook.md`).

## 3. MCP clients

| Symptom | Cause | Fix |
|---|---|---|
| HTTP 401 `{"error":"unauthorized"}` | Bearer token is not `MCP_TOKEN`, `MCP_TOKEN_READONLY` or a valid OAuth token | Re-copy the token, no quotes/whitespace; `Authorization: Bearer <token>` |
| Client connects but there is no `trade` API / orders fail | You used the read-only token. With `MCP_TOKEN_READONLY` the `trade` namespace is removed from the sandbox, so it does not exist for that client | Use `MCP_TOKEN` for trading clients; keep the read-only token for viewers |
| `redirect_uri not allowed` when adding a connector over OAuth | The client's redirect host is not allowed | Add the host to `OAUTH_ALLOWED_REDIRECT_HOSTS` (comma separated; default `chatgpt.com,claude.ai,claude.com`), restart `trade-mcp` |
| `OAUTH_ISSUER_URL must be https` | OAuth enabled (`OAUTH_ENABLED=1`) with a non-https issuer | Use `https://mcp.<DOMAIN>` |
| `OAUTH_PASSWORD_HASH must be scrypt:<32 hex salt>:<128 hex hash>` | OAuth enabled but `OAUTH_PASSWORD_HASH` is missing or malformed (it is required with `OAUTH_ENABLED=1`) | Generate the hash with the `node -e` snippet in `trade-mcp/src/oauth/config.ts` |
| `invalid authorization code` | Authorization code expired or reused | Start the connection again |
| `timeout: execution exceeded <N>ms` | Code ran longer than `EXECUTE_TIMEOUT_MS` | Shorten the script, or raise `EXECUTE_TIMEOUT_MS` (default 60000, clamped to 5000-900000) |
| Long backtest or walkForward times out | `timeout: execution exceeded <N>ms`; walkForward needs about 660000 | Set `EXECUTE_TIMEOUT_MS` to 660000 or more (max 900000) and raise the client's tool-call timeout above it. A `trades truncated to 1000 of <N>` warning is not an error: the service caps trades at 1000 and MCP returns 20 plus `tradeCount` (see `docs/backtesting.md` sections 4-5) |
| `code exceeds 100KB limit` | `execute` code too large | Send less code |
| HTTP 413 `request body too large` | Request body over 1 MB | Send less |

Sandbox limits (`trade-mcp/src/sandbox/quickjs.ts`): memory 64 MB, stack 512 KB,
console output capped at 64 KB (extra output is dropped and the result carries
`truncated`), and the time limit above. The only globals the server adds to the
sandbox are `console` and the SDK namespaces (`market`, `account`, `trade`,
`risk`, `backtest`; `trade` is absent for the read-only token). A script with a
parse error fails with `syntax error: <message>`.

## 4. Backtests

Errors come back as `{"ok": false, "error": ...}` from `bt-service`.

| Symptom | Exact text | Cause and fix |
|---|---|---|
| Unknown interval | `openalgo does not support interval=<X>` (bt-service log) | Use `1m 3m 5m 10m 15m 30m 1h 1D` (also `D`). The service then tries other sources and often ends in `No data fetched` |
| Unknown or unmapped symbol | `openalgo history error for <SYM>@<EX>: ...` or `openalgo history HTTP <N> for <SYM>@<EX>` (log) | Symbol skipped. Use a base symbol or explicit `SYMBOL@EXCHANGE` with an exchange from NSE, BSE, NFO, BFO, CDS, BCD, MCX, CRYPTO; check it exists via `market.search` |
| Too little data | `backtest failed (exit <N>): ...`, whose tail may show `No data fetched` | The date range returned no bars (holiday-only range, symbol too new, OpenAlgo/broker session expired). Widen the range or fix section 2 |
| Bad dates | `start and end must be ISO dates (YYYY-MM-DD)` | Use `YYYY-MM-DD`, and `start` before `end` |
| Bad symbols list | `symbols must be a list of 1-20 non-empty strings` | Send 1 to 20 symbols |
| Walk-forward range too small | `range too short for one fold` | Range must hold at least `train_days` + `test_days` (train 20-3650, test 5-3650) |
| Walk-forward too heavy | `too many runs` | Folds x (candidates + 1) must be at most 60; fewer candidates or larger `test_days` |
| Walk-forward slow | `time budget exceeded` | Budget is `BT_WALKFORWARD_BUDGET_S` (default 600, 30-3600) |
| Other | `timeout`, `code exceeds 100KB`, `busy` (HTTP 429) | Simplify the strategy; retry later when another run finishes |
| trade-mcp cannot reach bt-service | HTTP 401 `unauthorized` from bt-service, or 503 `BT_TOKEN not configured` | `BT_TOKEN` must be set and identical for `trade-mcp` and `bt-service` |

## 5. agent-runner

Run the checks before the schedule:
`node dist/main.js --jobs jobs.json --check` (exit 1 if anything is missing)
and `node dist/main.js --jobs jobs.json --next 3` (next 3 run times per job;
cannot be combined with `--check`, prints `--check and --next cannot be combined`).

| Symptom | Exact text | Fix |
|---|---|---|
| CLI backend not installed or not logged in | `<bin> CLI not found — install and log in` | Install the CLI (`claude`, `codex` or `gemini`) on the host that runs agent-runner and log in once interactively |
| CLI ran but gave nothing | `CLI reported an error or produced no result` | Run the CLI by hand with the same prompt; usually an expired login |
| Windows | `<bin> on Windows: run under WSL/VPS or install the native binary (.exe)` | Run on WSL or the VPS |
| Missing API key | `--check` shows `ANTHROPIC_API_KEY: missing` (backend `api`), `OPENAI_API_KEY: missing` (`api-openai`), `GEMINI_API_KEY: missing` (`api-gemini`) | Export the key in the agent-runner environment. CLI backends do not need these |
| Missing MCP token | `MCP token env <NAME> is not set` | Export the env var named in the job's `mcp.tokenEnv` |
| Bad `jobs.json` | `jobs must be an array`, `jobs[<i>]: <message>`, e.g. `duplicate name`, `schedule.time must be HH:MM`, `invalid mcp {name,url,tokenEnv}` | Fix the named job. The MCP `url` must be http(s) for CLI backends; for `api`, `api-openai` and `api-gemini` it must be a public https URL (error `invalid mcp name, url or tokenEnv (public https url required)`) |
| Job timed out | `timeout` | Raise the job's `timeoutMs` |
| Telegram notice missing | `notify <job>: telegram skipped, TELEGRAM_BOT_TOKEN or <chatIdEnv> is missing or blank` | Set both env vars. Also seen: `notify <job>: telegram responded HTTP <N>` (bad token or chat id), `notify <job>: telegram failed: ...` (network) |

Notify never fails the job; it only logs these warnings to stderr.

## 6. Where to look

| What | Where |
|---|---|
| Service logs | `docker compose logs --tail 100 trade-mcp` (also `openalgo`, `bt-service`, `caddy`) |
| Audit log | `$DATA_DIR/audit.jsonl` (`/data/audit.jsonl` in the trade-mcp container). One JSON line per attempt with `decision` (`allowed`, `denied`, `error`) and `riskReasons`. It rotates daily (IST) or at `AUDIT_MAX_BYTES` (default 50 MB) to `audit.<YYYY-MM-DD>.jsonl`; files older than `AUDIT_RETENTION_DAYS` (default 90) are removed |
| Liveness | `GET /healthz` returns `{"ok":true,"mode":"paper"}`. Public via Caddy: `https://mcp.<DOMAIN>/healthz` |
| Readiness | `GET /readyz` returns 200 or 503 with `checks`: `openalgo`, `bt` (`not_configured` if no `BT_URL`), `auditWritable`. Internal only, not exposed by Caddy: `docker compose exec trade-mcp wget -qO- http://127.0.0.1:8787/readyz` |
| Today's counters and limits | the `risk.status()` API from an `execute` call |
| agent-runner reports | stderr of the process, plus the report file it writes per run (`job <name>: wrote <file>`) |
