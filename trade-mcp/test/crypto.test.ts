import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

describe("crypto docs", () => {
  it.each(["crypto", "delta"])("searchApi(%s) returns the crypto note", (q) => {
    const s = searchApi(q);
    expect(s).toContain("trade");
    expect(s).toContain("Crypto (Delta via OpenAlgo)");
    expect(s).toContain("BTC28FEB2580000CE");
    expect(s).toContain("contract_value");
  });
  it("empty search header mentions crypto", () => {
    expect(searchApi("")).toContain("Crypto (Delta via OpenAlgo)");
  });
});

describe("crypto order", () => {
  it("passes risk with USD cap at 03:00 IST Sunday", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cr-"));
    const sunday = new Date("2026-01-03T21:30:00Z"); // Sun 2026-01-04 03:00 IST
    const risk = {
      allowedExchanges: ["CRYPTO"], allowedProducts: ["NRML"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
    };
    const kill = path.join(dir, "KILL");
    const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: kill, stateFile: path.join(dir, "s.json"), now: () => sunday });
    const client: any = {
      analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
      placeOrder: vi.fn(async () => ({ status: "success", orderid: "9" })),
    };
    const cfg = { mode: "paper", risk, killSwitchFile: kill } as unknown as Config;
    const b = createBindings({ client, risk: engine, cfg, auditFile: path.join(dir, "a.jsonl") }, { id: "r" });
    const o = { symbol: "BTC28FEB2580000CE", exchange: "CRYPTO", side: "BUY", quantity: 1, product: "NRML", priceType: "LIMIT", price: 400 };
    await b.trade.place(o);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    await expect(b.trade.place({ ...o, price: 600 })).rejects.toThrow(/risk denied/);
    expect(engine.status().today.notional).toBe(0); // CRYPTO excluded from INR day total
  });
});

describe("contractValues", () => {
  it("scales CRYPTO notional by contract value; default 1", () => {
    const base = {
      allowedExchanges: ["CRYPTO"], allowedProducts: ["NRML"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 1000, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
    };
    const dir = mkdtempSync(path.join(tmpdir(), "cv-"));
    const mk = (contractValues: Record<string, number>) =>
      new RiskEngine({ ...base, contractValues }, { mode: "paper", killSwitchFile: path.join(dir, "K"), stateFile: path.join(dir, "s.json") });
    const o = { symbol: "ETHUSDFUT", exchange: "CRYPTO", product: "NRML", quantity: 100, price: 20, side: "BUY" as const };
    expect(mk({}).checkOrder(o, { ordersThisRun: 0 }).allow).toBe(false); // 2000 > 500
    expect(mk({ ETHUSDFUT: 0.01 }).checkOrder(o, { ordersThisRun: 0 }).allow).toBe(true); // 20
    expect(mk({ ethusdfut: 0.01 }).checkOrder(o, { ordersThisRun: 0 }).allow).toBe(true);
  });
});
