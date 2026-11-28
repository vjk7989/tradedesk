import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config, RiskConfig } from "../src/config.js";
import { createBindings } from "../src/sdk/bindings.js";

const MON_10AM_IST = new Date("2026-01-05T04:30:00Z");
const SUN_3AM_IST = new Date("2026-01-03T21:30:00Z");
const risk: RiskConfig = {
  allowedExchanges: ["CRYPTO"], allowedProducts: ["NRML"], symbolAllow: [], symbolDeny: [],
  maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 50,
};

function setup(now = MON_10AM_IST) {
  const dir = mkdtempSync(path.join(tmpdir(), "o17-"));
  return { kill: path.join(dir, "KILL"), auditFile: path.join(dir, "a.jsonl"), dir };
}
const args = { symbol: "BTCUSDFUT", exchange: "CRYPTO", side: "BUY", quantity: 500, product: "NRML", priceType: "MARKET" };

describe("O-17 static checks run before any client call", () => {
  for (const fn of ["place", "modify"] as const) {
    const extra = fn === "modify" ? { orderId: "1" } : {};
    it(`${fn}: over-qty denied, zero client calls, audited denied`, async () => {
      const s = setup();
      const used: string[] = [];
      const client: any = new Proxy({}, { get: (_t, k) => (..._a: unknown[]) => { used.push(String(k)); throw new Error("HTTP 403"); } });
      const b = createBindings({ client, risk: new RiskEngine(risk, { mode: "paper", killSwitchFile: s.kill, stateFile: path.join(s.dir, "x.json"), now: () => MON_10AM_IST }), cfg: { mode: "paper", risk } as any, auditFile: s.auditFile }, { id: "r" });
      await expect((b.trade as any)[fn]({ ...args, ...extra })).rejects.toThrow("risk denied: quantity 500 exceeds maxQtyPerOrder 100");
      await expect((b.trade as any)[fn]({ ...args, ...extra, quantity: 1, exchange: "NSE" })).rejects.toThrow("risk denied: exchange NSE not allowed");
      await expect((b.trade as any)[fn]({ ...args, ...extra, quantity: 1, product: "MIS" })).rejects.toThrow("risk denied: product MIS not allowed");
      writeFileSync(s.kill, "x");
      await expect((b.trade as any)[fn]({ ...args, ...extra, quantity: 1 })).rejects.toThrow("risk denied: kill switch active");
      expect(used).toEqual([]);
      const lines = readFileSync(s.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.decision)).toEqual(["denied", "denied", "denied", "denied"]);
    });
    it(`${fn}: closed market denied with zero client calls`, async () => {
      const s = setup(SUN_3AM_IST);
      const used: string[] = [];
      const client: any = new Proxy({}, { get: (_t, k) => () => { used.push(String(k)); throw new Error("HTTP 403"); } });
      const nse = { ...risk, allowedExchanges: ["NSE"] };
      const b = createBindings({ client, risk: new RiskEngine(nse, { mode: "paper", killSwitchFile: s.kill, stateFile: path.join(s.dir, "y.json"), now: () => SUN_3AM_IST }), cfg: { mode: "paper", risk: nse } as any, auditFile: s.auditFile }, { id: "r" });
      await expect((b.trade as any)[fn]({ ...args, ...extra, exchange: "NSE", quantity: 1 })).rejects.toThrow("risk denied: market closed for NSE");
      expect(used).toEqual([]);
    });
    it(`${fn}: valid-size order still fetches the quote`, async () => {
      const s = setup();
      const used: string[] = [];
      const client: any = new Proxy({}, { get: (_t, k) => () => { used.push(String(k)); throw new Error("HTTP 403"); } });
      const b = createBindings({ client, risk: new RiskEngine(risk, { mode: "paper", killSwitchFile: s.kill, stateFile: path.join(s.dir, "z.json"), now: () => MON_10AM_IST }), cfg: { mode: "paper", risk } as any, auditFile: s.auditFile }, { id: "r" });
      await expect((b.trade as any)[fn]({ ...args, ...extra, quantity: 1 })).rejects.toThrow("HTTP 403");
      expect(used).toEqual(["quotes"]);
    });
  }
});
