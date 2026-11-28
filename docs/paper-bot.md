# paper-bot operator guide

paper-bot is a small crypto strategy simulator that ships in this stack. It is **PAPER ONLY**: it holds no exchange keys, places no real orders, and the dashboard shows a `PAPER` badge. It is not financial advice.

## What it does

- Every candle close it fetches Delta India **public** candles (`/v2/history/candles`) for each symbol.
- Strategy: SMA crossover. Fast SMA crossing above slow goes long. Fast crossing below slow goes short, or flat if `ALLOW_SHORT` is off.
- Fills are simulated: slippage always worsens the price, and a taker fee is charged on every open and close. Each trade is sized at `NOTIONAL_USD`.
- State lives in SQLite (`paper.db`) on the `paper_bot_data` volume.

## Network: outbound access is required

paper-bot must reach `DELTA_BASE_URL` to fetch candles. In `deploy/docker-compose.yml` it sits on both `internal` (an `internal: true` network with no outbound route, used by Caddy to reach it) and `egress` (added in PB-3). If the `egress` network is removed, every fetch fails and the bot never trades.

What that failure looks like: the dashboard shows no trades, and the Decisions table fills with `skip` rows (red tag) whose reason is `data error: <ExceptionName> <message>` (for example `data error: ConnectError ...`, or `data error: http 403`). The header turns `STALE` once no tick has completed for `2 x INTERVAL_SEC + 30` seconds. The container log stays quiet, because data errors are recorded as decisions, not logged.

## Configuration

Set these in `deploy/.env` (compose passes them through). The code default applies when a variable is absent; compose supplies its own defaults, shown in the last column.

| Variable | Code default | Compose default | Rule (startup validation) |
|---|---|---|---|
| `SYMBOLS` | `BTCUSD,ETHUSD` | same | comma list, must not be empty |
| `RESOLUTION` | `5m` | `5m` | one of `1m 3m 5m 15m 30m 1h 2h 4h 6h 1d` |
| `INTERVAL_SEC` | `300` | `300` | integer >= 1; keep >= the candle period so ticks align to candle close |
| `FAST` | `20` | `9` | integer >= 1 and < `SLOW` |
| `SLOW` | `50` | `21` | integer >= 2 |
| `ALLOW_SHORT` | on | `0` (off) | `1`, `true` or `yes` = on; anything else = off |
| `NOTIONAL_USD` | `1000` | `1000` | > 0 |
| `START_CAPITAL_USD` | `10000` | `10000` | > 0 |
| `TAKER_FEE` | `0.0005` | `0.0005` | 0 <= value < 0.1 (a fraction: 0.0005 = 0.05%) |
| `SLIPPAGE` | `0.0002` | `0.0002` | 0 <= value < 0.1 |
| `DELTA_BASE_URL` | `https://api.india.delta.exchange` | same | trailing `/` stripped |

Other: `DATA_DIR` defaults to `/data` and the HTTP port to `8090`. The compose memory cap is `PAPER_BOT_MEM_LIMIT` (default `256m`).

Because the compose defaults differ from the code defaults, the deployed bot runs SMA 9/21 with shorting off unless you override them. The dashboard header always shows the live values.

An invalid value stops the container at startup with `invalid config: ...` listing every problem (for example `FAST=30 must be < SLOW=21`); a bad `RESOLUTION` fails with `invalid RESOLUTION '...'; valid values: ...`. A non-numeric number raises a Python `ValueError`. Check `docker compose logs paper-bot`.

## Dashboard login

The app has no login of its own. Caddy serves it at `https://dash.<your-domain>` behind HTTP basic auth, using `DASH_USER` (default `admin`) and `DASH_PASSWORD_HASH` (a bcrypt hash, not the password).

If `DASH_PASSWORD_HASH` is unset, compose falls back to a hash of a discarded random secret, so the dashboard stays locked until you set your own.

Generate a hash (this is the command in `deploy/.env.example`; it needs Docker):

```
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'your-password'
```

If you have Python with the `bcrypt` package instead, this produces a compatible `$2b$12$...` hash:

```
python3 -c "import bcrypt;print(bcrypt.hashpw(b'your-password',bcrypt.gensalt(12)).decode())"
```

Put the result in `deploy/.env` in **single quotes**, so compose does not interpolate the `$` signs:

```
DASH_USER=admin
DASH_PASSWORD_HASH='$2a$14$...'
```

Then `docker compose up -d caddy` (from `deploy/`). Never commit `deploy/.env`. Typed commands land in your shell history, so clear it or prefix the line with a space if your shell supports that.

## Reading the dashboard

The page refreshes itself every 30 seconds. All times are UTC (`Z`).

- **Header**: symbols, resolution, `SMA fast/slow`, notional, fee and slippage, short on/off. A green dot and `healthy` mean the last tick is recent; a red dot and `STALE` mean it is not. It also shows `last tick` and `next ~` (the expected next tick).
- **Cards**: Equity (cash plus unrealised); Total P&L (amount and % of start capital); Realised; Unrealised; Trades (all fills, opens and closes); Win rate (closed trades with positive P&L, `-` if none); Max drawdown (peak-to-trough of equity, starting from start capital).
- **Open positions**: symbol, side, qty, entry (fill price after slippage), mark (last closed candle close) and unrealised P&L. `flat` means none.
- **Equity curve**: line of total equity per tick, with min/max below it. It shows `no equity data yet` until two ticks exist.
- **Decisions (latest 200)**: one row per symbol per tick, with time, candle, close, fast and slow SMA, signal, action and reason. Filter by symbol and by action, then press Filter.
- **Trades**: every fill, newest first. `Kind` is `open` or `close`; `Realised P&L` is filled on closes and is net of both fees.

Actions in Decisions:

| Action | Meaning |
|---|---|
| `open` | opened a position |
| `close` | closed it (a down cross with shorting off) |
| `reverse` | closed one side and opened the other |
| `hold` | nothing to do (no cross, already in that position, or the candle was already processed) |
| `skip` | no decision: `data error: ...` or `internal error: ...` |

Read-only JSON endpoints, behind the same login: `/api/summary`, `/api/positions`, `/api/trades`, `/api/equity`, and `/api/decisions?limit=N` (1 to 1000, default 200). `/healthz` returns `{"ok": true}` and is used by the container healthcheck.

## Operations

Run these from `deploy/`.

- **Logs**: `docker compose logs -f --tail=200 paper-bot`. Only startup, unexpected exceptions (`tick error <symbol>`, `tick failed`, `snapshot error`) and HTTP access lines appear; ordinary data errors are visible in Decisions.
- **Restart**: `docker compose restart paper-bot`. The service is `restart: unless-stopped`. Cash, positions, trades, decisions and equity persist in `paper.db`, so a restart resumes where it left off, and a candle already handled is not traded twice.
- **Changing capital**: cash is stored in the database the first time the bot starts, so changing `START_CAPITAL_USD` later does not change cash (the P&L baseline does change). Reset the account to start clean.
- **Reset the paper account** (this deletes all history):

```
docker compose stop paper-bot
docker compose rm -f paper-bot
docker volume ls | grep paper_bot_data     # shows <project>_paper_bot_data, e.g. deploy_paper_bot_data
docker volume rm <project>_paper_bot_data
docker compose up -d paper-bot
```

The volume is `paper_bot_data` in compose; Docker prefixes it with the compose project name (the directory name, `deploy`, unless you set `-p` or `COMPOSE_PROJECT_NAME`). The container must be removed first or the volume is still in use.

## Limits and behaviour

- **Closed candles only**: the still-forming candle is dropped, and duplicate candle times keep the latest copy. A decision needs `SLOW + 1` closed candles, otherwise the symbol is skipped with `data error: only N closed candles`.
- **Candle-aligned ticks**: with `INTERVAL_SEC` >= the candle period, the bot wakes 5 seconds after each candle boundary. With a smaller `INTERVAL_SEC` it sleeps that long instead and the extra ticks only record `candle <t> already processed → hold` (for smoke and debug runs).
- **Data errors skip, not fail**: an HTTP error, timeout, malformed or empty response, or a non-positive or non-finite price records a `skip` row for that symbol and the next tick retries. Other symbols are unaffected.
- One position per symbol, fixed notional, market fills at the candle close with slippage. There is no stop loss, no funding and no margin model.

## Moving beyond paper

paper-bot cannot trade live. Live trading goes through OpenAlgo and the trade-mcp risk layer, and requires the going-live checklist in [vps-runbook.md](vps-runbook.md) section 10 first.

Not financial advice. Simulated results ignore real-world liquidity, latency and outages.
