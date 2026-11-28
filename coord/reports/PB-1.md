# PB-1 report: paper-bot (rule-based crypto paper trader + dashboard)

Branch own/PB-1. Package `paper-bot/` (Python 3.12, uv 0.9.26 lock, fastapi, uvicorn, httpx; pytest dev).

## Delta India candles API (verified with real curl, 2026-11-28)
`GET https://api.india.delta.exchange/v2/history/candles?symbol=BTCUSD&resolution=5m&start=<unix>&end=<unix>` -> 200, no key.
- `resolution` must be one of `5s,1m,3m,5m,15m,30m,1h,2h,4h,6h,1d,1w`. Bare `5` gives 400 `bad_schema`.
- Body: `{"success":true,"result":[{"time":1795837800,"open":..,"high":..,"low":..,"close":59928.0,"volume":9137.0}, ...]}`
- `result` is **newest first**. `time` is the candle **open** time in unix seconds. The newest row can be the forming candle, so the bot keeps only candles with `time + period <= now`.

## Behaviour
- Port 8090, `/healthz`, `/`, `/api/{decisions,trades,positions,equity,summary}`, SQLite at `${DATA_DIR:-/data}/paper.db`. No auth, no env values rendered.
- One decision row per symbol per tick (reason text included). Data errors become `skip` / `data error: <short>` rows. The loop catches everything.
- Restart-safe: positions, cash and `last_candle:<symbol>` live in SQLite. A repeat of the same candle writes a `hold` row ("already processed") and no trade.
- Realised P&L on a close row is net of both entry and exit fees. Cash is debited the entry fee at open.
- A tick needs SLOW+1 closed candles (the crossover compares the last two bars). With fewer it writes a `skip` row.
- Currency shown as `$` (capital is USD). The brief's "₹" looked like a slip; say if you want INR.

## Verify
- `cd paper-bot && uv run pytest -q` -> 17 passed.
- Live smoke (INTERVAL_SEC=5, real Delta API, 2 ticks); `/api/decisions`:
```
{id:3, symbol:BTCUSD, candle_time:1795838100, close:60000.5, fast:59968.425, slow:60010.33, signal:hold, action:hold, reason:"candle 1795838100 already processed → hold"}
{id:2, symbol:ETHUSD, candle_time:1795838100, close:1665.25, fast:1664.3275, slow:1665.276, signal:hold, action:hold, reason:"no cross (fast below slow by 0.06%) → hold"}
{id:1, symbol:BTCUSD, candle_time:1795838100, close:60000.5, fast:59968.425, slow:60010.33, signal:hold, action:hold, reason:"no cross (fast below slow by 0.07%) → hold"}
```
- `/` returned HTML, `/healthz` `{"ok":true}`, `/api/summary` equity 10000.
- Docker build: NOT run. The Docker CLI is installed but the daemon is not running on this machine. The Dockerfile is untested.
