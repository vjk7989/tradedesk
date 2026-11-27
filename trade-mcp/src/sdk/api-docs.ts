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
  { ns: "risk", name: "status", signature: "status(): Promise<{ mode: string; killSwitch: boolean; limits: object; today: { date: string; orders: number; notional: number } }>", doc: "Current risk limits, kill switch and today's counters." },
];
