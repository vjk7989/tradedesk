# PB-1 · paper-bot · rule-based crypto paper trader + dashboard (core)
Branch: own/PB-1        Base: main        Owner: OWNER        Priority: HIGH (the user wants to see it live)

## Goal
The user wants a crypto paper-trading bot running on the VPS, and a web dashboard showing every **decision** (including "no trade, and why") and every **trade**, plus positions, P&L and an equity curve. No AI, no Delta API key yet: use Delta Exchange **public** market data and simulate fills locally.

## Contract (PB-2 wires this up in deploy; don't change it)
- New top-level package `paper-bot/`: Python 3.12, managed by uv. **Generate uv.lock with uv 0.9.26** (`uvx --from uv==0.9.26 uv lock`), per the bt-service rule.
- One process does both jobs: an asyncio loop runs the strategy on a timer, and FastAPI + uvicorn serves the dashboard on **0.0.0.0:8090**.
- Data in SQLite at `${DATA_DIR:-/data}/paper.db`.
- `paper-bot/Dockerfile`: `python:3.12-slim`, uv 0.9.26 (`ghcr.io/astral-sh/uv:0.9.26`), `uv sync --frozen`, non-root user, CMD runs the app.
- `GET /healthz` returns `{ok:true}`. The dashboard is at `/`. JSON is at `/api/decisions`, `/api/trades`, `/api/positions`, `/api/equity` and `/api/summary`.
- **No auth inside the app.** Caddy basic-auth sits in front (PB-2).

## Strategy (all configurable via env, with these defaults)
- `SYMBOLS=BTCUSD,ETHUSD` (Delta India perpetuals), `RESOLUTION=5m`, `INTERVAL_SEC=300`.
- SMA crossover: `FAST=20`, `SLOW=50`, computed on **closed candles only**. Drop the still-forming candle, so there is no look-ahead.
- Signals:
  - fast crosses above slow → go LONG;
  - fast crosses below slow → go SHORT if `ALLOW_SHORT=true` (the default), else go FLAT;
  - no cross → HOLD.
- Sizing: `NOTIONAL_USD=1000` per position. Quantity = notional / price (fractional is fine for paper). `START_CAPITAL_USD=10000`.
- Costs: `TAKER_FEE=0.0005` and `SLIPPAGE=0.0002`, both applied on every fill.
- Reversal: close the existing position, then open the opposite one. That is 2 trade rows with realised P&L on the close.
- Each tick writes **one decision row per symbol**: ts, symbol, candle_time, close, fast, slow, signal, action, reason. The reason is human-readable, e.g. "fast 64210.5 crossed above slow 64180.2 → open long" or "no cross (fast < slow by 0.3%) → hold". Also write an equity snapshot: cash, unrealised and total.
- Data errors (timeouts, non-200, empty or malformed candles) → a decision row with action `skip` and reason `data error: <short>`. The loop never crashes. Use a per-request timeout of 10 s.
- Restart-safe: positions, cash and history come from SQLite. A restarted bot must not double-trade the same candle; track `last_candle_time` per symbol.

## Market data
Use the Delta Exchange India public candles endpoint, which needs no key. **Verify the exact URL, params and response shape first** with a real request: it is likely `https://api.india.delta.exchange/v2/history/candles?symbol=BTCUSD&resolution=5m&start=<unix>&end=<unix>`. Record the real shape in the report. Make the base URL configurable (`DELTA_BASE_URL`). Fetch enough history for SLOW+2 closed candles.

## Dashboard (server-rendered HTML; no external CDN except maybe one pinned chart lib; prefer inline SVG)
- **Header:** mode "PAPER", symbols, strategy params, last tick time, next tick ETA, and a health indicator.
- **Summary cards:** equity, total P&L (₹ and %), realised and unrealised, number of trades, win rate, max drawdown.
- **Open positions table:** symbol, side, qty, entry, mark, unrealised P&L.
- **Equity curve:** an inline SVG line.
- **Decisions table:** the latest 200, newest first, with colour per action. Filter by symbol and action via a query param.
- **Trades table:** all trades, newest first, with realised P&L.
- Auto-refresh every 30 s. It must work on a phone (responsive). It must never show secrets or env values.

## Tests (pytest, no network; use fixture candles)
- Crossover detection: up, down and no-cross.
- No look-ahead: the forming candle is ignored.
- Fee, slippage and P&L maths for long, short and reversal.
- Restart restores state and doesn't double-trade.
- Data-error paths: skip rows, and the loop survives.
- The dashboard renders with empty and populated DBs.
- The API endpoints return the right JSON.
- Equity and drawdown maths.

## Verify
`cd paper-bot && uvx --from uv==0.9.26 uv sync && uv run pytest -q`. Also `docker build` if Docker is available. Do one live smoke test locally: run for 1 tick against the real Delta API with `INTERVAL_SEC=5`, then show the decision rows.
