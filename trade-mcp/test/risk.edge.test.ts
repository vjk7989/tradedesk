import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/risk/engine.js";
import { isMarketOpen, istParts } from "../src/risk/hours.js";
import { appendAudit } from "../src/risk/audit.js";
import type { RiskConfig } from "../src/config.js";

const cfg: RiskConfig = {
  allowedExchanges: ["NSE", "MCX", "CRYPTO"],
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
const statePath = () => path.join(dir, "s", "state.json");
const mk = (c: Partial<RiskConfig> = {}, stateFile = statePath()) =>
  new RiskEngine({ ...cfg, ...c }, {
    mode: "paper",
    killSwitchFile: path.join(dir, "KILL"),
    stateFile,
    now: () => t,
  });
const ord = (o: object = {}) => ({ symbol: "SBIN", exchange: "NSE", product: "MIS", quantity: 10, price: 100, side: "BUY" as const, ...o });
const run = { ordersThisRun: 0 };
const check = (o: object, c: Partial<RiskConfig> = {}, pnl?: number) => mk(c).checkOrder(ord(o) as any, run, pnl);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "risk-edge-"));
  t = OPEN;
});

describe("hours boundaries (IST from UTC)", () => {
  it("equity open boundary 09:14:59.999 vs 09:15:00", () => {
    for (const ex of ["NSE", "BSE", "NFO", "BFO", "CDS"]) {
      expect(isMarketOpen(ex, new Date("2026-01-07T03:44:59.999Z"))).toBe(false);
      expect(isMarketOpen(ex, new Date("2026-01-07T03:45:00.000Z"))).toBe(true);
    }
  });
  it("equity close boundary 15:29:59.999 vs 15:30:00", () => {
    expect(isMarketOpen("NSE", new Date("2026-01-07T09:59:59.999Z"))).toBe(true);
    expect(isMarketOpen("NSE", new Date("2026-01-07T10:00:00.000Z"))).toBe(false);
  });
  it("MCX 08:59:59 vs 09:00, 23:29:59 vs 23:30", () => {
    expect(isMarketOpen("MCX", new Date("2026-01-07T03:29:59Z"))).toBe(false);
    expect(isMarketOpen("MCX", new Date("2026-01-07T03:30:00Z"))).toBe(true);
    expect(isMarketOpen("MCX", new Date("2026-01-07T17:59:59.999Z"))).toBe(true);
    expect(isMarketOpen("MCX", new Date("2026-01-07T18:00:00Z"))).toBe(false);
  });
  it("Fri->Sat across UTC midnight; Sun->Mon", () => {
    expect(isMarketOpen("MCX", new Date("2026-01-09T17:59:00Z"))).toBe(true); // Fri 23:29 IST
    expect(isMarketOpen("MCX", new Date("2026-01-09T19:00:00Z"))).toBe(false); // Sat 00:30 IST
    expect(istParts(new Date("2026-01-09T19:00:00Z")).day).toBe(6);
    expect(isMarketOpen("NSE", new Date("2026-01-11T22:00:00Z"))).toBe(false); // Mon 03:30 IST
    expect(isMarketOpen("NSE", new Date("2026-01-12T03:45:00Z"))).toBe(true);
    expect(isMarketOpen("NSE", new Date("2026-01-11T05:00:00Z"))).toBe(false); // Sunday
  });
  it("CRYPTO always; unknown/empty false; exchange case-insensitive", () => {
    expect(isMarketOpen("CRYPTO", new Date("2026-01-10T18:30:00Z"))).toBe(true);
    expect(isMarketOpen("crypto", new Date("2026-01-10T18:30:00Z"))).toBe(true);
    expect(isMarketOpen("nse", OPEN)).toBe(true);
    expect(isMarketOpen("", OPEN)).toBe(false);
    expect(isMarketOpen("NYSE", OPEN)).toBe(false);
  });
  it("is host-TZ independent", () => {
    const old = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(isMarketOpen("NSE", new Date("2026-01-07T03:45:00Z"))).toBe(true);
        expect(isMarketOpen("NSE", new Date("2026-01-07T03:44:59Z"))).toBe(false);
        expect(istParts(new Date("2026-01-07T18:30:00Z")).date).toBe("2026-01-08");
      }
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  });
  it("IST date rolls at UTC 18:30", () => {
    expect(istParts(new Date("2026-01-07T18:29:59.999Z")).date).toBe("2026-01-07");
    expect(istParts(new Date("2026-01-07T18:30:00Z")).date).toBe("2026-01-08");
  });
});

describe("quantity edges", () => {
  const bad = "quantity must be a positive integer";
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])("rejects %s", (q) => {
    const r = check({ quantity: q });
    expect(r.allow).toBe(false);
    expect(r.reasons).toContain(bad);
  });
  it("rejects string '10' (no coercion)", () => {
    const r = check({ quantity: "10" });
    expect(r.allow).toBe(false);
    expect(r.reasons).toContain(bad);
  });
  it("1 ok; max ok; max+1 rejected", () => {
    expect(check({ quantity: 1 }).allow).toBe(true);
    expect(check({ quantity: 100, price: 1 }).allow).toBe(true);
    const r = check({ quantity: 101, price: 1 });
    expect(r.allow).toBe(false);
    expect(r.reasons.some((x) => x.includes("maxQtyPerOrder"))).toBe(true);
  });
});

describe("price / notional edges", () => {
  it.each([0, -5, NaN, Infinity, undefined])("rejects price %s", (p) => {
    const r = check({ price: p });
    expect(r.allow).toBe(false);
    expect(r.reasons).toContain("price required for notional check");
  });
  it("notional exactly at cap allowed, cap+0.01 rejected", () => {
    expect(check({ quantity: 1, price: 50000 }, { maxNotionalPerDay: 1e9 }).allow).toBe(true);
    const r = check({ quantity: 1, price: 50000.01 }, { maxNotionalPerDay: 1e9 });
    expect(r.allow).toBe(false);
    expect(r.reasons.some((x) => x.includes("per-order limit"))).toBe(true);
  });
  it("float precision: qty 3 * price 0.1 at cap 0.3 should be allowed", () => {
    // 3*0.1 === 0.30000000000000004 in IEEE754; a sane engine should not reject this.
    expect(check({ quantity: 3, price: 0.1 }, { maxNotionalPerOrder: 0.3 }).allow).toBe(true);
  });
  it("CRYPTO uses USD cap and is excluded from INR day total", () => {
    expect(check({ exchange: "CRYPTO", symbol: "BTC", quantity: 1, price: 500 }).allow).toBe(true);
    expect(check({ exchange: "CRYPTO", symbol: "BTC", quantity: 1, price: 501 }).allow).toBe(false);
    const e = mk();
    e.recordOrder(ord({ exchange: "CRYPTO" }) as any, 1e9);
    expect(e.status().today.notional).toBe(0);
  });
  it("day notional exactly at cap allowed, over rejected", () => {
    const e = mk();
    e.recordOrder(ord() as any, 40000);
    expect(e.checkOrder(ord({ quantity: 1, price: 20000 }) as any, run).allow).toBe(true);
    const r = e.checkOrder(ord({ quantity: 1, price: 20000.01 }) as any, run);
    expect(r.reasons.some((x) => x.includes("maxNotionalPerDay"))).toBe(true);
  });
});

describe("symbol / exchange matching", () => {
  it("deny list is case-insensitive", () => {
    expect(check({ symbol: "badco" }).allow).toBe(false);
  });
  it("whitespace must not bypass deny list", () => {
    const r = check({ symbol: " badco " });
    expect(r.allow).toBe(false);
    expect(r.reasons.some((x) => x.includes("denied"))).toBe(true);
  });
  it("allow list: case-insensitive, missing rejected, whitespace normalised", () => {
    expect(check({ symbol: "reliance" }, { symbolAllow: ["RELIANCE"] }).allow).toBe(true);
    expect(check({ symbol: "TCS" }, { symbolAllow: ["RELIANCE"] }).allow).toBe(false);
    expect(check({ symbol: " reliance " }, { symbolAllow: ["RELIANCE"] }).allow).toBe(true);
  });
  it("deny wins over allow", () => {
    const r = check({ symbol: "BADCO" }, { symbolAllow: ["BADCO"] });
    expect(r.allow).toBe(false);
    expect(r.reasons.some((x) => x.includes("denied"))).toBe(true);
  });
  it("exchange case-insensitive; not-allowed rejected; product not allowed", () => {
    expect(check({ exchange: "nse" }).allow).toBe(true);
    expect(check({ exchange: "BSE" }).reasons).toContain("exchange BSE not allowed");
    expect(check({ product: "NRML" }).reasons).toContain("product NRML not allowed");
  });
});

describe("loss / run / day counters", () => {
  it("dayPnl exactly -maxDailyLoss rejects; just above allows", () => {
    expect(check({}, {}, -1000).allow).toBe(false);
    expect(check({}, {}, -999.99).allow).toBe(true);
  });
  it("NaN dayPnl must not silently allow (fail closed)", () => {
    expect(check({}, {}, NaN).allow).toBe(false);
  });
  it("ordersThisRun boundary", () => {
    const e = mk();
    expect(e.checkOrder(ord() as any, { ordersThisRun: 1 }).allow).toBe(true);
    expect(e.checkOrder(ord() as any, { ordersThisRun: 2 }).allow).toBe(false);
  });
  it("maxOrdersPerDay boundary and IST rollover at UTC 18:30", () => {
    t = new Date("2026-01-07T09:00:00Z");
    const e = mk({ maxNotionalPerDay: 1e9 });
    for (let i = 0; i < 2; i++) e.recordOrder(ord() as any, 1);
    expect(e.checkOrder(ord() as any, run).allow).toBe(true);
    e.recordOrder(ord() as any, 1);
    expect(e.checkOrder(ord() as any, run).reasons).toContain("maxOrdersPerDay 3 reached");
    t = new Date("2026-01-07T18:29:59Z");
    expect(e.status().today.orders).toBe(3);
    t = new Date("2026-01-07T18:30:00Z");
    expect(e.status().today).toEqual({ date: "2026-01-08", orders: 0, notional: 0 });
  });
});

describe("kill switch", () => {
  it("created mid-session honoured on next call; removal re-enables", () => {
    const e = mk();
    expect(e.checkOrder(ord() as any, run).allow).toBe(true);
    writeFileSync(path.join(dir, "KILL"), "");
    expect(e.checkOrder(ord() as any, run).reasons).toContain("kill switch active");
    rmSync(path.join(dir, "KILL"));
    expect(e.checkOrder(ord() as any, run).allow).toBe(true);
  });
  it("kill switch as a directory still blocks", () => {
    mkdirSync(path.join(dir, "KILL"));
    expect(check({}).reasons).toContain("kill switch active");
  });
});

describe("state persistence", () => {
  const seed = (content: string) => {
    mkdirSync(path.dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), content);
  };
  it.each([
    ["corrupt JSON", "{not json"],
    ["wrong shape", JSON.stringify({ date: "2026-01-07", orders: "5", notional: null })],
    ["array", "[]"],
    ["null", "null"],
    ["previous day", JSON.stringify({ date: "2026-01-06", orders: 99, notional: 1e9 })],
    ["future day", JSON.stringify({ date: "2026-01-08", orders: 99, notional: 1e9 })],
  ])("%s -> zero counters", (_n, content) => {
    seed(content);
    expect(mk().status().today).toEqual({ date: "2026-01-07", orders: 0, notional: 0 });
  });
  it("valid same-day state is loaded", () => {
    seed(JSON.stringify({ date: "2026-01-07", orders: 3, notional: 10 }));
    expect(mk().checkOrder(ord() as any, run).reasons).toContain("maxOrdersPerDay 3 reached");
  });
  it("state in non-existent nested dir is created; no tmp left; reloads", () => {
    const sf = path.join(dir, "a", "b", "c", "state.json");
    mk({}, sf).recordOrder(ord() as any, 1000);
    expect(JSON.parse(readFileSync(sf, "utf8"))).toEqual({ date: "2026-01-07", orders: 1, notional: 1000 });
    expect(existsSync(`${sf}.${process.pid}.tmp`)).toBe(false);
    expect(mk({}, sf).status().today.orders).toBe(1);
  });
  it("concurrent recordOrder calls all counted", async () => {
    const e = mk();
    await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => e.recordOrder(ord() as any, 1))));
    expect(e.status().today.orders).toBe(20);
    expect(JSON.parse(readFileSync(statePath(), "utf8")).orders).toBe(20);
  });
});

describe("multiple violations", () => {
  it("reports all reasons at once", () => {
    writeFileSync(path.join(dir, "KILL"), "");
    t = new Date("2026-01-10T05:00:00Z"); // Saturday
    const e = mk({ symbolAllow: ["SBIN"] });
    const r = e.checkOrder({ symbol: "BADCO", exchange: "BSE", product: "NRML", quantity: 0, side: "BUY" }, { ordersThisRun: 2 }, -5000);
    expect(r.allow).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining([
      "kill switch active",
      "exchange BSE not allowed",
      "product NRML not allowed",
      "symbol BADCO is denied",
      "symbol BADCO not in allow list",
      "quantity must be a positive integer",
      "price required for notional check",
      "maxOrdersPerRun 2 reached",
      "daily loss limit 1000 hit",
      "market closed for BSE",
    ]));
    expect(r.reasons.length).toBe(10);
  });
});

describe("audit redaction", () => {
  const read = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  it("redacts nested arrays/objects and case variants, no mutation, creates dirs", () => {
    const f = path.join(dir, "x", "y", "audit.jsonl");
    const entry = {
      APIKEY: "sa", apiKey: "sb", Authorization: "sc", TOKEN: "sd", api_key: "se",
      nested: { deep: [{ token: "sf", ok: 1 }, { inner: { authorization: "sg" } }] },
      list: [[{ apikey: "sh" }]],
    };
    const copy = structuredClone(entry);
    appendAudit(f, entry);
    expect(entry).toEqual(copy);
    const [l] = read(f);
    expect(Number.isNaN(Date.parse(l.ts))).toBe(false);
    const s = JSON.stringify(l);
    for (const secret of ["sa", "sb", "sc", "sd", "se", "sf", "sg", "sh"]) expect(s).not.toContain(`"${secret}"`);
    expect(l.nested.deep[0].ok).toBe(1);
  });
  it("appends one line per call", () => {
    const f = path.join(dir, "audit.jsonl");
    appendAudit(f, { a: 1 });
    appendAudit(f, { a: 2 });
    expect(read(f).map((x) => x.a)).toEqual([1, 2]);
  });
  it("entry cannot spoof ts", () => {
    const f = path.join(dir, "audit.jsonl");
    appendAudit(f, { ts: "fake" });
    expect(read(f)[0].ts).not.toBe("fake");
  });
  it("header-style secret keys (x-api-key, access_token) are redacted", () => {
    const f = path.join(dir, "audit.jsonl");
    appendAudit(f, { headers: { "x-api-key": "s1", access_token: "s2" } });
    const s = readFileSync(f, "utf8");
    expect(s).not.toContain("s1");
    expect(s).not.toContain("s2");
  });
});
