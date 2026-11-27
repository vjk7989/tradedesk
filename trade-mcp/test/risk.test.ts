import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/risk/engine.js";
import { isMarketOpen } from "../src/risk/hours.js";
import { appendAudit } from "../src/risk/audit.js";
import type { RiskConfig } from "../src/config.js";

const cfg: RiskConfig = {
  allowedExchanges: ["NSE", "CRYPTO"],
  allowedProducts: ["MIS", "CNC"],
  symbolAllow: [],
  symbolDeny: ["BADCO"],
  maxQtyPerOrder: 100,
  maxNotionalPerOrder: 50000,
  maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 3,
  maxNotionalPerDay: 60000,
  maxDailyLoss: 1000,
  maxOrdersPerRun: 2,
};
// Wed 2026-01-07 10:00 IST = 04:30 UTC
const OPEN = new Date("2026-01-07T04:30:00Z");
let dir: string;
let t: Date;
const mk = (c: Partial<RiskConfig> = {}) =>
  new RiskEngine({ ...cfg, ...c }, {
    mode: "paper",
    killSwitchFile: path.join(dir, "KILL"),
    stateFile: path.join(dir, "s", "state.json"),
    now: () => t,
  });
const ord = (o: object = {}) => ({ symbol: "SBIN", exchange: "NSE", product: "MIS", quantity: 10, price: 100, side: "BUY" as const, ...o });
const run = { ordersThisRun: 0 };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "risk-"));
  t = OPEN;
});

describe("hours", () => {
  it("IST windows", () => {
    expect(isMarketOpen("NSE", new Date("2026-01-07T03:45:00Z"))).toBe(true); // 09:15
    expect(isMarketOpen("NSE", new Date("2026-01-07T03:44:00Z"))).toBe(false);
    expect(isMarketOpen("NSE", new Date("2026-01-07T10:00:00Z"))).toBe(false); // 15:30
    expect(isMarketOpen("MCX", new Date("2026-01-07T17:59:00Z"))).toBe(true); // 23:29
    expect(isMarketOpen("NSE", new Date("2026-01-10T05:00:00Z"))).toBe(false); // Sat
    expect(isMarketOpen("CRYPTO", new Date("2026-01-10T05:00:00Z"))).toBe(true);
    expect(isMarketOpen("XYZ", OPEN)).toBe(false);
  });
});

describe("RiskEngine rules", () => {
  it("allows a good order", () => {
    expect(mk().checkOrder(ord(), run)).toEqual({ allow: true, reasons: [] });
  });
  it("kill switch", () => {
    const e = mk();
    writeFileSync(path.join(dir, "KILL"), "");
    expect(e.checkOrder(ord(), run).allow).toBe(false);
    expect(e.status().killSwitch).toBe(true);
  });
  it.each([
    ["exchange", { exchange: "BSE" }],
    ["product", { product: "NRML" }],
    ["deny", { symbol: "badco" }],
    ["qty", { quantity: 101 }],
    ["qty frac", { quantity: 1.5 }],
    ["price missing", { price: undefined }],
    ["notional", { quantity: 100, price: 600 }],
  ])("denies %s", (_n, o) => {
    expect(mk().checkOrder(ord(o), run).allow).toBe(false);
  });
  it("allow list is case-insensitive", () => {
    const e = mk({ symbolAllow: ["sbin"] });
    expect(e.checkOrder(ord(), run).allow).toBe(true);
    expect(e.checkOrder(ord({ symbol: "TCS" }), run).allow).toBe(false);
  });
  it("crypto uses USD cap and is always open", () => {
    t = new Date("2026-01-10T05:00:00Z");
    const e = mk();
    expect(e.checkOrder(ord({ exchange: "CRYPTO", quantity: 1, price: 400 }), run).allow).toBe(true);
    expect(e.checkOrder(ord({ exchange: "CRYPTO", quantity: 1, price: 600 }), run).allow).toBe(false);
  });
  it("run, day orders, day notional, loss, closed", () => {
    expect(mk().checkOrder(ord(), { ordersThisRun: 2 }).allow).toBe(false);
    expect(mk().checkOrder(ord(), run, -1000).allow).toBe(false);
    expect(mk().checkOrder(ord(), run, -999).allow).toBe(true);
    t = new Date("2026-01-07T11:00:00Z");
    expect(mk().checkOrder(ord(), run).reasons.join()).toContain("market closed");
    t = OPEN;
    const e = mk();
    e.recordOrder(ord(), 55000);
    expect(e.checkOrder(ord({ quantity: 100, price: 100 }), run).reasons.join()).toContain("maxNotionalPerDay");
    e.recordOrder(ord(), 1);
    e.recordOrder(ord(), 1);
    expect(e.checkOrder(ord(), run).reasons.join()).toContain("maxOrdersPerDay");
  });
  it("collects all reasons", () => {
    const r = mk().checkOrder(ord({ exchange: "BSE", product: "X", quantity: 0 }), run);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
  it("crypto notional excluded from INR day total", () => {
    const e = mk();
    e.recordOrder(ord({ exchange: "CRYPTO" }), 400);
    expect(e.status().today).toMatchObject({ orders: 1, notional: 0 });
  });
});

describe("RiskEngine state", () => {
  it("persists, resets on IST date change, survives corrupt file", () => {
    const e = mk();
    e.recordOrder(ord(), 1000);
    expect(mk().status().today).toMatchObject({ orders: 1, notional: 1000 });
    // 2026-01-07 19:00 UTC = 2026-01-08 00:30 IST
    t = new Date("2026-01-07T19:00:00Z");
    expect(e.status().today).toMatchObject({ date: "2026-01-08", orders: 0, notional: 0 });
    writeFileSync(path.join(dir, "s", "state.json"), "{not json");
    t = OPEN;
    expect(mk().status().today.orders).toBe(0);
  });
});

describe("audit", () => {
  it("writes redacted JSON lines", () => {
    const f = path.join(dir, "a", "b", "audit.log");
    appendAudit(f, { tool: "x", apikey: "K1", nested: { Authorization: "Bearer Z", arr: [{ token: "T" }], ok: 1 } });
    const raw = readFileSync(f, "utf8");
    expect(raw).not.toMatch(/K1|Bearer|"T"/);
    const j = JSON.parse(raw.trim());
    expect(j.ts).toMatch(/^\d{4}-/);
    expect(j.nested.ok).toBe(1);
  });
});
