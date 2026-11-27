import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine, type RiskOrder } from "../src/risk/engine.js";
import { loadConfig, ConfigError, type Config, type RiskConfig } from "../src/config.js";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";

const SUNDAY_3AM_IST = new Date("2026-01-03T21:30:00Z"); // Sun 2026-01-04 03:00 IST
const MONDAY_10AM_IST = new Date("2026-01-05T04:30:00Z"); // Mon 2026-01-05 10:00 IST

const baseRisk: RiskConfig = {
  allowedExchanges: ["NSE", "CRYPTO"], allowedProducts: ["NRML", "CNC"], symbolAllow: [], symbolDeny: [],
  maxQtyPerOrder: 1000, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 50,
};

function mk(contractValues: Record<string, number> | undefined, now = SUNDAY_3AM_IST, extra: Partial<RiskConfig> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cre-"));
  const cfg = { ...baseRisk, ...extra, ...(contractValues === undefined ? {} : { contractValues }) };
  const engine = new RiskEngine(cfg, { mode: "paper", killSwitchFile: path.join(dir, "KILL"), stateFile: path.join(dir, "s.json"), now: () => now });
  return { engine, dir, cfg };
}
const run0 = { ordersThisRun: 0 };
const co = (p: Partial<RiskOrder> = {}): RiskOrder => ({ symbol: "ETHUSDFUT", exchange: "CRYPTO", product: "NRML", quantity: 100, price: 20, side: "BUY", ...p });
const notionalReason = (r: string[]) => r.find((x) => x.startsWith("notional"));

describe("AC: CRYPTO notional = qty * contractValue * price vs USD cap", () => {
  it("missing contractValues key / empty map / absent field -> factor 1", () => {
    for (const cv of [undefined, {}, { OTHERFUT: 0.01 }] as (Record<string, number> | undefined)[]) {
      const d = mk(cv).engine.checkOrder(co(), run0);
      expect(notionalReason(d.reasons)).toContain("notional 2000 ");
    }
  });
  it("listed symbol scales notional", () => {
    expect(mk({ ETHUSDFUT: 0.01 }).engine.checkOrder(co(), run0).allow).toBe(true);
    expect(mk({ ETHUSDFUT: 10 }).engine.checkOrder(co({ quantity: 1 }), run0).allow).toBe(true); // 200
    expect(notionalReason(mk({ ETHUSDFUT: 30 }).engine.checkOrder(co({ quantity: 1 }), run0).reasons)).toContain("notional 600 ");
  });
  it.each([
    ["lowercase config key", { ethusdfut: 0.01 }, "ETHUSDFUT"],
    ["padded config key", { "  ETHUSDFUT  ": 0.01 }, "ETHUSDFUT"],
    ["lowercase+padded order symbol", { ETHUSDFUT: 0.01 }, "  ethusdfut "],
    ["mixed both sides", { " EthUsdFut": 0.01 }, "ethUSDfut  "],
  ])("lookup case-insensitive and trimmed: %s", (_n, cv, sym) => {
    expect(mk(cv).engine.checkOrder(co({ symbol: sym }), run0).allow).toBe(true);
  });
  it("same symbol twice with different case: one of them is used (REPORT which)", () => {
    const d1 = mk({ ethusdfut: 0.01, ETHUSDFUT: 1 }).engine.checkOrder(co(), run0);
    const d2 = mk({ ETHUSDFUT: 1, ethusdfut: 0.01 }).engine.checkOrder(co(), run0);
    console.log("[dup-case] {ethusdfut:0.01,ETHUSDFUT:1} allow=", d1.allow, "; {ETHUSDFUT:1,ethusdfut:0.01} allow=", d2.allow);
    // first-in-insertion-order wins under current impl; not asserted as policy
  });

  describe("cap boundary with minor-unit rounding (cap 500 USD)", () => {
    it("tiny contract value 1e-9: exact cap allowed, +0.01 denied", () => {
      const { engine } = mk({ ETHUSDFUT: 1e-9 });
      expect(engine.checkOrder(co({ quantity: 1, price: 5e11 }), run0).allow).toBe(true); // 500.00
      const d = engine.checkOrder(co({ quantity: 1, price: 5.0001e11 }), run0); // 500.01
      expect(d.allow).toBe(false);
      expect(notionalReason(d.reasons)).toBeDefined();
    });
    it("huge contract value 1e6: exact cap allowed, +0.01 denied", () => {
      const { engine } = mk({ ETHUSDFUT: 1e6 });
      expect(engine.checkOrder(co({ quantity: 1, price: 0.0005 }), run0).allow).toBe(true); // 500.00
      expect(engine.checkOrder(co({ quantity: 1, price: 0.00050001 }), run0).allow).toBe(false); // 500.01
    });
    it("sub-minor overshoot (500.004) rounds to cap and is allowed; 500.005 denied", () => {
      const { engine } = mk({ ETHUSDFUT: 0.5 });
      expect(engine.checkOrder(co({ quantity: 1, price: 1000.008 }), run0).allow).toBe(true);
      expect(engine.checkOrder(co({ quantity: 1, price: 1000.02 }), run0).allow).toBe(false);
    });
    it("USD cap, not INR cap, applies to CRYPTO even with contract value", () => {
      // 1 * 1 * 600 = 600 USD > 500 USD, though far below INR 50000
      expect(mk({ ETHUSDFUT: 1 }).engine.checkOrder(co({ quantity: 1, price: 600 }), run0).allow).toBe(false);
    });
  });

  it("CRYPTO is 24x7 (Sunday 03:00 IST) with contract value set", () => {
    const d = mk({ ETHUSDFUT: 0.01 }).engine.checkOrder(co(), run0);
    expect(d.reasons.some((r) => r.includes("market closed"))).toBe(false);
  });
  it("CRYPTO with large scaled notional does not hit INR day cap", () => {
    // 1000 * 1e6 * 0.0005 = 500 USD; INR day cap 1 would deny if day-total applied
    const { engine } = mk({ ETHUSDFUT: 1e6 }, SUNDAY_3AM_IST, { maxNotionalPerDay: 1 });
    expect(engine.checkOrder(co({ quantity: 1, price: 0.0005 }), run0).allow).toBe(true);
  });
});

describe("AC: non-CRYPTO unchanged, contractValues ignored", () => {
  it("NSE symbol listed in contractValues keeps qty*price INR notional", () => {
    const { engine } = mk({ RELIANCE: 0.001 }, MONDAY_10AM_IST);
    const o = co({ symbol: "RELIANCE", exchange: "NSE", product: "CNC", quantity: 100, price: 600 }); // 60000 > 50000
    const d = engine.checkOrder(o, run0);
    expect(d.allow).toBe(false);
    expect(notionalReason(d.reasons)).toContain("notional 60000 ");
    const ok = engine.reserve({ ...o, price: 400 }, run0); // 40000
    expect(ok.allow).toBe(true);
    expect(ok.token?.notional).toBe(40000);
    expect(engine.status().today.notional).toBe(40000);
  });
  it("NSE symbol listed with huge value does not inflate notional", () => {
    const { engine } = mk({ RELIANCE: 1e6 }, MONDAY_10AM_IST);
    expect(engine.checkOrder(co({ symbol: "RELIANCE", exchange: "NSE", product: "CNC", quantity: 1, price: 100 }), run0).allow).toBe(true);
  });
});

describe("AC: reserve() path (concurrency) honours contract value like checkOrder", () => {
  it("reserve agrees with checkOrder for allowed and denied", () => {
    const { engine } = mk({ ETHUSDFUT: 0.01 });
    expect(engine.reserve(co(), run0).allow).toBe(engine.checkOrder(co(), run0).allow);
    const big = co({ quantity: 1000, price: 60 }); // 600 USD
    expect(engine.checkOrder(big, run0).allow).toBe(false);
    expect(engine.reserve(big, run0).allow).toBe(false);
  });
  it("CRYPTO reserve: day order count increments, INR day notional stays 0, release undoes", () => {
    const { engine } = mk({ ETHUSDFUT: 0.01 });
    const t1 = engine.reserve(co(), run0);
    const t2 = engine.reserve(co(), run0);
    expect(t1.token?.notional).toBe(0);
    expect(engine.status().today).toMatchObject({ orders: 2, notional: 0 });
    engine.release(t2.token!);
    engine.commit(t1.token!);
    expect(engine.status().today).toMatchObject({ orders: 1, notional: 0 });
  });
  it("concurrent reserves hit maxOrdersPerDay for CRYPTO", () => {
    const { engine } = mk({ ETHUSDFUT: 0.01 }, SUNDAY_3AM_IST, { maxOrdersPerDay: 2 });
    const res = [1, 2, 3].map(() => engine.reserve(co(), run0));
    expect(res.map((r) => r.allow)).toEqual([true, true, false]);
  });
  it("recordOrder for CRYPTO increments orders, not INR notional", () => {
    const { engine } = mk({ ETHUSDFUT: 0.01 });
    engine.recordOrder(co(), 20);
    expect(engine.status().today).toMatchObject({ orders: 1, notional: 0 });
  });
});

function bindings(contractValues: Record<string, number>) {
  const { engine, dir, cfg: risk } = mk(contractValues);
  const client: any = {
    analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
    placeOrder: vi.fn(async () => ({ status: "success", orderid: "9" })),
    modifyOrder: vi.fn(async () => ({ status: "success", orderid: "9" })),
  };
  const auditFile = path.join(dir, "a.jsonl");
  const cfg = { mode: "paper", risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
  const b = createBindings({ client, risk: engine, cfg, auditFile }, { id: "r" });
  return { b, client, engine, auditFile };
}
const placeArgs = { symbol: "ETHUSDFUT", exchange: "CRYPTO", side: "BUY", quantity: 100, product: "NRML", priceType: "LIMIT", price: 20 };

describe("bindings: place/modify use contract value", () => {
  it("place: scaled notional allowed; unscaled would be denied", async () => {
    const { b, client, engine } = bindings({ ethusdfut: 0.01 });
    await b.trade.place(placeArgs);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(engine.status().today).toMatchObject({ orders: 1, notional: 0 });
    await expect(b.trade.place({ ...placeArgs, price: 600 })).rejects.toThrow(/risk denied/); // 600 USD
    expect(engine.status().today.orders).toBe(1);
  });
  it("modify: uses contract value and does not count orders", async () => {
    const { b, client, engine } = bindings({ ETHUSDFUT: 0.01 });
    await b.trade.modify({ ...placeArgs, orderId: "9" });
    expect(client.modifyOrder).toHaveBeenCalledTimes(1);
    await expect(b.trade.modify({ ...placeArgs, orderId: "9", price: 501 })).rejects.toThrow(/risk denied/); // 501 USD
    expect(client.modifyOrder).toHaveBeenCalledTimes(1);
    expect(engine.status().today.orders).toBe(0);
  });
  it("modify without contract value denies (factor 1)", async () => {
    const { b, client } = bindings({});
    await expect(b.trade.modify({ ...placeArgs, orderId: "9" })).rejects.toThrow(/risk denied/); // 2000 USD
    expect(client.modifyOrder).not.toHaveBeenCalled();
  });
  it("audit notional vs enforced notional (REPORT only)", async () => {
    const { b, auditFile } = bindings({ ETHUSDFUT: 0.01 });
    await b.trade.place(placeArgs);
    const lines = existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    const audited = lines.find((l) => l.action === "trade.place")?.notional;
    console.log(`[audit-notional] audit=${audited} enforced=${100 * 0.01 * 20}`);
  });
});

describe("config: contractValues validation", () => {
  const API_KEY = "SECRET-API-KEY-zz91";
  const base = { OPENALGO_URL: "http://localhost:5000/", OPENALGO_API_KEY: API_KEY, MCP_TOKEN: "SECRET-TOKEN-abcdefghijk" };
  const load = (json: string) => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), "cve-")), "risk.json");
    writeFileSync(p, json);
    return loadConfig({ ...base, RISK_CONFIG: p });
  };
  const fail = (json: string): ConfigError => {
    try {
      load(json);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return e as ConfigError;
    }
    throw new Error("expected ConfigError");
  };

  it("absent -> {}", () => {
    expect(load("{}").risk.contractValues).toEqual({});
  });
  it("valid values accepted; keys normalised trim+upper", () => {
    expect(load('{"contractValues":{"ethusdfut ":0.01,"BTCUSDFUT":1e-9,"X":1000000}}').risk.contractValues).toEqual({
      ETHUSDFUT: 0.01, BTCUSDFUT: 1e-9, X: 1e6,
    });
  });
  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["string number", '"0.01"'],
    ["Infinity (1e999)", "1e999"],
    ["null", "null"],
    ["bool", "true"],
    ["array", "[1]"],
  ])("value %s rejected", (_n, v) => {
    fail(`{"contractValues":{"ETHUSDFUT":${v}}}`);
  });
  it.each([
    ['{"ethusdfut":0.01,"ETHUSDFUT":1}'],
    ['{"ETHUSDFUT":0.01," ETHUSDFUT ":0.01}'],
  ])("duplicate case-insensitive/trimmed keys rejected: %s", (m) => {
    const e = fail(`{"contractValues":${m}}`);
    expect(e.message).not.toContain("ethusdfut");
  });
  it("NaN is not JSON -> ConfigError", () => {
    fail('{"contractValues":{"ETHUSDFUT":NaN}}');
  });
  it("contractValues not an object rejected", () => {
    fail('{"contractValues":[0.01]}');
    fail('{"contractValues":1}');
  });
  it("error does not echo key or value (secrets rule)", () => {
    const e = fail('{"contractValues":{"SECRETSYM-q7z":-123.456}}');
    for (const s of ["SECRETSYM-q7z", "-123.456", API_KEY]) {
      expect(e.message).not.toContain(s);
      expect(String(e.stack ?? "")).not.toContain(s);
    }
  });
});

describe("API docs", () => {
  it.each(["crypto", "delta", "CRYPTO", "Delta"])("searchApi(%s) returns crypto note with contractValues hint", (q) => {
    const s = searchApi(q);
    expect(s).toContain("Crypto (Delta via OpenAlgo)");
    expect(s).toContain("contractValues");
    expect(s).toContain("maxNotionalPerOrderUsd");
  });
});
