import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const OPEN = new Date("2026-01-07T04:30:00Z"); // Wed 10:00 IST
let dir: string;
let client: any;

function setup(mode: "paper" | "live" = "paper") {
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const kill = path.join(dir, "KILL");
  const engine = new RiskEngine(risk, { mode, killSwitchFile: kill, stateFile: path.join(dir, "st.json"), now: () => OPEN });
  const auditFile = path.join(dir, "audit.log");
  const cfg = { mode, risk, killSwitchFile: kill } as unknown as Config;
  const b = createBindings({ client, risk: engine, cfg, auditFile }, { id: "r1" });
  return { b, engine, kill, auditFile };
}
const order = { symbol: "SBIN", exchange: "NSE", side: "BUY", quantity: 10, product: "MIS", priceType: "LIMIT", price: 100 };
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sdk-"));
  client = {
    quotes: vi.fn(async () => ({ status: "success", data: { ltp: 200 } })),
    analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
    pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
    placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    cancelOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
  };
});

describe("trade bindings", () => {
  it("places an allowed order with OpenAlgo field names and audits it", async () => {
    const { b, engine, auditFile } = setup();
    await b.trade.place(order);
    expect(client.placeOrder).toHaveBeenCalledWith({
      strategy: "trade-mcp", symbol: "SBIN", exchange: "NSE", action: "BUY",
      pricetype: "LIMIT", product: "MIS", quantity: 10, price: 100,
    });
    expect(engine.status().today.orders).toBe(1);
    expect(lines(auditFile)[0]).toMatchObject({ run: "r1", action: "trade.place", decision: "allowed" });
  });

  it("throws on risk denial, places nothing, audits", async () => {
    const { b, auditFile } = setup();
    await expect(b.trade.place({ ...order, quantity: 1000 })).rejects.toThrow(/^risk denied: /);
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(lines(auditFile)[0]).toMatchObject({ decision: "denied" });
  });

  it("refuses in paper mode when analyzer is off", async () => {
    client.analyzerStatus = vi.fn(async () => ({ status: "success", data: { analyze_mode: false } }));
    const { b, auditFile } = setup();
    await expect(b.trade.place(order)).rejects.toThrow("paper mode requires OpenAlgo analyzer ON");
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(lines(auditFile)[0].decision).toBe("error");
  });

  it("fetches LTP for market orders", async () => {
    const { b, engine } = setup();
    await b.trade.place({ ...order, priceType: "MARKET", price: undefined });
    expect(client.quotes).toHaveBeenCalledWith({ symbol: "SBIN", exchange: "NSE" });
    expect(engine.status().today.notional).toBe(2000);
  });

  it("rejects unknown and missing fields", async () => {
    const { b } = setup();
    await expect(b.trade.place({ ...order, bogus: 1 })).rejects.toThrow(/unknown field "bogus"/);
    await expect(b.trade.place({ symbol: "SBIN" })).rejects.toThrow(/missing field/);
  });

  it("cancel works under kill switch", async () => {
    const { b, kill, auditFile } = setup();
    writeFileSync(kill, "");
    await b.trade.cancel({ orderId: "1" });
    expect(client.cancelOrder).toHaveBeenCalledWith({ orderid: "1", strategy: "trade-mcp" });
    await expect(b.trade.place(order)).rejects.toThrow(/kill switch/);
    expect(lines(auditFile).map((l) => l.action)).toEqual(["trade.cancel", "trade.place"]);
  });
});

describe("searchApi", () => {
  it("empty returns index", () => {
    const s = searchApi("  ");
    expect(s).toContain("Namespaces:");
    expect(s).toContain("trade: place");
  });
  it("match returns declarations", () => {
    const s = searchApi("OPTION chain");
    expect(s).toContain("declare namespace market");
    expect(s).toContain("optionChain");
  });
  it("no match", () => {
    expect(searchApi("zzzqqq")).toContain("No API entries match");
  });
});
