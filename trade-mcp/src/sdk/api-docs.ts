export interface ApiDoc {
  ns: string;
  name: string;
  signature: string;
  doc: string;
}

export const CRYPTO_NOTE = [
  "Crypto (Delta via OpenAlgo): exchange \"CRYPTO\" (Delta Exchange is OpenAlgo's only crypto broker); futures, perpetuals and options only.",
  "Symbols: option BTC28FEB2580000CE (underlying+DDMONYY+strike+CE|PE); dated future BTC28FEB25FUT; perpetual is the Delta symbol plus FUT per the master-contract code (e.g. BTCUSDFUT; its docs also mention BTCUSD.P) - confirm with market.search({query:\"BTCUSD\", exchange:\"CRYPTO\"}).",
  "Product: Delta has no CNC/NRML/MIS distinction (the value is passed through), but risk requires it to be in allowedProducts, so use NRML or MIS as configured.",
  "Quantity is a whole number of contracts for derivatives, NOT units of the underlying; each contract = contract_value units (e.g. 0.01 ETH for ETHUSD perpetual). Notional is therefore qty * contract_value * price; the risk engine uses qty * contractValues[SYMBOL] * price, defaulting contract_value to 1 when unset - set contractValues in risk.json for accurate USD caps.",
  "Risk: per-order cap is maxNotionalPerOrderUsd (not INR); CRYPTO trades 24x7 so market hours never block it.",
].join("\n");

export const API_HEADER = [
  "Code is the body of an async JS function: use `await`, `return` a value, and console.log for output.",
  "Arguments are plain objects. Symbols use OpenAlgo format, e.g. RELIANCE / NSE, NIFTY28NOV2524000CE / NFO, BTC28FEB2580000CE / CRYPTO.",
  CRYPTO_NOTE,
  "Risk violations are thrown as Error('risk denied: ...'); nothing is placed in that case.",
  "Optional risk cap maxShortOptionQtyPerOrder (off when unset) limits the quantity of NFO/BFO CE/PE SELL orders; a SELL that closes a long is capped too (conservative), and a breach is denied with 'short option qty <q> exceeds maxShortOptionQtyPerOrder <n>'.",
  "Kill switch: while it is on (the KILL file exists), new orders and modifications are refused with 'risk denied: kill switch active'; cancel and closePosition (the risk-reducing calls) are still allowed; risk.status().killSwitch shows the state.",
].join("\n");

const BACKTEST_NOTE = [
  "Backtest a strategy in the isolated backtest service (never touches the broker or risk engine; each call is audited with code length and sha256 only). Throws 'backtest service not configured' if unavailable; 'backtest service busy, retry later' when the service is saturated.",
  "Strategy contract: python code defining `class SignalEngine` with a no-argument constructor and `def generate(self, data_map: dict[str, pd.DataFrame]) -> dict[str, pd.Series]`. data_map maps each symbol to an OHLCV DataFrame (open, high, low, close, volume; datetime index). Return, per symbol, a Series of target weights in [-1, 1] (negative = short). Signals are executed at the next bar's open.",
  "F&O futures (daily bars only): symbols like NIFTY25DECFUT@NFO (suffix @NFO, @BFO or @MCX) run on the india_fno engine (FUT stays there). Positions are whole lots. costs keys: lot_sizes {ROOT: int} (root = symbol without expiry/FUT, e.g. NIFTY; built-in fallback is NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120 per NSE circular NSE/FAOP/70616 (Jan 2026 series, verified Nov 2026) and NSE lot sizes are revised, so VERIFY and pass current ones; an unknown root is priced at lot 1 with a warning), margin_pct (default 0.15, leverage = 1/margin_pct), slippage (default 0.0005), and fee overrides in_fno_brokerage (flat INR per order, 20), in_fno_stt (0.0005, sell side, Finance Act 2026 effective 1 Apr 2026), in_fno_exchange_txn (0.0000183), in_fno_sebi_fee (0.000001), in_fno_stamp_duty (0.00002, buy side), in_fno_gst (0.18). Verify current fee rates too (rates verified Nov 2026).",
  "F&O options (daily bars only): <ROOT><expiry><strike>CE|PE@NFO|BFO (weekly DDMONYY or monthly YYMON expiry) run on the india_options engine, also in composite baskets; P&L is in premium terms. Lots come from lot_sizes (same fallback table). Premium cost keys (VERIFY current rates): in_opt_brokerage (INR 20 per order), in_opt_stt (0.0015, sell side), in_opt_exchange_txn (0.0003503), in_opt_sebi_fee (0.000001), in_opt_stamp_duty (0.00003, buy side), in_opt_gst (0.18). Short margin is opt_short_margin_pct (default 0.15) x underlying close x lot, with the underlying mapped via underlying: {ROOT: \"<symbol>\"} (fallback strike x lot); long margin is the premium. Expiry settles at intrinsic value (else last option close), trade reason expiry, through the normal cost stack: a long expiring pays in_opt_stt on intrinsic value (closing sell), a short pays stamp duty (closing buy). Monthly expiry is the last Tuesday, with no shift when that day is a market closure (VERIFY).",
  "Crypto costs keys: leverage (default 1), maker_rate (0.0002), taker_rate (0.0005), slippage (0.0005), commission (fallback for both fee sides; explicit maker_rate/taker_rate win), funding_rate (fixed rate per settlement, default 0.0001). Symbols ending -PERP or -SWAP get funding; bare spot pairs get none unless a nonzero funding_rate is given.",
  "Code rules (static AST check; a denylist, not an allowlist): use pandas, numpy, math and similar pure-compute libraries. Rejected: importing or using socket, subprocess, urllib, http, requests, httpx, aiohttp, ftplib, smtplib, multiprocessing, ctypes, importlib, builtins, sys, pickle, shutil, gc; eval/exec/compile/__import__/globals/locals/vars/breakpoint; os.system/popen and file writes; dunder attribute escapes (__class__, __subclasses__, __globals__ ...). Top-level code may only be imports, constants, functions and classes (no executable statements). Max 100KB, 1-20 symbols, start < end (YYYY-MM-DD).",
  "Symbols: Indian equities RELIANCE.NS (NSE) / 500325.BO (BSE); explicit OpenAlgo form SYMBOL@EXCHANGE, e.g. NIFTY28NOV2524000CE@NFO or BTC28FEB2580000CE@CRYPTO; crypto spot/perp via the binance/okx loaders, e.g. BTCUSDT. interval: 1m,3m,5m,10m,15m,30m,1H,1D (default 1D). source: 'auto' (default) or a loader name. capital defaults to 1,000,000. params are passed to the engine as signal_parameters.",
  "Result: metrics, equity (downsampled to <=100 points), first 20 trades plus tradeCount, warnings, error (null on success).",
  "Example code:",
  "import pandas as pd",
  "class SignalEngine:",
  "    def __init__(self, fast=20, slow=50):",
  "        self.fast = fast",
  "        self.slow = slow",
  "    def generate(self, data_map):",
  "        out = {}",
  "        for sym, df in data_map.items():",
  "            f = df['close'].rolling(self.fast).mean()",
  "            s = df['close'].rolling(self.slow).mean()",
  "            out[sym] = (f > s).astype(float).where(s.notna(), 0.0)",
  "        return out",
  "Long backtests also count against EXECUTE_TIMEOUT_MS (default 60 s); raise it if they time out.",
].join("\n");

const WALKFORWARD_NOTE = [
  "Walk-forward validation: signal parameters are tuned on each train window only and frozen for the following out-of-sample test window. Never touches the broker or risk engine; each call is audited with code length and sha256 only. Throws 'backtest service not configured' if unavailable; 'backtest service busy, retry later' when the service is saturated.",
  "trainDays >= 20 and testDays >= 5 are calendar days. candidates is 1-10 parameter objects (passed to the engine as signal_parameters); at most 60 backtest runs in total; the server enforces a 10-minute budget. metric is one of sharpe, total_return, calmar (default sharpe).",
  "Note: execute has a time limit (EXECUTE_TIMEOUT_MS, default 60 s); for walk-forward the operator should set EXECUTE_TIMEOUT_MS >= 660000, and your MCP client may have its own tool-call timeout.",
  "Result: metric, folds (train/test dates, chosen params, trainScore, testMetrics), oosEquity (chained out-of-sample equity, downsampled to <=100 points), summary (folds, scored_folds, mean_test_<metric>, positive_folds), warnings, error (null on success). On ok:false, `folds` holds only the folds completed before the failure (possibly empty); summary and oosEquity are empty; check ok and error.",
].join("\n");

const ORDER =
  "symbol: string; exchange: string; side: 'BUY'|'SELL'; quantity: number; product: 'CNC'|'NRML'|'MIS'; priceType: 'MARKET'|'LIMIT'|'SL'|'SL-M'; price?: number; triggerPrice?: number";

export const API_DOCS: ApiDoc[] = [
  { ns: "market", name: "quote", signature: "quote(args: { symbol: string; exchange: string }): Promise<unknown>", doc: "Real-time quote (ltp, OHLC, bid/ask, volume)." },
  { ns: "market", name: "depth", signature: "depth(args: { symbol: string; exchange: string }): Promise<unknown>", doc: "Market depth (5 levels bid/ask)." },
  { ns: "market", name: "history", signature: "history(args: { symbol: string; exchange: string; interval: string; start: string; end: string }): Promise<unknown>", doc: "Historical candles; interval like 1m, 5m, D; dates YYYY-MM-DD." },
  { ns: "market", name: "search", signature: "search(args: { query: string; exchange?: string }): Promise<unknown>", doc: "Search instruments by text." },
  { ns: "market", name: "optionChain", signature: "optionChain(args: { underlying: string; exchange: string; expiry?: string; strikeCount?: number; withGreeks?: boolean }): Promise<unknown>", doc: "Option chain around ATM for an underlying and expiry (e.g. 28NOV25)." },
  { ns: "account", name: "funds", signature: "funds(): Promise<unknown>", doc: "Account funds and margins." },
  { ns: "account", name: "positions", signature: "positions(): Promise<unknown>", doc: "Open positions (position book)." },
  { ns: "account", name: "holdings", signature: "holdings(): Promise<unknown>", doc: "Delivery holdings." },
  { ns: "account", name: "orders", signature: "orders(): Promise<unknown>", doc: "Order book for today." },
  { ns: "account", name: "trades", signature: "trades(): Promise<unknown>", doc: "Trade book for today." },
  { ns: "trade", name: "place", signature: `place(args: { ${ORDER} }): Promise<unknown>`, doc: "Place an order after risk checks (price from limit or LTP). LIMIT/SL need price; SL/SL-M need triggerPrice. Throws on risk denial. Optional risk cap maxShortOptionQtyPerOrder limits NFO/BFO CE/PE SELL qty (off when unset; also caps a SELL that closes a long), denied with 'short option qty <q> exceeds maxShortOptionQtyPerOrder <n>'. Paper mode requires OpenAlgo analyzer ON. " + CRYPTO_NOTE },
  { ns: "trade", name: "modify", signature: `modify(args: { orderId: string; ${ORDER} }): Promise<unknown>`, doc: "Modify an open order; same risk checks, does not count as a new order." },
  { ns: "trade", name: "cancel", signature: "cancel(args: { orderId: string }): Promise<unknown>", doc: "Cancel an order. Allowed even when the kill switch is on." },
  { ns: "trade", name: "closePosition", signature: "closePosition(args?: {}): Promise<unknown>", doc: "Square off all open positions. Allowed even when the kill switch is on." },
  { ns: "backtest", name: "run", signature: "run(args: { code: string; symbols: string[]; start: string; end: string; interval?: string; capital?: number; costs?: object; source?: string; params?: object }): Promise<{ ok: boolean; metrics: object; equity: { date: string; value: number | null }[]; trades: object[]; tradeCount: number; warnings: string[]; error: string | null }>", doc: BACKTEST_NOTE },
  { ns: "backtest", name: "walkForward", signature: "walkForward(args: { code: string; symbols: string[]; start: string; end: string; trainDays: number; testDays: number; candidates: object[]; metric?: 'sharpe' | 'total_return' | 'calmar'; interval?: string; capital?: number; costs?: object; source?: string }): Promise<{ ok: boolean; metric: string | null; folds: { train: string[]; test: string[]; chosen: object; trainScore: number | null; testMetrics: object }[]; oosEquity: { date: string; value: number | null }[]; summary: object; warnings: string[]; error: string | null }>", doc: WALKFORWARD_NOTE },
  { ns: "audit", name: "recent", signature: "recent(args?: { limit?: number }): Promise<{ entries: object[]; skipped: number }>", doc: "Last N audit-log entries (limit integer 1-200, default 20; out-of-range or non-integer limits are rejected), newest last, as stored (already redacted). Reads only the last ~1 MB of the current audit file (topped up from the newest rotated file if it holds fewer than limit); configured secret values are scrubbed to [REDACTED]; Always returns { entries, skipped }: entries is [] if the file is missing or empty; skipped counts corrupt lines left out. Read-only; the call itself is audited." },
  { ns: "risk", name: "status", signature: "status(): Promise<{ mode: string; killSwitch: boolean; limits: { allowedExchanges: string[]; allowedProducts: string[]; symbolAllow: string[]; symbolDeny: string[]; maxQtyPerOrder: number; maxNotionalPerOrder: number; maxNotionalPerOrderUsd: number; maxOrdersPerDay: number; maxNotionalPerDay: number; maxDailyLoss: number; maxOrdersPerRun: number; maxShortOptionQtyPerOrder: number | null; contractValues: number; marketHolidays: { NSE: number; MCX: number; nextNSE: string | null } }; today: { date: string; orders: number; notional: number; remainingOrders: number; remainingNotional: number } }>", doc: "Every active risk limit (unset optional limits are null; contractValues and marketHolidays are summarised as counts, nextNSE is the next NSE holiday), kill switch, and today's counters with remainingOrders/remainingNotional (never negative; CRYPTO is not counted in INR notional)." },
];
