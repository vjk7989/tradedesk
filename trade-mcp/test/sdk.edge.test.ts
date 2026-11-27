import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import { API_DOCS } from "../src/sdk/api-docs.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const OPEN = new Date("2026-01-07T04:30:00Z"); // Wed 10:00 IST
let dir: string;
let client: any;

function mkEngine(mode: "paper" | "live", over: Record<string, unknown> = {}) {
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5, ...over,
  };
  const kill = path.join(dir, "KILL");
  const engine = new RiskEngine(risk as any, { mode, killSwitchFile: kill, stateFile: path.join(dir, "st.json"), now: () => OPEN });
  const cfg = { mode, risk, killSwitchFile: kill } as unknown as Config;
  return { engine, cfg, kill };
}
function setup(mode: "paper" | "live" = "paper", over: Record<string, unknown> = {}, auditFile = path.join(dir, "audit.log")) {
  const { engine, cfg, kill } = mkEngine(mode, over);
  const b = createBindings({ client, risk: engine, cfg, auditFile }, { id: "r1" });
  return { b, engine, cfg, kill, auditFile };
}
const order = { symbol: "SBIN", exchange: "NSE", side: "BUY", quantity: 10, product: "MIS", priceType: "LIMIT", price: 100 };
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const names = (b: object) =>
  Object.entries(b).flatMap(([ns, fns]) => Object.keys(fns as object).map((f) => `${ns}.${f}`)).sort();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sdke-"));
  client = {
    quotes: vi.fn(async () => ({ status: "success", data: { ltp: 200 } })),
    analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
    pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
    placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    modifyOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    cancelOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    closePosition: vi.fn(async () => ({ status: "success" })),
    history: vi.fn(async () => ({})),
    toggleAnalyzer: vi.fn(async () => ({})),
  };
});

describe("binding surface (no privilege escalation)", () => {
  it("exposes exactly the AC namespaces/functions and nothing mutating", () => {
    const { b } = setup();
    const n = names(b);
    expect(n).toEqual([
      "account.funds", "account.holdings", "account.orders", "account.positions", "account.trades", "audit.recent", "backtest.run", "backtest.walkForward",
      "market.depth", "market.history", "market.optionChain", "market.quote", "market.search",
      "risk.status", "trade.cancel", "trade.closePosition", "trade.modify", "trade.place",
    ].sort());
    for (const x of n) expect(x).not.toMatch(/toggle|setmode|setlimit|reset|kill|analyzer|limit/i);
  });

  it("API_DOCS matches binding names exactly", () => {
    const { b } = setup();
    const docs = API_DOCS.map((d) => `${d.ns}.${d.name}`).sort();
    expect(docs).toEqual(names(b));
    expect(new Set(docs).size).toBe(docs.length);
  });

  it("no binding ever calls client.toggleAnalyzer", async () => {
    const { b } = setup();
    await b.trade.place(order).catch(() => {});
    await b.risk.status();
    expect(client.toggleAnalyzer).not.toHaveBeenCalled();
  });

  it("mutating risk.status() result does not change engine limits", async () => {
    const { b, engine } = setup();
    const s: any = await b.risk.status();
    s.limits.maxQtyPerOrder = 1e9;
    s.limits.maxNotionalPerOrder = 1e12;
    s.limits.maxNotionalPerDay = 1e12;
    s.limits.allowedExchanges.push("NFO");
    const s2: any = engine.status();
    expect(s2.limits.maxQtyPerOrder).toBe(100);
    expect(s2.limits.allowedExchanges).toEqual(["NSE"]);
    await expect(b.trade.place({ ...order, quantity: 1000, price: 1 })).rejects.toThrow(/risk denied/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });
});

describe("trade.place validation", () => {
  it.each([{ apikey: "x" }, { strategy: "x" }, { mode: "live" }, { orderId: "1" }])(
    "rejects extra field %o and never reaches client",
    async (extra) => {
      const { b } = setup();
      await expect(b.trade.place({ ...order, ...extra })).rejects.toThrow(/unknown field/);
      expect(client.placeOrder).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["quantity string", { quantity: "10" }],
    ["price string", { price: "100" }],
    ["side lowercase", { side: "buy" }],
    ["priceType lowercase", { priceType: "limit" }],
    ["bad product", { product: "XYZ" }],
    ["LIMIT without price", { price: undefined }],
    ["SL without triggerPrice", { priceType: "SL" }],
    ["SL-M without triggerPrice", { priceType: "SL-M", price: undefined }],
    ["NaN price", { price: NaN }],
    ["Infinity quantity", { quantity: Infinity }],
    ["empty symbol", { symbol: "" }],
  ])("rejects %s", async (_n, patch) => {
    const { b } = setup();
    await expect(b.trade.place({ ...order, ...patch })).rejects.toThrow();
    expect(client.placeOrder).not.toHaveBeenCalled();
  });
  it.each([[-10], [0], [1.5]])("risk denies quantity %s", async (q) => {
    const { b } = setup();
    await expect(b.trade.place({ ...order, quantity: q })).rejects.toThrow(/risk denied/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });
  it("quantity boundary: 100 allowed, 101 denied", async () => {
    const { b } = setup();
    await b.trade.place({ ...order, quantity: 100, price: 1 });
    await expect(b.trade.place({ ...order, quantity: 101, price: 1 })).rejects.toThrow(/maxQtyPerOrder/);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
  });
  it.each([null, undefined, [], "x", 5])("rejects non-object args %o", async (a) => {
    const { b } = setup();
    await expect(b.trade.place(a as any)).rejects.toThrow(/args must be an object/);
  });
  it("SL with price and triggerPrice maps trigger_price", async () => {
    const { b } = setup();
    await b.trade.place({ ...order, priceType: "SL", triggerPrice: 99 });
    expect(client.placeOrder.mock.calls[0][0]).toMatchObject({ pricetype: "SL", trigger_price: 99, strategy: "trade-mcp" });
  });
  it("mutating args after call does not change wire order", async () => {
    let release!: () => void;
    client.analyzerStatus = vi.fn(() => new Promise((r) => (release = () => r({ data: { analyze_mode: true } }))));
    const { b } = setup();
    const args: any = { ...order };
    const p = b.trade.place(args);
    await new Promise((r) => setTimeout(r, 0));
    args.quantity = 99999;
    args.symbol = "EVIL";
    release();
    await p;
    expect(client.placeOrder.mock.calls[0][0]).toMatchObject({ quantity: 10, symbol: "SBIN" });
  });
});

describe("MARKET LTP fail-closed", () => {
  const mkt = { ...order, priceType: "MARKET", price: undefined };
  it.each([
    ["throws", async () => { throw new Error("net"); }],
    ["no data", async () => ({ status: "error" })],
    ["ltp 0", async () => ({ data: { ltp: 0 } })],
    ["ltp NaN", async () => ({ data: { ltp: NaN } })],
    ["ltp negative", async () => ({ data: { ltp: -5 } })],
    ["ltp junk string", async () => ({ data: { ltp: "abc" } })],
    ["null", async () => null],
  ])("quote %s -> no order", async (_n, impl) => {
    client.quotes = vi.fn(impl as any);
    const { b, auditFile } = setup();
    await expect(b.trade.place(mkt)).rejects.toThrow();
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(lines(auditFile)[0].decision).toBe("error");
  });
});

describe("paper mode analyzer gate", () => {
  it.each([
    ["throws", async () => { throw new Error("down"); }],
    ["null", async () => null],
    ["analyze_mode string 'true'", async () => ({ data: { analyze_mode: "true" } })],
    ["analyze_mode 1", async () => ({ data: { analyze_mode: 1 } })],
    ["top-level flag only", async () => ({ analyze_mode: true })],
    ["off", async () => ({ data: { analyze_mode: false } })],
  ])("analyzer %s -> refuse", async (_n, impl) => {
    client.analyzerStatus = vi.fn(impl as any);
    const { b, auditFile } = setup("paper");
    await expect(b.trade.place(order)).rejects.toThrow();
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(lines(auditFile)[0]).toMatchObject({ run: "r1", action: "trade.place", decision: "error" });
  });
  it("modify in paper also requires analyzer ON", async () => {
    client.analyzerStatus = vi.fn(async () => ({ data: { analyze_mode: false } }));
    const { b } = setup("paper");
    await expect(b.trade.modify({ ...order, orderId: "1" })).rejects.toThrow(/analyzer ON/);
    expect(client.modifyOrder).not.toHaveBeenCalled();
  });
});

describe("live mode", () => {
  it("does not require analyzer", async () => {
    client.analyzerStatus = vi.fn(async () => ({ data: { analyze_mode: false } }));
    const { b } = setup("live");
    await b.trade.place(order);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("pnl undefined -> skip with warning", async () => {
    client.pnl = vi.fn(async () => ({ status: "success" }));
    const { b, auditFile } = setup("live");
    await b.trade.place(order);
    expect(lines(auditFile)[0].warning).toMatch(/P&L unavailable/);
  });
  it("pnl throws -> skip with warning", async () => {
    client.pnl = vi.fn(async () => { throw new Error("x"); });
    const { b } = setup("live");
    await b.trade.place(order);
    expect(client.placeOrder).toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -Infinity])("pnl %s -> risk denies", async (v) => {
    client.pnl = vi.fn(async () => ({ total_pnl: v }));
    const { b, auditFile } = setup("live");
    await expect(b.trade.place(order)).rejects.toThrow(/risk denied/);
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(lines(auditFile)[0].decision).toBe("denied");
  });
  it("pnl at loss limit -> denied; just above -> allowed", async () => {
    client.pnl = vi.fn(async () => ({ total_pnl: -5000 }));
    await expect(setup("live").b.trade.place(order)).rejects.toThrow(/daily loss/);
    client.pnl = vi.fn(async () => ({ total_pnl: -4999.99 }));
    await setup("live").b.trade.place(order);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("paper mode does not consult pnl", async () => {
    await setup("paper").b.trade.place(order);
    expect(client.pnl).not.toHaveBeenCalled();
  });
});

describe("caps", () => {
  it("per-run cap: 5 allowed, 6th denied", async () => {
    const { b } = setup();
    for (let i = 0; i < 5; i++) await b.trade.place(order);
    await expect(b.trade.place(order)).rejects.toThrow(/maxOrdersPerRun/);
    expect(client.placeOrder).toHaveBeenCalledTimes(5);
  });
  it("per-run independent across createBindings, daily cap shared", async () => {
    const { engine, cfg } = mkEngine("paper", { maxOrdersPerDay: 7 });
    const mk = (id: string) => createBindings({ client, risk: engine, cfg, auditFile: path.join(dir, "a.log") }, { id });
    const b1 = mk("a");
    const b2 = mk("b");
    for (let i = 0; i < 5; i++) await b1.trade.place(order);
    await b2.trade.place(order);
    await b2.trade.place(order);
    await expect(b2.trade.place(order)).rejects.toThrow(/maxOrdersPerDay/);
    expect(client.placeOrder).toHaveBeenCalledTimes(7);
  });
  it("RACE: 10 concurrent place with maxOrdersPerRun 5 -> at most 5 placed", async () => {
    const { b } = setup();
    await Promise.allSettled(Array.from({ length: 10 }, () => b.trade.place(order)));
    expect(client.placeOrder.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it("modify above maxQty denied; allowed modify does not count as order", async () => {
    const { b, engine } = setup();
    await expect(b.trade.modify({ ...order, orderId: "1", quantity: 101 })).rejects.toThrow(/risk denied/);
    expect(client.modifyOrder).not.toHaveBeenCalled();
    await b.trade.modify({ ...order, orderId: "1" });
    expect(engine.status().today.orders).toBe(0);
    expect(client.modifyOrder.mock.calls[0][0]).toMatchObject({ orderid: "1", strategy: "trade-mcp" });
  });
  it("modify denied under kill switch", async () => {
    const { b, kill } = setup();
    writeFileSync(kill, "");
    await expect(b.trade.modify({ ...order, orderId: "1" })).rejects.toThrow(/kill switch/);
    expect(client.modifyOrder).not.toHaveBeenCalled();
  });
});

describe("placeOrder failures", () => {
  it("throwing: recordOrder not called, audit error", async () => {
    client.placeOrder = vi.fn(async () => { throw new Error("broker down"); });
    const { b, engine, auditFile } = setup();
    const spy = vi.spyOn(engine, "recordOrder");
    await expect(b.trade.place(order)).rejects.toThrow("broker down");
    expect(spy).not.toHaveBeenCalled();
    expect(lines(auditFile)[0]).toMatchObject({ decision: "error", error: "broker down", run: "r1" });
  });
  it("status:error response is not recorded as an allowed/placed order", async () => {
    client.placeOrder = vi.fn(async () => ({ status: "error", message: "rejected" }));
    const { b, engine, auditFile } = setup();
    await b.trade.place(order).catch(() => {});
    expect(engine.status().today.orders).toBe(0);
    expect(lines(auditFile)[0].decision).not.toBe("allowed");
  });
});

describe("cancel / closePosition", () => {
  it("closePosition allowed under kill switch and audited", async () => {
    const { b, kill, auditFile } = setup();
    writeFileSync(kill, "");
    await b.trade.closePosition();
    expect(client.closePosition).toHaveBeenCalledWith({ strategy: "trade-mcp" });
    expect(lines(auditFile)[0]).toMatchObject({ action: "trade.closePosition", decision: "allowed" });
  });
  it("cancel rejects extra/missing fields", async () => {
    const { b } = setup();
    await expect(b.trade.cancel({ orderId: "1", strategy: "x" })).rejects.toThrow(/unknown field/);
    await expect(b.trade.cancel({})).rejects.toThrow(/missing field/);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });
  it("closePosition rejects extra fields", async () => {
    const { b } = setup();
    await expect(b.trade.closePosition({ strategy: "x" })).rejects.toThrow(/unknown field/);
    expect(client.closePosition).not.toHaveBeenCalled();
  });
});

describe("market + audit", () => {
  it("market.history maps start/end", async () => {
    const { b } = setup();
    await b.market.history({ symbol: "S", exchange: "NSE", interval: "D", start: "2026-01-01", end: "2026-01-02" });
    expect(client.history).toHaveBeenCalledWith({
      symbol: "S", exchange: "NSE", interval: "D", start_date: "2026-01-01", end_date: "2026-01-02",
    });
  });
  it("audits every attempt (allowed, denied, error) with run id", async () => {
    const { b, auditFile } = setup();
    await b.trade.place(order);
    await b.trade.place({ ...order, quantity: 1000 }).catch(() => {});
    await b.trade.place({ ...order, side: "x" }).catch(() => {});
    expect(lines(auditFile).map((l) => [l.run, l.decision])).toEqual([["r1", "allowed"], ["r1", "denied"], ["r1", "error"]]);
  });
  it("audit file unwritable (directory): order must not be placed without audit record", async () => {
    const auditDir = path.join(dir, "auditdir");
    mkdirSync(auditDir);
    const { b } = setup("paper", {}, auditDir);
    const r = await b.trade.place(order).then(() => "placed", (e) => "refused:" + e.message);
    expect(r).toMatch(/^refused/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });
});

describe("searchApi edges", () => {
  it.each(["(*", "[", "\\", ".*+?^${}()|"])("regex chars %s do not throw", (q) => {
    expect(() => searchApi(q)).not.toThrow();
  });
  it("very long query", () => {
    expect(searchApi("z".repeat(100000))).toContain("No API entries match");
  });
  it("unicode query", () => {
    expect(searchApi("注文 ₹ 🚀")).toContain("No API entries match");
  });
  it("broad match capped at 20 entries", () => {
    const s = searchApi("a e i o u");
    expect((s.match(/function /g) ?? []).length).toBeLessThanOrEqual(20);
    expect(s).toContain("declare namespace");
  });
  it("every binding is findable by its name", () => {
    for (const d of API_DOCS) expect(searchApi(d.name)).toContain(d.name);
  });
});
