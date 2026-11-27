import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMarketOpen, istParts } from "../src/risk/hours.js";
import { RiskEngine, type RiskOrder } from "../src/risk/engine.js";
import { loadConfig, ConfigError, type RiskConfig } from "../src/config.js";

const MON_10 = new Date("2026-01-26T04:30:00Z"); // Mon 2026-01-26 10:00 IST
const H = { NSE: ["2026-01-26"] };

describe("isMarketOpen holidays", () => {
  it("NSE date blocks NSE/NFO/BSE/BFO/CDS but not MCX", () => {
    for (const ex of ["NSE", "NFO", "BSE", "BFO", "CDS"]) expect(isMarketOpen(ex, MON_10, H)).toBe(false);
    expect(isMarketOpen("MCX", MON_10, H)).toBe(true);
    expect(isMarketOpen("nse", MON_10, H)).toBe(false);
  });
  it("MCX listed blocks MCX only", () => {
    const h = { MCX: ["2026-01-26"] };
    expect(isMarketOpen("MCX", MON_10, h)).toBe(false);
    expect(isMarketOpen("NSE", MON_10, h)).toBe(true);
  });
  it("IST date boundary (2026-01-25 18:29Z = 25th, 18:30Z = 26th)", () => {
    expect(istParts(new Date("2026-01-25T18:29:00Z")).date).toBe("2026-01-25");
    expect(istParts(new Date("2026-01-25T18:30:00Z")).date).toBe("2026-01-26");
    const h = { MCX: ["2026-01-26"] };
    // Mon 26th 09:00 IST (03:30Z) is blocked when the 26th is listed, open when only the 25th is listed.
    expect(isMarketOpen("MCX", new Date("2026-01-26T03:30:00Z"), h)).toBe(false);
    expect(isMarketOpen("MCX", new Date("2026-01-26T03:30:00Z"), { MCX: ["2026-01-25"] })).toBe(true);
    // Mon 2026-02-02 23:29 IST (17:59Z) is still the 2nd: listed 2nd blocks, listed 3rd does not.
    expect(isMarketOpen("MCX", new Date("2026-02-02T17:59:00Z"), { MCX: ["2026-02-02"] })).toBe(false);
    expect(isMarketOpen("MCX", new Date("2026-02-02T17:59:00Z"), { MCX: ["2026-02-03"] })).toBe(true);
  });
  it("weekends and session hours unchanged; CRYPTO never blocked; {} no change", () => {
    expect(isMarketOpen("NSE", new Date("2026-01-24T04:30:00Z"), H)).toBe(false); // Saturday
    expect(isMarketOpen("NSE", new Date("2026-01-27T03:44:00Z"), H)).toBe(false); // 09:14
    expect(isMarketOpen("NSE", new Date("2026-01-27T03:45:00Z"), H)).toBe(true); // 09:15
    expect(isMarketOpen("NSE", new Date("2026-01-27T10:00:00Z"), H)).toBe(false); // 15:30
    expect(isMarketOpen("CRYPTO", MON_10, { NSE: ["2026-01-26"], MCX: ["2026-01-26"] })).toBe(true);
    expect(isMarketOpen("NSE", MON_10, {})).toBe(true);
    expect(isMarketOpen("NSE", MON_10)).toBe(true);
    expect(isMarketOpen("XXX", MON_10, H)).toBe(false);
  });
});

function cfgWith(risk: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "tm3-"));
  const f = path.join(dir, "risk.json");
  writeFileSync(f, JSON.stringify(risk));
  return () => loadConfig({ OPENALGO_URL: "http://x", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(24), RISK_CONFIG: f });
}

describe("marketHolidays config", () => {
  it("default {} and valid parse", () => {
    expect(cfgWith({})().risk.marketHolidays).toEqual({});
    expect(cfgWith({ marketHolidays: { NSE: ["2026-01-26"], MCX: [] } })().risk.marketHolidays).toEqual({ NSE: ["2026-01-26"], MCX: [] });
  });
  const bad: Array<[string, unknown, string]> = [
    ["bad format", { NSE: ["2026-1-5"] }, "2026-1-5"],
    ["impossible date", { NSE: ["2026-02-30"] }, "2026-02-30"],
    ["empty string", { NSE: [""] }, "NSE"],
    ["non-string", { NSE: [20260126] }, "20260126"],
    ["unknown group", { BSE: ["2026-01-26"] }, "BSE"],
    ["non-array", { NSE: "2026-01-26" }, "2026-01-26"],
  ];
  for (const [name, mh, leak] of bad) {
    it(`rejects ${name} without echoing values`, () => {
      let err: unknown;
      try { cfgWith({ marketHolidays: mh })(); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain("marketHolidays");
      expect(msg).not.toContain(leak);
      expect(msg).not.toMatch(/\d{4}-\d/);
    });
  }
});

describe("RiskEngine holiday reason", () => {
  it("blocks with 'market closed for NSE'", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tm3e-"));
    const risk: RiskConfig = {
      allowedExchanges: ["NSE"], allowedProducts: ["CNC"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
      marketHolidays: { NSE: ["2026-01-26"] },
    };
    const o: RiskOrder = { symbol: "INFY", exchange: "NSE", product: "CNC", quantity: 1, price: 100, side: "BUY" };
    const mk = (r: RiskConfig) => new RiskEngine(r, { mode: "paper", killSwitchFile: path.join(dir, "KILL"), stateFile: path.join(dir, "s.json"), now: () => MON_10 });
    const res = mk(risk).checkOrder(o, { ordersThisRun: 0 });
    expect(res.allow).toBe(false);
    expect(res.reasons).toContain("market closed for NSE");
    expect(mk({ ...risk, marketHolidays: {} }).checkOrder(o, { ordersThisRun: 0 }).allow).toBe(true);
  });
});
