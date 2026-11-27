import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/risk/engine.js";
import { riskSchema, type RiskConfig } from "../src/config.js";

// Mon 2026-01-05 10:00 IST
const T = new Date("2026-01-05T04:30:00Z");
let dir: string;
const mk = (raw: object = {}, now = T) =>
  new RiskEngine(riskSchema.parse(raw) as RiskConfig, {
    mode: "paper",
    killSwitchFile: path.join(dir, "KILL"),
    stateFile: path.join(dir, "state.json"),
    now: () => now,
  });
const ord = { symbol: "SBIN", exchange: "NSE", product: "MIS", quantity: 10, price: 100, side: "BUY" as const };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tm2-27-"));
});

describe("risk.status reports every configured limit", () => {
  it("has every riskSchema key", () => {
    const s = mk().status();
    for (const k of Object.keys(riskSchema.shape)) expect(s.limits).toHaveProperty(k);
  });
  it("unset optional key is null, set value is shown", () => {
    expect(mk().status().limits.maxShortOptionQtyPerOrder).toBeNull();
    expect(mk({ maxShortOptionQtyPerOrder: 50 }).status().limits.maxShortOptionQtyPerOrder).toBe(50);
  });
  it("summarises holidays with a pinned clock", () => {
    const s = mk({ marketHolidays: { NSE: ["2026-01-01", "2026-03-03", "2026-01-26"], MCX: ["2026-01-26"] } }).status();
    expect(s.limits.marketHolidays).toEqual({ NSE: 3, MCX: 1, nextNSE: "2026-01-26" });
  });
  it("nextNSE includes today and is null when none upcoming/unset", () => {
    expect(mk({ marketHolidays: { NSE: ["2026-01-05"] } }).status().limits.marketHolidays.nextNSE).toBe("2026-01-05");
    expect(mk({ marketHolidays: { NSE: ["2026-01-01"] } }).status().limits.marketHolidays).toEqual({ NSE: 1, MCX: 0, nextNSE: null });
    expect(mk().status().limits.marketHolidays).toEqual({ NSE: 0, MCX: 0, nextNSE: null });
  });
  it("contractValues is a count", () => {
    expect(mk({ contractValues: { BTCUSD: 0.001, ETHUSD: 0.01 } }).status().limits.contractValues).toBe(2);
  });
  it("remaining values track usage and never go negative", () => {
    const e = mk({ maxOrdersPerDay: 2, maxNotionalPerDay: 1500 });
    expect(e.status().today).toMatchObject({ remainingOrders: 2, remainingNotional: 1500 });
    e.recordOrder(ord, 1000);
    expect(e.status().today).toMatchObject({ orders: 1, notional: 1000, remainingOrders: 1, remainingNotional: 500 });
    e.recordOrder(ord, 1000);
    e.recordOrder(ord, 1000);
    expect(e.status().today).toMatchObject({ remainingOrders: 0, remainingNotional: 0 });
  });
  it("crypto orders use no INR notional", () => {
    const e = mk({ maxNotionalPerDay: 1000 });
    e.recordOrder({ ...ord, exchange: "CRYPTO" }, 900);
    expect(e.status().today).toMatchObject({ orders: 1, remainingNotional: 1000 });
  });
  it("contains no env values and is a copy", () => {
    process.env.TM2_27_SECRET = "s3cr3t-value";
    const e = mk();
    const s = e.status();
    expect(JSON.stringify(s)).not.toContain("s3cr3t-value");
    s.limits.allowedExchanges.length = 0;
    expect(e.status().limits.allowedExchanges.length).toBeGreaterThan(0);
    delete process.env.TM2_27_SECRET;
  });
});
