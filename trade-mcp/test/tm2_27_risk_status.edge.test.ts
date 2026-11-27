import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine, type RiskOrder } from "../src/risk/engine.js";
import { riskSchema, loadConfig, type Config, type RiskConfig } from "../src/config.js";
import { createBindings } from "../src/sdk/bindings.js";

// Wed 2026-01-07 10:00 IST = 04:30Z (NSE open, not a holiday).
const WED = new Date("2026-01-07T04:30:00Z");

let dir: string;
let t: Date;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tm2-27x-"));
  t = WED;
});

const baseRisk = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  allowedExchanges: ["NSE", "NFO", "MCX", "CRYPTO"],
  allowedProducts: ["CNC", "MIS", "NRML"],
  symbolAllow: [],
  symbolDeny: [],
  maxQtyPerOrder: 1000,
  maxNotionalPerOrder: 1e9,
  maxNotionalPerOrderUsd: 1e9,
  maxOrdersPerDay: 5,
  maxNotionalPerDay: 10000,
  maxDailyLoss: 5000,
  maxOrdersPerRun: 1000,
  ...over,
});
const mk = (risk: RiskConfig, stateFile = path.join(dir, "s.json")) =>
  new RiskEngine(risk, { mode: "paper", killSwitchFile: path.join(dir, "KILL"), stateFile, now: () => t });
const ord = (over: Partial<RiskOrder> = {}): RiskOrder => ({
  symbol: "INFY", exchange: "NSE", product: "MIS", quantity: 1, price: 100, side: "BUY", ...over,
});
const run0 = { ordersThisRun: 0 };
const holidaysAt = (risk: RiskConfig, at: Date) => {
  t = at;
  return mk(risk).status().limits.marketHolidays;
};

describe("limits: every riskSchema key", () => {
  it("has exactly the riskSchema.shape keys, no more, no fewer", () => {
    const s = mk(baseRisk()).status();
    expect(Object.keys(s.limits).sort()).toEqual(Object.keys(riskSchema.shape).sort());
    for (const k of Object.keys(riskSchema.shape)) {
      expect(k in s.limits).toBe(true);
      expect((s.limits as Record<string, unknown>)[k]).not.toBeUndefined();
    }
  });
  it("schema defaults (parsed {}) map to their effective values; scalars passed through", () => {
    const parsed = riskSchema.parse({});
    const s = mk(parsed).status();
    expect(s.limits).toEqual({
      allowedExchanges: parsed.allowedExchanges,
      allowedProducts: parsed.allowedProducts,
      symbolAllow: [],
      symbolDeny: [],
      maxQtyPerOrder: 100,
      maxNotionalPerOrder: 50000,
      maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20,
      maxNotionalPerDay: 200000,
      maxDailyLoss: 5000,
      maxOrdersPerRun: 5,
      maxShortOptionQtyPerOrder: null,
      contractValues: 0,
      marketHolidays: { NSE: 0, MCX: 0, nextNSE: null },
    });
  });
  it("unset optional maxShortOptionQtyPerOrder is null (present, not omitted), also through JSON", () => {
    const s = mk(baseRisk()).status();
    expect("maxShortOptionQtyPerOrder" in s.limits).toBe(true);
    expect(s.limits.maxShortOptionQtyPerOrder).toBeNull();
    const j = JSON.parse(JSON.stringify(s));
    expect(j.limits).toHaveProperty("maxShortOptionQtyPerOrder", null);
    expect(Object.keys(j.limits).sort()).toEqual(Object.keys(riskSchema.shape).sort());
  });
  it("explicitly undefined optional key is still null", () => {
    expect(mk(baseRisk({ maxShortOptionQtyPerOrder: undefined })).status().limits.maxShortOptionQtyPerOrder).toBeNull();
  });
  it("set optional key reports its value", () => {
    expect(mk(baseRisk({ maxShortOptionQtyPerOrder: 75 })).status().limits.maxShortOptionQtyPerOrder).toBe(75);
  });
  it("configured non-default values are reported verbatim", () => {
    const s = mk(baseRisk({ symbolAllow: ["A", "b"], symbolDeny: ["BADCO"], maxDailyLoss: 123.45 })).status();
    expect(s.limits.symbolAllow).toEqual(["A", "b"]);
    expect(s.limits.symbolDeny).toEqual(["BADCO"]);
    expect(s.limits.maxDailyLoss).toBe(123.45);
    expect(s.limits.allowedExchanges).toEqual(["NSE", "NFO", "MCX", "CRYPTO"]);
  });
  it("mode and killSwitch still reported", () => {
    const e = mk(baseRisk());
    expect(e.status()).toMatchObject({ mode: "paper", killSwitch: false });
    writeFileSync(path.join(dir, "KILL"), "");
    expect(e.status().killSwitch).toBe(true);
  });
});

describe("contractValues summary", () => {
  it("absent -> 0", () => {
    const r = baseRisk();
    delete (r as Partial<RiskConfig>).contractValues;
    expect(mk(r).status().limits.contractValues).toBe(0);
  });
  it("empty -> 0; n keys -> n", () => {
    expect(mk(baseRisk({ contractValues: {} })).status().limits.contractValues).toBe(0);
    expect(mk(baseRisk({ contractValues: { BTCUSDFUT: 0.001, ETHUSDFUT: 0.01, X: 1 } })).status().limits.contractValues).toBe(3);
  });
  it("is a number, never the map itself", () => {
    const s = mk(baseRisk({ contractValues: { BTCUSDFUT: 0.001 } })).status();
    expect(typeof s.limits.contractValues).toBe("number");
    expect(JSON.stringify(s)).not.toContain("BTCUSDFUT");
  });
});

describe("marketHolidays summary and nextNSE (pinned clock)", () => {
  it("unsorted NSE list -> earliest on/after today", () => {
    const r = baseRisk({ marketHolidays: { NSE: ["2026-12-25", "2026-03-01", "2025-12-31", "2026-01-26", "2026-01-06"] } });
    expect(holidaysAt(r, WED)).toEqual({ NSE: 5, MCX: 0, nextNSE: "2026-01-26" });
  });
  it("today being a holiday counts (>= today)", () => {
    const r = baseRisk({ marketHolidays: { NSE: ["2026-03-01", "2026-01-07"] } });
    expect(holidaysAt(r, WED).nextNSE).toBe("2026-01-07");
  });
  it("all holidays in the past -> null (counts still reported)", () => {
    const r = baseRisk({ marketHolidays: { NSE: ["2025-01-26", "2026-01-06"], MCX: ["2025-10-02"] } });
    expect(holidaysAt(r, WED)).toEqual({ NSE: 2, MCX: 1, nextNSE: null });
  });
  it("IST date boundary: 18:29:59.999Z is still the 25th, 18:30Z is the 26th", () => {
    const r = baseRisk({ marketHolidays: { NSE: ["2026-01-26", "2026-01-25"] } });
    expect(holidaysAt(r, new Date("2026-01-25T18:29:59.999Z")).nextNSE).toBe("2026-01-25");
    expect(holidaysAt(r, new Date("2026-01-25T18:30:00.000Z")).nextNSE).toBe("2026-01-26");
    expect(holidaysAt(r, new Date("2026-01-26T18:29:00Z")).nextNSE).toBe("2026-01-26");
    expect(holidaysAt(r, new Date("2026-01-26T18:30:00Z")).nextNSE).toBeNull();
  });
  it("same engine rolls nextNSE across the IST boundary", () => {
    t = new Date("2026-01-25T18:29:00Z");
    const e = mk(baseRisk({ marketHolidays: { NSE: ["2026-01-25", "2026-02-19"] } }));
    expect(e.status().limits.marketHolidays.nextNSE).toBe("2026-01-25");
    t = new Date("2026-01-25T18:30:00Z");
    expect(e.status().limits.marketHolidays.nextNSE).toBe("2026-02-19");
    expect(e.status().today.date).toBe("2026-01-26");
  });
  it("MCX-only config -> NSE 0, nextNSE null (MCX dates never leak into nextNSE)", () => {
    const r = baseRisk({ marketHolidays: { MCX: ["2026-01-26", "2026-02-01"] } });
    expect(holidaysAt(r, WED)).toEqual({ NSE: 0, MCX: 2, nextNSE: null });
  });
  it("empty, empty lists, and absent marketHolidays all -> zeros and null", () => {
    expect(holidaysAt(baseRisk({ marketHolidays: {} }), WED)).toEqual({ NSE: 0, MCX: 0, nextNSE: null });
    expect(holidaysAt(baseRisk({ marketHolidays: { NSE: [], MCX: [] } }), WED)).toEqual({ NSE: 0, MCX: 0, nextNSE: null });
    const r = baseRisk();
    delete (r as Partial<RiskConfig>).marketHolidays;
    expect(holidaysAt(r, WED)).toEqual({ NSE: 0, MCX: 0, nextNSE: null });
  });
  it("summary only: full date lists never appear in status JSON", () => {
    const r = baseRisk({ marketHolidays: { NSE: ["2026-03-01", "2026-01-26"], MCX: ["2026-08-15"] } });
    const j = JSON.stringify(mk(r).status());
    expect(j).not.toContain("2026-03-01");
    expect(j).not.toContain("2026-08-15");
    expect(j).toContain('"nextNSE":"2026-01-26"');
  });
  it("does not sort/mutate the configured list in place", () => {
    const nse = ["2026-12-25", "2026-01-26"];
    mk(baseRisk({ marketHolidays: { NSE: nse } })).status();
    expect(nse).toEqual(["2026-12-25", "2026-01-26"]);
  });
  it("via loadConfig (parsed) the summary is the same", () => {
    const f = path.join(dir, "risk.json");
    writeFileSync(f, JSON.stringify({ marketHolidays: { NSE: ["2026-02-19", "2026-01-26"], MCX: [] }, contractValues: { btcusdfut: 0.001 } }));
    const c = loadConfig({ OPENALGO_URL: "http://x", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(24), RISK_CONFIG: f });
    const s = mk(c.risk).status();
    expect(s.limits.marketHolidays).toEqual({ NSE: 2, MCX: 0, nextNSE: "2026-01-26" });
    expect(s.limits.contractValues).toBe(1);
  });
});

describe("today.remainingOrders / remainingNotional", () => {
  it("start at the limits", () => {
    expect(mk(baseRisk()).status().today).toEqual({
      date: "2026-01-07", orders: 0, notional: 0, remainingOrders: 5, remainingNotional: 10000,
    });
  });
  it("decrease after reserve(); release() restores", () => {
    const e = mk(baseRisk());
    const r = e.reserve(ord({ quantity: 3, price: 1000 }), run0);
    expect(r.allow).toBe(true);
    expect(e.status().today).toMatchObject({ orders: 1, notional: 3000, remainingOrders: 4, remainingNotional: 7000 });
    e.release(r.token!);
    expect(e.status().today).toMatchObject({ orders: 0, notional: 0, remainingOrders: 5, remainingNotional: 10000 });
  });
  it("decrease after recordOrder(), persist across reload", () => {
    const e = mk(baseRisk());
    e.recordOrder(ord(), 2500);
    expect(e.status().today).toMatchObject({ remainingOrders: 4, remainingNotional: 7500 });
    expect(mk(baseRisk()).status().today).toMatchObject({ remainingOrders: 4, remainingNotional: 7500 });
  });
  it("floor at 0 when counters exceed the limits (recordOrder does not check)", () => {
    const e = mk(baseRisk());
    for (let i = 0; i < 8; i++) e.recordOrder(ord(), 5000);
    const s = e.status().today;
    expect(s.orders).toBe(8);
    expect(s.notional).toBe(40000);
    expect(s.remainingOrders).toBe(0);
    expect(s.remainingNotional).toBe(0);
  });
  it("floor at 0 with seeded over-limit same-day state", () => {
    const sf = path.join(dir, "st", "s.json");
    mkdirSync(path.dirname(sf), { recursive: true });
    writeFileSync(sf, JSON.stringify({ date: "2026-01-07", orders: 99, notional: 1e9 }));
    expect(mk(baseRisk(), sf).status().today).toMatchObject({ orders: 99, remainingOrders: 0, remainingNotional: 0 });
  });
  it("exactly at the limit -> 0, and checkOrder denies", () => {
    const e = mk(baseRisk({ maxOrdersPerDay: 2 }));
    e.reserve(ord({ quantity: 50, price: 100 }), run0);
    e.reserve(ord({ quantity: 50, price: 100 }), run0);
    expect(e.status().today).toMatchObject({ remainingOrders: 0, remainingNotional: 0 });
    const d = e.checkOrder(ord({ quantity: 1, price: 1 }), run0);
    expect(d.reasons).toContain("maxOrdersPerDay 2 reached");
    expect(d.reasons.some((x) => x.startsWith("day notional"))).toBe(true);
  });
  it("reset on IST rollover", () => {
    const e = mk(baseRisk());
    e.recordOrder(ord(), 9000);
    t = new Date("2026-01-07T18:30:00Z");
    expect(e.status().today).toEqual({ date: "2026-01-08", orders: 0, notional: 0, remainingOrders: 5, remainingNotional: 10000 });
  });
  it("consistent with checkOrder: order allowed iff remaining >= its use", () => {
    const risk = baseRisk({ maxOrdersPerDay: 4, maxNotionalPerDay: 1000 });
    const e = mk(risk);
    const prices = [1, 99.99, 100, 250, 333.33, 0.05, 1000, 12.34];
    const qtys = [1, 2, 3, 7];
    let checked = 0;
    for (let step = 0; step < 6; step++) {
      for (const price of prices) {
        for (const quantity of qtys) {
          const o = ord({ quantity, price });
          const s = e.status().today;
          const d = e.checkOrder(o, run0);
          const notionalOk = !d.reasons.some((x) => x.startsWith("day notional"));
          const ordersOk = !d.reasons.some((x) => x.startsWith("maxOrdersPerDay"));
          expect(notionalOk, `remaining ${s.remainingNotional} vs ${quantity}*${price}`).toBe(s.remainingNotional >= quantity * price);
          expect(ordersOk).toBe(s.remainingOrders >= 1);
          expect(d.allow).toBe(notionalOk && ordersOk);
          checked++;
        }
      }
      e.reserve(ord({ quantity: 1, price: 210.5 }), run0);
    }
    expect(checked).toBe(6 * prices.length * qtys.length);
    expect(e.status().today).toMatchObject({ orders: 4, remainingOrders: 0, remainingNotional: 1000 - 4 * 210.5 });
  });
  it("CRYPTO orders consume orders but not INR notional (reserve and recordOrder)", () => {
    const e = mk(baseRisk({ contractValues: { BTCUSDFUT: 0.001 } }));
    const r = e.reserve(ord({ symbol: "BTCUSDFUT", exchange: "CRYPTO", product: "NRML", quantity: 5, price: 60000 }), run0);
    expect(r.allow).toBe(true);
    expect(e.status().today).toMatchObject({ orders: 1, notional: 0, remainingOrders: 4, remainingNotional: 10000 });
    e.recordOrder(ord({ symbol: "BTCUSDFUT", exchange: "CRYPTO" }), 999999);
    expect(e.status().today).toMatchObject({ orders: 2, notional: 0, remainingOrders: 3, remainingNotional: 10000 });
    // a CRYPTO order is never blocked by the INR day cap even when INR remaining is 0
    e.recordOrder(ord(), 20000);
    expect(e.status().today.remainingNotional).toBe(0);
    expect(e.checkOrder(ord({ symbol: "BTCUSDFUT", exchange: "CRYPTO", product: "NRML", quantity: 1, price: 100 }), run0).allow).toBe(true);
  });
  it("denied reserve() does not change remaining", () => {
    const e = mk(baseRisk());
    const before = e.status().today;
    expect(e.reserve(ord({ quantity: 200, price: 100 }), run0).allow).toBe(false);
    expect(e.status().today).toEqual(before);
  });
});

describe("no env values or secrets", () => {
  const FAKE = {
    OPENALGO_API_KEY: "FAKEAPIKEY_tm227_zzzzzzzzzzzz",
    MCP_TOKEN: "FAKEMCPTOKEN_tm227_yyyyyyyyyyyy",
    MCP_TOKEN_READONLY: "FAKEROTOKEN_tm227_xxxxxxxxxxxx",
    BT_TOKEN: "FAKEBTTOKEN_tm227_wwwwwwwwwwww",
    OPENALGO_URL: "http://fake-openalgo-tm227.invalid:5000",
  };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(FAKE)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(FAKE)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  it("JSON.stringify(status()) from a loadConfig'd engine contains no env value", async () => {
    const f = path.join(dir, "risk.json");
    writeFileSync(f, JSON.stringify({ maxShortOptionQtyPerOrder: 10, contractValues: { BTCUSDFUT: 0.001 }, marketHolidays: { NSE: ["2026-01-26"] } }));
    const cfg = loadConfig({ ...FAKE, RISK_CONFIG: f, BT_URL: "http://fake-bt-tm227.invalid" });
    const e = mk(cfg.risk);
    const b = createBindings({ client: {} as any, risk: e, cfg, auditFile: path.join(dir, "audit.log") }, { id: "r1" });
    for (const j of [JSON.stringify(e.status()), JSON.stringify(await b.risk.status())]) {
      for (const v of Object.values(FAKE)) expect(j).not.toContain(v);
      expect(j).not.toContain("tm227");
      expect(j).not.toContain(dir);
      expect(j).not.toMatch(/token|apiKey|openalgoUrl|stateFile|killSwitchFile/i);
    }
  });
});

describe("deep-copy isolation", () => {
  it("mutating every part of the returned object changes neither the engine nor the cfg", () => {
    const risk = baseRisk({
      symbolAllow: ["INFY"],
      symbolDeny: ["BADCO"],
      contractValues: { BTCUSDFUT: 0.001 },
      marketHolidays: { NSE: ["2026-01-26"], MCX: [] },
      maxShortOptionQtyPerOrder: 10,
    });
    const snapshot = structuredClone(risk);
    const e = mk(risk);
    const s: any = e.status();
    const fresh = structuredClone(s);
    s.limits.allowedExchanges.length = 0;
    s.limits.allowedProducts.push("BOGUS");
    s.limits.symbolAllow.length = 0;
    s.limits.symbolDeny.push("INFY");
    s.limits.maxOrdersPerDay = 0;
    s.limits.maxNotionalPerDay = 0;
    s.limits.maxShortOptionQtyPerOrder = null;
    s.limits.contractValues = 99;
    s.limits.marketHolidays.NSE = 0;
    s.limits.marketHolidays.nextNSE = "2026-01-07";
    s.today.orders = 1000;
    s.today.notional = 1e12;
    s.today.remainingOrders = 0;
    s.today.remainingNotional = 0;
    expect(e.status()).toEqual(fresh);
    expect(risk).toEqual(snapshot);
    expect(e.checkOrder(ord(), run0).allow).toBe(true);
  });
  it("arrays in two status() calls are distinct objects and not the cfg's arrays", () => {
    const risk = baseRisk();
    const e = mk(risk);
    const a = e.status();
    const b = e.status();
    for (const k of ["allowedExchanges", "allowedProducts", "symbolAllow", "symbolDeny"] as const) {
      expect(a.limits[k]).not.toBe(b.limits[k]);
      expect(a.limits[k]).not.toBe(risk[k]);
    }
    expect(a.limits.marketHolidays).not.toBe(b.limits.marketHolidays);
    expect(a.today).not.toBe(b.today);
  });
});

describe("risk.status binding", () => {
  it("returns the same shape and values as engine.status()", async () => {
    const risk = baseRisk({ marketHolidays: { NSE: ["2026-01-26"] }, contractValues: { A: 1, B: 2 } });
    const e = mk(risk);
    e.recordOrder(ord(), 1234);
    const cfg = { mode: "paper", risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
    const client = { quotes: vi.fn() } as any;
    const b = createBindings({ client, risk: e, cfg, auditFile: path.join(dir, "audit.log") }, { id: "r1" });
    const s: any = await b.risk.status();
    expect(s).toEqual(e.status());
    expect(Object.keys(s.limits).sort()).toEqual(Object.keys(riskSchema.shape).sort());
    expect(s.limits.maxShortOptionQtyPerOrder).toBeNull();
    expect(s.limits.contractValues).toBe(2);
    expect(s.limits.marketHolidays).toEqual({ NSE: 1, MCX: 0, nextNSE: "2026-01-26" });
    expect(s.today).toEqual({ date: "2026-01-07", orders: 1, notional: 1234, remainingOrders: 4, remainingNotional: 10000 - 1234 });
    s.limits.allowedExchanges.length = 0;
    s.today.remainingOrders = 0;
    expect(((await b.risk.status()) as any).limits.allowedExchanges).toEqual(["NSE", "NFO", "MCX", "CRYPTO"]);
    expect(e.status().today.remainingOrders).toBe(4);
  });
});
