import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/risk/engine.js";
import type { RiskConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";

const base: RiskConfig = {
  allowedExchanges: ["NSE", "NFO", "BFO"],
  allowedProducts: ["MIS", "NRML"],
  symbolAllow: [],
  symbolDeny: [],
  maxQtyPerOrder: 10000,
  maxNotionalPerOrder: 10_000_000,
  maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 100,
  maxNotionalPerDay: 100_000_000,
  maxDailyLoss: 1000,
  maxOrdersPerRun: 50,
};
// Wed 2026-01-07 10:00 IST
const OPEN = new Date("2026-01-07T04:30:00Z");
let dir: string;
const mk = (c: Partial<RiskConfig> = {}) =>
  new RiskEngine({ ...base, ...c }, {
    mode: "paper",
    killSwitchFile: path.join(dir, "KILL"),
    stateFile: path.join(dir, "state.json"),
    now: () => OPEN,
  });
const ord = (o: object = {}) => ({ symbol: "NIFTY07JAN2626000CE", exchange: "NFO", product: "NRML", quantity: 100, price: 10, side: "SELL" as const, ...o });
const check = (o: object, c: Partial<RiskConfig> = {}) => mk(c).checkOrder(ord(o), { ordersThisRun: 0 });
const CAP = { maxShortOptionQtyPerOrder: 100 };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tm223-"));
});

describe("TM2-23 short option qty cap", () => {
  it("off by default: huge short option sell allowed", () => {
    expect(check({ quantity: 5000 }).allow).toBe(true);
  });
  it("CE and PE SELL over the limit refused with reason", () => {
    const d = check({ quantity: 150 }, CAP);
    expect(d.allow).toBe(false);
    expect(d.reasons).toContain("short option qty 150 exceeds maxShortOptionQtyPerOrder 100");
    expect(check({ symbol: "BANKNIFTY07JAN2650000PE", quantity: 101 }, CAP).allow).toBe(false);
  });
  it("at the limit allowed", () => {
    expect(check({ quantity: 100 }, CAP).allow).toBe(true);
  });
  it("BUY over the limit allowed", () => {
    expect(check({ side: "BUY", quantity: 150 }, CAP).allow).toBe(true);
  });
  it("FUT and equity SELL unaffected", () => {
    expect(check({ symbol: "NIFTY27JAN26FUT", quantity: 150 }, CAP).allow).toBe(true);
    expect(check({ symbol: "SBIN", exchange: "NSE", product: "MIS", quantity: 150 }, CAP).allow).toBe(true);
  });
  it("BFO applies; lowercase and whitespace normalised", () => {
    expect(check({ symbol: " sensex07jan2685000ce ", exchange: " bfo ", quantity: 150 }, CAP).allow).toBe(false);
    expect(check({ symbol: "nifty07jan2626000pe", exchange: "nfo", quantity: 150 }, CAP).allow).toBe(false);
  });
  it("does not loosen other checks", () => {
    const d = check({ quantity: 50, product: "CNC" }, CAP);
    expect(d.allow).toBe(false);
  });
  it("loadConfig accepts the key and rejects non-positive", () => {
    const env = { OPENALGO_URL: "http://localhost:5000", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(32) };
    const load = (j: object) => {
      const f = path.join(dir, "risk.json");
      writeFileSync(f, JSON.stringify(j));
      return loadConfig({ ...env, RISK_CONFIG: f });
    };
    expect(load({ maxShortOptionQtyPerOrder: 50 }).risk.maxShortOptionQtyPerOrder).toBe(50);
    expect(() => load({ maxShortOptionQtyPerOrder: 0 })).toThrow();
  });
});
