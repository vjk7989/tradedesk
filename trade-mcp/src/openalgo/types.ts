export type Action = "BUY" | "SELL";
export type PriceType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type Product = "CNC" | "NRML" | "MIS";

export interface SymbolExchange {
  symbol: string;
  exchange: string;
}
export interface HistoryRequest extends SymbolExchange {
  interval: string;
  start_date: string;
  end_date: string;
}
export interface SearchRequest {
  query: string;
  exchange?: string;
}
export interface OptionChainRequest {
  underlying: string;
  exchange: string;
  expiry_date?: string;
  strike_count?: number;
  with_greeks?: boolean;
}
export interface PlaceOrderRequest extends SymbolExchange {
  strategy: string;
  action: Action;
  pricetype: PriceType;
  product: Product;
  quantity: number;
  price?: number;
  trigger_price?: number;
}
export interface ModifyOrderRequest extends PlaceOrderRequest {
  orderid: string;
  disclosed_quantity?: number;
}
export interface CancelOrderRequest {
  orderid: string;
  strategy?: string;
}
export interface ClosePositionRequest {
  strategy?: string;
}

/** Successful OpenAlgo response: status "success" plus endpoint-specific fields. */
export interface OpenAlgoResponse<D = unknown> {
  status: "success";
  data?: D;
  message?: string;
  [key: string]: unknown;
}
export interface OrderResponse extends OpenAlgoResponse {
  orderid?: string;
}
export interface AnalyzerStatusData {
  analyze_mode: boolean;
  mode: string;
  total_logs: number;
}

export interface OpenAlgoClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
