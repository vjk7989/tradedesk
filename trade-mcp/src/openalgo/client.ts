import type * as T from "./types.js";

export class OpenAlgoError extends Error {
  constructor(
    public readonly endpoint: string,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "OpenAlgoError";
  }
}

export class OpenAlgoClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: T.OpenAlgoClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private redact(s: string): string {
    return this.apiKey ? s.split(this.apiKey).join("[REDACTED]") : s;
  }

  private async call<R = T.OpenAlgoResponse>(endpoint: string, body: object = {}, signal?: AbortSignal): Promise<R> {
    const fail = (msg: string, status?: number) =>
      new OpenAlgoError(endpoint, this.redact(msg), status);
    const ctl = new AbortController();
    const timeoutErr = () => fail(`request timeout after ${this.timeoutMs}ms`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctl.abort();
        rej(timeoutErr());
      }, this.timeoutMs);
    });
    timeout.catch(() => {});
    // Caller cancellation: abort the request too, but report it as an abort, not as our own timeout.
    let callerAborted = false;
    let onCallerAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, rej) => {
      if (!signal) return;
      onCallerAbort = () => {
        callerAborted = true;
        ctl.abort();
        rej(fail("request aborted"));
      };
      if (signal.aborted) onCallerAbort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    });
    aborted.catch(() => {});
    let res: Response;
    let text: string;
    try {
      const work = (async () => {
        if (callerAborted) throw fail("request aborted");
        const r = await this.fetchImpl(`${this.base}/api/v1/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, apikey: this.apiKey }),
          signal: ctl.signal,
        });
        return [r, await r.text()] as const;
      })();
      work.catch(() => {});
      [res, text] = await Promise.race([work, timeout, aborted]);
    } catch (e) {
      if (e instanceof OpenAlgoError) throw e;
      if (callerAborted) throw fail("request aborted");
      if (ctl.signal.aborted) throw timeoutErr();
      throw fail(`network error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      if (signal && onCallerAbort) signal.removeEventListener("abort", onCallerAbort);
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw fail(
        res.ok ? "non-JSON response body" : `HTTP ${res.status}: non-JSON response body`,
        res.status,
      );
    }
    if (!res.ok) {
      throw fail(`HTTP ${res.status}: ${json?.message ?? res.statusText}`, res.status);
    }
    if (!json || typeof json !== "object" || json.status !== "success") {
      throw fail(String(json?.message ?? "OpenAlgo returned status error"), res.status);
    }
    return json as R;
  }

  quotes(r: T.SymbolExchange) { return this.call("quotes", r); }
  depth(r: T.SymbolExchange) { return this.call("depth", r); }
  history(r: T.HistoryRequest) { return this.call("history", r); }
  search(r: T.SearchRequest) { return this.call("search", r); }
  optionChain(r: T.OptionChainRequest) { return this.call("optionchain", r); }
  funds() { return this.call("funds"); }
  positions() { return this.call("positionbook"); }
  holdings() { return this.call("holdings"); }
  orders() { return this.call("orderbook"); }
  trades() { return this.call("tradebook"); }
  /** Sandbox P&L; docs path is /api/v1/pnl/symbols (analyzer mode only). */
  pnl() { return this.call("pnl/symbols"); }
  /** Read-only analyzer status. The toggle endpoint is deliberately not implemented. */
  analyzerStatus(signal?: AbortSignal) { return this.call<T.OpenAlgoResponse<T.AnalyzerStatusData>>("analyzer", {}, signal); }
  placeOrder(r: T.PlaceOrderRequest) { return this.call<T.OrderResponse>("placeorder", r); }
  modifyOrder(r: T.ModifyOrderRequest) { return this.call<T.OrderResponse>("modifyorder", r); }
  cancelOrder(r: T.CancelOrderRequest) { return this.call<T.OrderResponse>("cancelorder", r); }
  closePosition(r: T.ClosePositionRequest = {}) { return this.call("closeposition", r); }
}
