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
].join("\n");

const BACKTEST_NOTE = [
  "Backtest a strategy in the isolated backtest service (never touches the broker or risk engine; each call is audited with code length and sha256 only). Throws 'backtest service not configured' if unavailable; 'busy, retry later' when the service is saturated.",
  "Strategy contract: python code defining `class SignalEngine` with a no-argument constructor and `def generate(self, data_map: dict[str, pd.DataFrame]) -> dict[str, pd.Series]`. data_map maps each symbol to an OHLCV DataFrame (open, high, low, close, volume; datetime index). Return, per symbol, a Series of target weights in [-1, 1] (negative = short). Signals are executed at the next bar's open.",
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
  { ns: "trade", name: "place", signature: `place(args: { ${ORDER} }): Promise<unknown>`, doc: "Place an order after risk checks (price from limit or LTP). LIMIT/SL need price; SL/SL-M need triggerPrice. Throws on risk denial. Paper mode requires OpenAlgo analyzer ON. " + CRYPTO_NOTE },
  { ns: "trade", name: "modify", signature: `modify(args: { orderId: string; ${ORDER} }): Promise<unknown>`, doc: "Modify an open order; same risk checks, does not count as a new order." },
  { ns: "trade", name: "cancel", signature: "cancel(args: { orderId: string }): Promise<unknown>", doc: "Cancel an order. Allowed even when the kill switch is on." },
  { ns: "trade", name: "closePosition", signature: "closePosition(args?: {}): Promise<unknown>", doc: "Square off all open positions. Allowed even when the kill switch is on." },
  { ns: "backtest", name: "run", signature: "run(args: { code: string; symbols: string[]; start: string; end: string; interval?: string; capital?: number; costs?: object; source?: string; params?: object }): Promise<{ ok: boolean; metrics: object; equity: { date: string; value: number | null }[]; trades: object[]; tradeCount: number; warnings: string[]; error: string | null }>", doc: BACKTEST_NOTE },
  { ns: "risk", name: "status", signature: "status(): Promise<{ mode: string; killSwitch: boolean; limits: object; today: { date: string; orders: number; notional: number } }>", doc: "Current risk limits, kill switch and today's counters." },
];
