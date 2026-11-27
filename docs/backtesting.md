# Backtesting guide

Backtests run through the MCP `execute` tool: your code calls `backtest.run(...)`
or `backtest.walkForward(...)` and the isolated `bt-service` does the work. It never
touches the broker or the risk engine. Errors for this area are in
[troubleshooting.md](troubleshooting.md) section 4.

Every example was run through `bt-service` offline (`source: "local"`) on the CSV
fixtures in `bt-service/tests/fixtures/`, with the strategy code exactly as shown.
The fixtures are synthetic, so results prove the wiring, not a strategy. For live
use drop `source` (default `"auto"`) and use real symbols and dates.

## 1. Strategy contract

Send Python that defines `class SignalEngine` with a no-argument constructor and
`generate(self, data_map)`:

- `data_map` maps each symbol to an OHLCV DataFrame (`open high low close volume`,
  datetime index).
- Return `{symbol: pd.Series}` of target weights in `[-1, 1]` (negative is short).
- Signals fill at the next bar's open.
- Constructor keyword arguments receive `params` (`signal_parameters`), which is how
  `walkForward` tries candidates.
- Static AST check: pure-compute code only; top level holds only imports, constants,
  functions and classes. Max 100KB, 1 to 20 symbols, `start` before `end`.

Call shape (inside `execute`):
```js
const r = await backtest.run({
  code, symbols: ["RELIANCE.NS"], start: "2024-01-02", end: "2024-06-14",
  interval: "1D", capital: 1000000, costs: {}, source: "auto", params: {},
});
return r;
```

Result: `ok`, `metrics`, `equity` (at most 100 points), the first 20 `trades` plus
`tradeCount`, `warnings`, `error` (null on success). Engine keys (section 4) and
`product` all go inside `costs`. Defaults: `interval` `1D`, `capital` 1,000,000.
The symbol picks the engine: `RELIANCE.NS` india_equity, `NIFTY25DECFUT@NFO`
india_fno, `NIFTY25NOV24000CE@NFO` india_options, `BTC-USDT-SWAP` crypto; mixed
symbols build a composite.

## 2. One example per engine

Each shows the strategy, then the call (`code` holds the strategy text).

### india_equity, CNC (daily, long only)

```python
# ex:eq
import pandas as pd
class SignalEngine:
    def __init__(self, fast=5, slow=20):
        self.fast = fast
        self.slow = slow
    def generate(self, data_map):
        out = {}
        for sym, df in data_map.items():
            f = df["close"].rolling(self.fast).mean()
            s = df["close"].rolling(self.slow).mean()
            out[sym] = (f > s).astype(float).where(s.notna(), 0.0)
        return out
```

```js
await backtest.run({ code, symbols: ["RELIANCE.NS"], start: "2024-01-02", end: "2024-06-14",
  costs: { product: "CNC" } });
```

CNC is the default product. Shorting is blocked unless `allow_short: true`; shares
bought today cannot be sold the same bar (T+1).

### india_equity, MIS (intraday)

```python
# ex:mis
import pandas as pd
class SignalEngine:
    def generate(self, data_map):
        out = {}
        for sym, df in data_map.items():
            m = df["close"].rolling(6).mean()
            out[sym] = ((df["close"] > m).astype(float) - 0.5).where(m.notna(), 0.0)
        return out
```

```js
await backtest.run({ code, symbols: ["RELIANCE.NS"], start: "2024-03-04", end: "2024-03-06",
  interval: "5m", costs: { product: "MIS" } });
```

MIS changes behaviour only at intraday intervals: shorting and same-day exits are
allowed, positions square off at the last bar at or before 15:20 IST (trade reason
`mis_squareoff`), bars outside 09:15 to 15:30 IST are ignored, and STT is
`in_mis_stt` on the sell side. Other products raise `unsupported product`.

### india_fno (futures, daily, whole lots)

```python
# ex:fno
import pandas as pd
class SignalEngine:
    def generate(self, data_map):
        out = {}
        for sym, df in data_map.items():
            m = df["close"].rolling(10).mean()
            out[sym] = ((df["close"] > m).astype(float) * 2 - 1).where(m.notna(), 0.0)
        return out
```

```js
await backtest.run({ code, symbols: ["NIFTY25DECFUT@NFO"], start: "2024-01-02", end: "2024-06-14",
  costs: { lot_sizes: { NIFTY: 65 }, margin_pct: 0.15 } });
```

Leverage is `1 / margin_pct`; lots are `floor(equity * |weight| * leverage / (price * lot))`.
Pass current NSE lot sizes: the built-in table is only a fallback, and an unknown
root is priced at lot 1 with a warning. Suffixes `@NFO`, `@BFO`, `@MCX`.

### india_options (long call; a short leg works the same with a negative weight)

```python
# ex:opt
import pandas as pd
class SignalEngine:
    def generate(self, data_map):
        return {sym: pd.Series(0.1, index=df.index) for sym, df in data_map.items()}
```

```js
await backtest.run({ code, symbols: ["NIFTY25NOV24000CE@NFO"], start: "2025-11-03", end: "2025-11-28",
  costs: { lot_sizes: { NIFTY: 65 } } });
```

P&L comes from the option's own premium series (no pricing model), so you must
supply data for each leg. A long pays the full premium; a short blocks
`opt_short_margin_pct` x underlying x lot x lots, where the underlying is the close
at or before entry of the series mapped by `underlying: {NIFTY: "NIFTY@NSE"}`
(include that symbol in `symbols`), else the strike. A short straddle is a CE and
a PE of one strike and expiry at weight `-0.1` each. Open options close with reason
`expiry` (monthly expiry is the last Tuesday; intrinsic value against the mapped
underlying, else the option's last price). ADR-16 covers the symbol grammar.

### crypto perpetual with funding

```python
# ex:crypto
import pandas as pd
class SignalEngine:
    def generate(self, data_map):
        out = {}
        for sym, df in data_map.items():
            sma = df["close"].rolling(10).mean()
            out[sym] = ((df["close"] > sma).astype(float) * 2 - 1).where(sma.notna(), 0.0)
        return out
```

```js
await backtest.run({ code, symbols: ["BTC-USDT-SWAP"], start: "2024-01-01", end: "2024-08-01",
  capital: 100000, costs: { leverage: 2, funding_rate: 0.0001 } });
```

Symbols ending `-PERP` or `-SWAP` get funding; a bare spot pair gets none unless a
nonzero `funding_rate` is given. Funding is a fixed rate per 8-hour settlement
(daily bars use the number of 8-hour periods in the bar). The cumulative signed
funding appears in metrics as `crypto_funding_pnl`; fee rates as `crypto_maker_rate`
and `crypto_taker_rate`. Positions can be liquidated (trade reason `liquidation`).

### Composite basket (shared capital pool)

```python
# ex:comp
import pandas as pd
class SignalEngine:
    def generate(self, data_map):
        out = {}
        for sym, df in data_map.items():
            m = df["close"].rolling(10).mean()
            out[sym] = ((df["close"] > m).astype(float) * 0.5).where(m.notna(), 0.0)
        return out
```

```js
await backtest.run({ code, symbols: ["RELIANCE.NS", "NIFTY25DECFUT@NFO"],
  start: "2024-01-02", end: "2024-06-14", costs: { lot_sizes: { NIFTY: 65 } } });
```

Each symbol is costed by its own engine (shares for equity, lots for futures and
options). Per-market product: `product_by_market: { india_equity: "MIS" }`
overrides `product`. All codes must settle in one currency, else the run fails with
`composite backtest requires one settlement currency across all codes`. Options
legs delegate lot sizing, margin and expiry to the options engine.

## 3. walkForward

Tunes `params` on each train window, freezes the winner, and scores it on the next
out-of-sample test window.

```js
const r = await backtest.walkForward({
  code, symbols: ["BTC-USDT-SWAP"], start: "2024-01-01", end: "2024-08-01",
  trainDays: 60, testDays: 30, metric: "sharpe", capital: 100000,
  candidates: [{ fast: 5, slow: 20 }, { fast: 10, slow: 30 }, { fast: 20, slow: 50 }],
});
return r;
```

Strategy:
```python
# ex:wf
import pandas as pd
class SignalEngine:
    def __init__(self, fast=10, slow=30):
        self.fast = fast
        self.slow = slow
    def generate(self, data_map):
        out = {}
        for sym, df in data_map.items():
            f = df["close"].rolling(self.fast).mean()
            s = df["close"].rolling(self.slow).mean()
            out[sym] = ((f > s).astype(float) * 2 - 1).where(s.notna(), 0.0)
        return out
```

- Windows are calendar days: `trainDays` 20 to 3650, `testDays` 5 to 3650. Folds
  start at `start` and step forward by `testDays`; the last window must end by `end`.
- `candidates`: 1 to 10 objects. `metric`: `sharpe` (default), `total_return`, `calmar`.
- Budget: folds x (candidates + 1) runs, at most 60; time budget 600 s by default
  (`BT_WALKFORWARD_BUDGET_S`, clamped 30 to 3600).

Reading the result:

- `folds[i].train` and `.test` are `[start, end)` date pairs; `chosen` is the
  candidate that scored best on train; `trainScore` is that score; `testMetrics`
  is the full metric set for the frozen candidate on unseen data.
- Large `trainScore` with weak `testMetrics[metric]` means overfit parameters.
- `summary`: `folds`, `scored_folds`, `mean_test_<metric>`, `positive_folds`.
- `oosEquity` chains the test windows (each rescaled to start where the last
  ended), at most 100 points. Warnings are prefixed `fold <i>:`.

## 4. Reference

### Cost keys

All keys are optional and go in `costs`. Rates are fractions of notional.

| Engine | Keys and defaults |
|---|---|
| india_equity | `slippage` 0.001, `in_brokerage` 0.0, `in_stt` 0.001 (buy and sell), `in_exchange_txn` 0.0000297, `in_sebi_fee` 0.000001, `in_stamp_duty` 0.00015 (buy), `in_gst` 0.18, `in_dp_charge` 0.0 (flat, sell), `in_mis_stt` 0.00025 (sell), `in_mis_stamp_duty` 0.00003 (buy), `allow_short` false, `price_limit` 0.20, `product` CNC or MIS |
| india_fno | `margin_pct` 0.15, `slippage` 0.0005, `lot_sizes` (fallback NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120), `in_fno_brokerage` 20.0 (flat INR per order), `in_fno_stt` 0.0005 (sell), `in_fno_exchange_txn` 0.0000183, `in_fno_sebi_fee` 0.000001, `in_fno_stamp_duty` 0.00002 (buy), `in_fno_gst` 0.18, `product` NRML or MIS |
| india_options | `opt_short_margin_pct` 0.15, `slippage` 0.0005, `lot_sizes`, `underlying` (`{ROOT: symbol}`), `in_opt_brokerage` 20.0 (flat), `in_opt_stt` 0.0015 (sell, premium), `in_opt_exchange_txn` 0.0003503, `in_opt_sebi_fee` 0.000001, `in_opt_stamp_duty` 0.00003 (buy), `in_opt_gst` 0.18 |
| crypto | `leverage` 1.0, `maker_rate` 0.0002 (closes), `taker_rate` 0.0005 (opens), `commission` (fallback for both, unset), `slippage` 0.0005, `funding_rate` 0.0001 per settlement, `margin_mode` isolated or cross |

Verify current Indian tariffs and lot sizes; the code says so too.
Invalid values raise errors such as `margin_pct must be in (0, 1]`,
`opt_short_margin_pct must be in (0, 1]` or `leverage must be a finite number > 0`.

### Intervals

`1m 3m 5m 10m 15m 30m 1H 4H 1D 1W 1M`. `1h`, `1d`, `1w` are folded to upper case;
`5M` is rejected (minute and month differ). The OpenAlgo loader supports
`1m 3m 5m 10m 15m 30m 1h 1D` (and `D`); `4H`, `1W`, `1M` need another source.
Anything else fails with `unsupported interval`. India sessions: 09:15 to 15:30 IST
(MCX 09:00 to 23:30); MIS square-off 15:20 (MCX 23:20).

### Known simplifications

- Equity: one circuit band for all scrips; lot 1. F&O: flat `margin_pct`, no SPAN.
- Options: premium series only, no greeks or pricing model; the monthly expiry is
  the last Tuesday with no holiday shift; expiry-close STT uses the sell rate
  (a simplification versus real ITM expiry STT); SENSEX has no built-in lot size.
- Crypto: funding is a fixed rate unless `perpetual_strict` with
  `funding_mode: "data"`; fills and liquidation are simplified.
- Composite: one currency, no FX translation.
- Result caps: the service keeps 500 equity points and 1000 trades
  (`equity downsampled to 500 points`); MCP cuts to 100 and 20.

## 5. Limits and timeouts

`execute` stops at `EXECUTE_TIMEOUT_MS` (default 60 s); raise it to at least 660000
for walk-forward. Service errors: `backtest service busy, retry later`,
`backtest service not configured`.

## 6. Running examples offline

`bt-service` reads CSVs through the local loader when `source: "local"` and
`BT_LOCAL_DATA_CONFIG` points at a YAML file:

```yaml
sources:
  - symbol: "NIFTY25DECFUT@NFO"
    type: csv
    path: "bt-service/tests/fixtures/niftyfut_1d.csv"
    date_format: "%Y-%m-%d"
```

Set `BT_RUNS_DIR`, `VIBE_TRADING_DATA_CACHE=false`, then call
`bt_service.run_backtest(code, symbols, start, end, source="local", costs=...)`.
Fixtures: `RELIANCE.NS` is `aapl.csv` (daily) or `reliance_5m.csv` (5m; add
`columns: {date: timestamp}`), crypto `btc_1d.csv`, options `nifty_opt_1d.csv`.
