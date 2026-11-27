import type { OpenAlgoClient } from "../openalgo/client.js";
import { orderNotional, type RiskEngine } from "../risk/engine.js";
import type { Config } from "../config.js";
import type { Bindings } from "../sandbox/quickjs.js";
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import type { BacktestClient, BacktestRequest, WalkForwardRequest } from "../backtest/client.js";
import { appendAudit } from "../risk/audit.js";
import { probeAuditWritable } from "../risk/audit-probe.js";

export interface BindingDeps {
  client: OpenAlgoClient;
  bt?: BacktestClient;
  risk: RiskEngine;
  cfg: Config;
  auditFile: string;
  scope?: "full" | "readonly";
}

const STRATEGY = "trade-mcp";
const SIDES = ["BUY", "SELL"];
const PRICE_TYPES = ["MARKET", "LIMIT", "SL", "SL-M"];

function obj(args: unknown, what: string): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`${what}: args must be an object`);
  return args as Record<string, unknown>;
}

function check(args: unknown, what: string, required: string[], optional: string[] = []): Record<string, unknown> {
  const a = obj(args, what);
  for (const k of Object.keys(a)) {
    if (!required.includes(k) && !optional.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
  }
  for (const k of required) {
    if (a[k] === undefined || a[k] === null || a[k] === "") throw new Error(`${what}: missing field "${k}"`);
  }
  return a;
}

function str(a: Record<string, unknown>, k: string, what: string): string {
  if (typeof a[k] !== "string") throw new Error(`${what}: "${k}" must be a string`);
  return a[k] as string;
}

function num(a: Record<string, unknown>, k: string, what: string): number {
  if (typeof a[k] !== "number" || !Number.isFinite(a[k] as number)) throw new Error(`${what}: "${k}" must be a finite number`);
  return a[k] as number;
}

const ORDER_REQ = ["symbol", "exchange", "side", "quantity", "product", "priceType"];
const ORDER_OPT = ["price", "triggerPrice"];

interface Order {
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  product: "CNC" | "NRML" | "MIS";
  priceType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  price?: number;
  triggerPrice?: number;
}

function parseOrder(args: unknown, what: string, extraReq: string[] = []): { o: Order; a: Record<string, unknown> } {
  const a = check(args, what, [...ORDER_REQ, ...extraReq], ORDER_OPT);
  const side = str(a, "side", what);
  if (!SIDES.includes(side)) throw new Error(`${what}: side must be BUY or SELL`);
  const priceType = str(a, "priceType", what);
  if (!PRICE_TYPES.includes(priceType)) throw new Error(`${what}: priceType must be one of ${PRICE_TYPES.join("|")}`);
  if (!["CNC", "NRML", "MIS"].includes(a.product as string)) throw new Error(`${what}: product must be CNC|NRML|MIS`);
  const o: Order = {
    symbol: str(a, "symbol", what),
    exchange: str(a, "exchange", what),
    side: side as "BUY" | "SELL",
    quantity: num(a, "quantity", what),
    product: str(a, "product", what) as Order["product"],
    priceType: priceType as Order["priceType"],
  };
  if (a.price !== undefined) o.price = num(a, "price", what);
  if (a.triggerPrice !== undefined) o.triggerPrice = num(a, "triggerPrice", what);
  if ((priceType === "LIMIT" || priceType === "SL") && o.price === undefined) {
    throw new Error(`${what}: price is required for ${priceType}`);
  }
  if ((priceType === "SL" || priceType === "SL-M") && o.triggerPrice === undefined) {
    throw new Error(`${what}: triggerPrice is required for ${priceType}`);
  }
  return { o, a };
}

type LooseBindings = Record<string, Record<string, (args?: unknown) => Promise<unknown>>>;

function downsample<T>(a: T[], max: number): T[] {
  if (a.length <= max) return a;
  const step = (a.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => a[Math.round(i * step)]);
}

const AUDIT_TAIL_BYTES = 1024 * 1024;
const AUDIT_DEFAULT_LIMIT = 20;
const AUDIT_MAX_LIMIT = 200;

/** Last `limit` parsed entries from the tail (<= 1 MB) of the audit file, newest last. */
async function readAuditTail(file: string, limit: number): Promise<{ entries: object[]; skipped: number }> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], skipped: 0 };
    throw e;
  }
  let text: string;
  let partial = false;
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, AUDIT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, size - len + got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    text = buf.subarray(0, got).toString("utf8");
    partial = size > len;
  } finally {
    await fh.close();
  }
  const lines = text.split("\n");
  if (partial) lines.shift(); // first line of a mid-file window is cut off
  const entries: object[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) entries.push(v);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { entries: entries.slice(-limit), skipped };
}

/** Newest rotated sibling of the audit file (same name pattern as audit.ts rotation: base.DATE[.N].jsonl). */
async function newestRotated(file: string): Promise<string | undefined> {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.jsonl$`);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let best: { name: string; date: string; n: number } | undefined;
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const c = { name, date: m[1], n: m[2] ? Number(m[2]) : 0 };
    if (!best || c.date > best.date || (c.date === best.date && c.n > best.n)) best = c;
  }
  return best && path.join(dir, best.name);
}

/** Last `limit` entries, oldest to newest: current file, topped up from the newest rotated file if short. */
async function readAuditRecent(file: string, limit: number): Promise<{ entries: object[]; skipped: number }> {
  const cur = await readAuditTail(file, limit);
  if (cur.entries.length >= limit) return cur;
  const rotated = await newestRotated(file);
  if (!rotated) return cur;
  const old = await readAuditTail(rotated, limit - cur.entries.length);
  return { entries: [...old.entries, ...cur.entries], skipped: cur.skipped + old.skipped };
}

/** Replace every occurrence of each secret value in all strings of v (audit redaction only matches key names). */
function scrub(v: unknown, secrets: string[]): unknown {
  if (typeof v === "string") return secrets.reduce((acc, x) => acc.split(x).join("[REDACTED]"), v);
  if (Array.isArray(v)) return v.map((x) => scrub(x, secrets));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, secrets);
    return out;
  }
  return v;
}

export function createBindings(deps: BindingDeps, run: { id: string }): LooseBindings & Bindings {
  const { client, risk, cfg, auditFile } = deps;
  const runState = { ordersThisRun: 0 };

  const audit = (entry: object) => {
    try {
      appendAudit(auditFile, { run: run.id, ...entry });
    } catch (e) {
      // best-effort: must not mask the trade result
      console.error("audit write failed:", e instanceof Error ? e.message : String(e));
    }
  };

  const brokerCheck = (res: unknown): unknown => {
    const r = res as { status?: unknown; message?: unknown } | null;
    if (!r || r.status !== "success") throw new Error("broker rejected: " + String(r?.message ?? "unknown error"));
    return res;
  };

  /** Run an audited action: logs success or error for every attempt. */
  async function audited<T>(action: string, args: unknown, fn: (note: (k: string, v: unknown) => void) => Promise<T>): Promise<T> {
    const extra: Record<string, unknown> = {};
    try {
      const result = await fn((k, v) => (extra[k] = v));
      audit({ action, args, decision: "allowed", ...extra, result });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit({ action, args, decision: msg.startsWith("risk denied") ? "denied" : "error", ...extra, error: msg });
      throw e;
    }
  }

  /** All awaited inputs for a risk decision; the decision itself is made synchronously afterwards. */
  async function gather(o: Order, note: (k: string, v: unknown) => void): Promise<{ price: number; dayPnl?: number }> {
    // price for notional: explicit limit price, else LTP
    let price = o.price;
    if (price === undefined) {
      const q: any = await client.quotes({ symbol: o.symbol, exchange: o.exchange });
      price = Number(q?.data?.ltp);
      if (!Number.isFinite(price) || price <= 0) throw new Error("could not determine LTP for notional check");
    }
    // day P&L (live only); undefined = skipped
    let dayPnl: number | undefined;
    if (cfg.mode === "live") {
      try {
        const p: any = await client.pnl();
        const t = p?.total_pnl;
        if (typeof t === "number") dayPnl = t;
        else note("warning", "day P&L unavailable; daily loss check skipped");
      } catch {
        note("warning", "day P&L unavailable; daily loss check skipped");
      }
    }
    if (cfg.mode === "paper") {
      const s = await client.analyzerStatus();
      if (s?.data?.analyze_mode !== true) throw new Error("paper mode requires OpenAlgo analyzer ON");
    }
    return { price, dayPnl };
  }

  const riskOrder = (o: Order, price: number) => ({
    symbol: o.symbol, exchange: o.exchange, product: o.product, quantity: o.quantity, price, side: o.side,
  });

  /**
   * Fail-closed audit gate, run before the broker call: the audit file must be
   * writable (synchronous, not swallowed) or the order is refused. The record
   * itself is the single line written by audited() after the call.
   */
  const auditAttempt = (_action: string, _args: unknown) => {
    try {
      probeAuditWritable(auditFile);
    } catch {
      throw new Error("audit log unavailable — order refused");
    }
  };

  const toWire = (o: Order) => ({
    strategy: STRATEGY,
    symbol: o.symbol,
    exchange: o.exchange,
    action: o.side,
    pricetype: o.priceType,
    product: o.product,
    quantity: o.quantity,
    ...(o.price !== undefined ? { price: o.price } : {}),
    ...(o.triggerPrice !== undefined ? { trigger_price: o.triggerPrice } : {}),
  });

  const symEx = (args: unknown, what: string) => {
    const a = check(args, what, ["symbol", "exchange"]);
    return { symbol: str(a, "symbol", what), exchange: str(a, "exchange", what) };
  };

  const bindings: LooseBindings & Bindings = {
    market: {
      quote: async (args) => (await client.quotes(symEx(args, "market.quote"))),
      depth: async (args) => (await client.depth(symEx(args, "market.depth"))),
      history: async (args) => {
        const a = check(args, "market.history", ["symbol", "exchange", "interval", "start", "end"]);
        return client.history({
          symbol: str(a, "symbol", "market.history"),
          exchange: str(a, "exchange", "market.history"),
          interval: str(a, "interval", "market.history"),
          start_date: str(a, "start", "market.history"),
          end_date: str(a, "end", "market.history"),
        });
      },
      search: async (args) => {
        const a = check(args, "market.search", ["query"], ["exchange"]);
        return client.search({
          query: str(a, "query", "market.search"),
          ...(a.exchange !== undefined ? { exchange: str(a, "exchange", "market.search") } : {}),
        });
      },
      optionChain: async (args) => {
        const a = check(args, "market.optionChain", ["underlying", "exchange"], ["expiry", "strikeCount", "withGreeks"]);
        return client.optionChain({
          underlying: str(a, "underlying", "market.optionChain"),
          exchange: str(a, "exchange", "market.optionChain"),
          ...(a.expiry !== undefined ? { expiry_date: str(a, "expiry", "market.optionChain") } : {}),
          ...(a.strikeCount !== undefined ? { strike_count: num(a, "strikeCount", "market.optionChain") } : {}),
          ...(a.withGreeks !== undefined ? { with_greeks: a.withGreeks === true } : {}),
        });
      },
    },
    account: {
      funds: async () => client.funds(),
      positions: async () => client.positions(),
      holdings: async () => client.holdings(),
      orders: async () => client.orders(),
      trades: async () => client.trades(),
    },
    trade: {
      place: async (args) =>
        audited("trade.place", args, async (note) => {
          const { o } = parseOrder(args, "trade.place");
          const { price, dayPnl } = await gather(o, note);
          // synchronous from here to placeOrder: reserve + per-run counter in one tick
          const d = risk.reserve(riskOrder(o, price), { ordersThisRun: runState.ordersThisRun }, dayPnl);
          note("riskReasons", d.reasons);
          if (!d.allow || !d.token) throw new Error("risk denied: " + d.reasons.join("; "));
          const token = d.token;
          runState.ordersThisRun++;
          note("notional", orderNotional(cfg.risk, o, price));
          const undo = () => {
            risk.release(token);
            runState.ordersThisRun--;
          };
          try {
            auditAttempt("trade.place", args);
          } catch (e) {
            undo();
            throw e;
          }
          let res: unknown;
          try {
            res = brokerCheck(await client.placeOrder(toWire(o)));
          } catch (e) {
            undo();
            throw e;
          }
          risk.commit(token);
          return res;
        }),
      // Modify runs the same risk checks but is not a new order: it does not
      // touch the daily order/notional counters or the per-run counter.
      modify: async (args) =>
        audited("trade.modify", args, async (note) => {
          const { o, a } = parseOrder(args, "trade.modify", ["orderId"]);
          const { price, dayPnl } = await gather(o, note);
          const d = risk.checkOrder(riskOrder(o, price), { ordersThisRun: runState.ordersThisRun }, dayPnl);
          note("riskReasons", d.reasons);
          if (!d.allow) throw new Error("risk denied: " + d.reasons.join("; "));
          auditAttempt("trade.modify", args);
          return brokerCheck(
            await client.modifyOrder({ ...toWire(o), orderid: str(a, "orderId", "trade.modify") } as Parameters<OpenAlgoClient["modifyOrder"]>[0]),
          );
        }),
      // cancel / closePosition reduce risk: allowed even when the kill switch is on.
      cancel: async (args) =>
        audited("trade.cancel", args, async () => {
          const a = check(args, "trade.cancel", ["orderId"]);
          return client.cancelOrder({ orderid: str(a, "orderId", "trade.cancel"), strategy: STRATEGY });
        }),
      closePosition: async (args) =>
        audited("trade.closePosition", args, async () => {
          check(args ?? {}, "trade.closePosition", []);
          return client.closePosition({ strategy: STRATEGY });
        }),
    },
    backtest: {
      // Never touches the risk engine or the broker; audited without the code body.
      run: async (args) => {
        const w = "backtest.run";
        // audit args never include the code body, even when validation fails
        let auditArgs: unknown = "<non-object args>";
        if (args && typeof args === "object" && !Array.isArray(args)) {
          const { code: c, ...rest } = args as Record<string, unknown>;
          auditArgs = typeof c === "string"
            ? { ...rest, codeLength: c.length, codeSha256: createHash("sha256").update(c).digest("hex") }
            : rest;
        }
        try {
          const a = check(args, w, ["code", "symbols", "start", "end"], ["interval", "capital", "costs", "source", "params"]);
          const code = str(a, "code", w);
          if (!deps.bt) throw new Error("backtest service not configured");
          if (!Array.isArray(a.symbols) || a.symbols.some((x) => typeof x !== "string")) {
            throw new Error(w + ': "symbols" must be an array of strings');
          }
          const body: BacktestRequest = {
            code,
            symbols: a.symbols as string[],
            start: str(a, "start", w),
            end: str(a, "end", w),
            ...(a.interval !== undefined ? { interval: str(a, "interval", w) } : {}),
            ...(a.capital !== undefined ? { capital: num(a, "capital", w) } : {}),
            ...(a.costs !== undefined ? { costs: obj(a.costs, w + " costs") } : {}),
            ...(a.source !== undefined ? { source: str(a, "source", w) } : {}),
            ...(a.params !== undefined ? { signal_parameters: obj(a.params, w + " params") } : {}),
          };
          const r = await deps.bt.run(body);
          const trades = r.trades ?? [];
          const out = {
            ok: r.ok,
            metrics: r.metrics ?? {},
            equity: downsample(r.equity ?? [], 100),
            trades: trades.slice(0, 20),
            tradeCount: trades.length,
            warnings: r.warnings ?? [],
            error: r.error ?? null,
          };
          audit({ action: w, args: auditArgs, decision: "allowed", ok: r.ok, error: out.error });
          return out;
        } catch (e) {
          audit({ action: w, args: auditArgs, decision: "error", error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      },
      walkForward: async (args) => {
        const w = "backtest.walkForward";
        // audit args never include the code body, even when validation fails
        let auditArgs: unknown = "<non-object args>";
        if (args && typeof args === "object" && !Array.isArray(args)) {
          const { code: c, ...rest } = args as Record<string, unknown>;
          auditArgs = typeof c === "string"
            ? { ...rest, codeLength: c.length, codeSha256: createHash("sha256").update(c).digest("hex") }
            : rest;
        }
        try {
          const a = check(args, w, ["code", "symbols", "start", "end", "trainDays", "testDays", "candidates"], [
            "metric", "interval", "capital", "costs", "source",
          ]);
          const code = str(a, "code", w);
          if (!deps.bt) throw new Error("backtest service not configured");
          if (!Array.isArray(a.symbols) || a.symbols.some((x) => typeof x !== "string")) {
            throw new Error(w + ': "symbols" must be an array of strings');
          }
          if (!Array.isArray(a.candidates) || a.candidates.some((c) => !c || typeof c !== "object" || Array.isArray(c))) {
            throw new Error(w + ': "candidates" must be an array of objects');
          }
          const metric = a.metric !== undefined ? str(a, "metric", w) : undefined;
          if (metric !== undefined && !["sharpe", "total_return", "calmar"].includes(metric)) {
            throw new Error(w + ": metric must be one of sharpe, total_return, calmar");
          }
          const body: WalkForwardRequest = {
            code,
            symbols: a.symbols as string[],
            start: str(a, "start", w),
            end: str(a, "end", w),
            train_days: num(a, "trainDays", w),
            test_days: num(a, "testDays", w),
            candidates: a.candidates as Record<string, unknown>[],
            ...(metric !== undefined ? { metric: metric as WalkForwardRequest["metric"] } : {}),
            ...(a.interval !== undefined ? { interval: str(a, "interval", w) } : {}),
            ...(a.capital !== undefined ? { capital: num(a, "capital", w) } : {}),
            ...(a.costs !== undefined ? { costs: obj(a.costs, w + " costs") } : {}),
            ...(a.source !== undefined ? { source: str(a, "source", w) } : {}),
          };
          const r = await deps.bt.walkForward(body);
          const folds = (r.folds ?? []).map((f) => ({
            train: f.train ?? [],
            test: f.test ?? [],
            chosen: f.chosen ?? {},
            trainScore: f.train_score ?? null,
            testMetrics: f.test_metrics ?? {},
          }));
          const out = {
            ok: r.ok,
            metric: r.metric ?? null,
            folds,
            oosEquity: downsample(r.oos_equity ?? [], 100),
            summary: r.summary ?? {},
            warnings: r.warnings ?? [],
            error: r.error ?? null,
          };
          audit({ action: w, args: auditArgs, decision: "allowed", ok: r.ok, error: out.error });
          return out;
        } catch (e) {
          audit({ action: w, args: auditArgs, decision: "error", error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      },
    },
    risk: {
      status: async () => risk.status(),
    },
    // Read-only: entries were redacted when written. Invalid limits are rejected, not clamped.
    audit: {
      recent: async (args) => {
        const w = "audit.recent";
        try {
          const a = check(args ?? {}, w, [], ["limit"]);
          let limit = AUDIT_DEFAULT_LIMIT;
          if (a.limit !== undefined) {
            limit = num(a, "limit", w);
            if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) {
              throw new Error(`${w}: "limit" must be an integer from 1 to ${AUDIT_MAX_LIMIT}`);
            }
          }
          const secrets = [cfg.mcpToken, cfg.mcpTokenReadonly, cfg.openalgoApiKey, cfg.btToken, process.env.OAUTH_PASSWORD_HASH]
            .filter((x): x is string => typeof x === "string" && x.length >= 8);
          const read = await readAuditRecent(auditFile, limit);
          const entries = scrub(read.entries, secrets) as object[];
          const skipped = read.skipped;
          audit({ action: w, args: a, decision: "allowed", count: entries.length, skipped });
          return { entries, skipped };
        } catch (e) {
          audit({ action: w, args, decision: "error", error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      },
    },
  };
  // readonly scope: the trade namespace does not exist in the sandbox at all
  if (deps.scope === "readonly") delete bindings.trade;
  return bindings;
}
