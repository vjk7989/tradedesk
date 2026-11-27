// TM2-23 edge tests (independent test writer): optional maxShortOptionQtyPerOrder cap
// on SELLs of NFO/BFO ...CE / ...PE symbols. Clock is always pinned via RiskEngine `now`.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RiskEngine, type RiskOrder } from "../src/risk/engine.js";
import { loadConfig, riskSchema, ConfigError, type Config, type RiskConfig } from "../src/config.js";
import { lintRisk, main as lintMain } from "../src/risk/lint.js";
import { createBindings } from "../src/sdk/bindings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const OPEN = new Date("2026-01-07T04:30:00Z"); // Wed 10:00 IST
const CLOSED = new Date("2026-01-07T12:00:00Z"); // Wed 17:30 IST
const SATURDAY = new Date("2026-01-10T04:30:00Z"); // Sat 10:00 IST

const CAP = 50;
const REASON = (q: number, n: number) => `short option qty ${q} exceeds maxShortOptionQtyPerOrder ${n}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tm2-23-edge-"));
});

function baseRisk(extra: Partial<RiskConfig> = {}): RiskConfig {
  return {
    allowedExchanges: ["NSE", "BSE", "NFO", "BFO", "MCX", "CRYPTO"],
    allowedProducts: ["CNC", "MIS", "NRML"],
    symbolAllow: [],
    symbolDeny: [],
    maxQtyPerOrder: 1000,
    maxNotionalPerOrder: 1_000_000,
    maxNotionalPerOrderUsd: 1_000_000,
    maxOrdersPerDay: 100,
    maxNotionalPerDay: 10_000_000,
    maxDailyLoss: 5000,
    maxOrdersPerRun: 50,
    ...extra,
  };
}

let seq = 0;
function engine(risk: RiskConfig, now: Date = OPEN, kill = false, Ctor: any = RiskEngine): RiskEngine {
  const k = path.join(dir, `KILL${seq}`);
  if (kill) writeFileSync(k, "");
  return new Ctor(risk, { mode: "paper", killSwitchFile: k, stateFile: path.join(dir, `st${seq++}.json`), now: () => now });
}

const opt = (o: Partial<RiskOrder> = {}): RiskOrder => ({
  symbol: "NIFTY26JAN24000CE",
  exchange: "NFO",
  product: "NRML",
  quantity: 10,
  price: 10,
  side: "SELL",
  ...o,
});

const check = (e: RiskEngine, o: RiskOrder) => e.checkOrder(o, { ordersThisRun: 0 });

describe("boundaries around the cap", () => {
  it.each([
    [CAP - 1, true],
    [CAP, true],
    [CAP + 1, false],
  ])("SELL NFO CE q=%i -> allow=%s", (q, allow) => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: CAP })), opt({ quantity: q }));
    expect(d.allow).toBe(allow);
    expect(d.reasons).toEqual(allow ? [] : [REASON(q, CAP)]);
  });

  it("cap of 1: q=1 allowed, q=2 refused", () => {
    const e = engine(baseRisk({ maxShortOptionQtyPerOrder: 1 }));
    expect(check(e, opt({ quantity: 1 }))).toEqual({ allow: true, reasons: [] });
    expect(check(e, opt({ quantity: 2 }))).toEqual({ allow: false, reasons: [REASON(2, 1)] });
  });

  it("cap absent: a huge short option SELL is not capped by this check", () => {
    const d = check(engine(baseRisk()), opt({ quantity: 999, price: 1 }));
    expect(d).toEqual({ allow: true, reasons: [] });
  });

  it("cap explicitly undefined behaves as absent", () => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: undefined })), opt({ quantity: 999, price: 1 }));
    expect(d).toEqual({ allow: true, reasons: [] });
  });
});

describe("NFO and BFO, CE and PE", () => {
  it.each([
    ["NFO", "NIFTY26JAN24000CE"],
    ["NFO", "BANKNIFTY26JAN52000PE"],
    ["BFO", "SENSEX26JAN80000CE"],
    ["BFO", "BANKEX26JAN60000PE"],
  ])("%s %s SELL over cap is refused, at cap allowed", (exchange, symbol) => {
    const e = engine(baseRisk({ maxShortOptionQtyPerOrder: CAP }));
    expect(check(e, opt({ exchange, symbol, quantity: CAP }))).toEqual({ allow: true, reasons: [] });
    expect(check(e, opt({ exchange, symbol, quantity: CAP + 1 }))).toEqual({ allow: false, reasons: [REASON(CAP + 1, CAP)] });
  });
});

describe("normalisation", () => {
  it.each([
    ["lowercase symbol", { symbol: "nifty26jan24000ce" }],
    ["mixed-case symbol", { symbol: "Nifty26Jan24000Pe" }],
    ["lowercase exchange", { exchange: "nfo" }],
    ["mixed-case exchange", { exchange: "bFo", symbol: "SENSEX26JAN80000CE" }],
    ["lowercase side", { side: "sell" as any }],
    ["mixed-case side", { side: "SeLl" as any }],
    ["whitespace symbol", { symbol: "  NIFTY26JAN24000CE\t" }],
    ["whitespace exchange", { exchange: " NFO \n" }],
    ["whitespace side", { side: " SELL " as any }],
    ["everything lowercase + whitespace", { symbol: " nifty26jan24000pe ", exchange: " bfo ", side: " sell " as any }],
  ])("%s is still capped", (_n, o) => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: CAP })), opt({ ...o, quantity: CAP + 1 }));
    expect(d.allow).toBe(false);
    expect(d.reasons).toEqual([REASON(CAP + 1, CAP)]);
  });

  it("lowercase buy over cap is not capped", () => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: CAP })), opt({ side: " buy " as any, quantity: CAP + 1 }));
    expect(d).toEqual({ allow: true, reasons: [] });
  });
});

describe("not capped", () => {
  const e = () => engine(baseRisk({ maxShortOptionQtyPerOrder: CAP }));
  it.each([
    ["NSE equity ending in PE", { exchange: "NSE", symbol: "ACMEPIPE", product: "CNC" }],
    ["NSE equity ending in CE", { exchange: "NSE", symbol: "FOOPLACE", product: "CNC" }],
    ["BSE equity ending in PE", { exchange: "BSE", symbol: "ACMEPIPE", product: "CNC" }],
    ["BSE equity ending in CE (lowercase)", { exchange: "bse", symbol: "fooplace", product: "CNC" }],
    ["NFO future", { exchange: "NFO", symbol: "NIFTY26JANFUT" }],
    ["BFO future", { exchange: "BFO", symbol: "SENSEX26JANFUT" }],
    ["MCX CE option", { exchange: "MCX", symbol: "CRUDEOIL26JAN6000CE" }],
    ["MCX PE option", { exchange: "MCX", symbol: "GOLD26JAN70000PE" }],
    ["CRYPTO option-shaped symbol", { exchange: "CRYPTO", symbol: "BTC28FEB2580000CE", product: "NRML" }],
    ["CRYPTO PE-shaped symbol", { exchange: "CRYPTO", symbol: "ETH28FEB253000PE", product: "NRML", price: 0.0001 }],
    ["BUY NFO CE over cap", { side: "BUY" as const }],
    ["BUY BFO PE over cap", { side: "BUY" as const, exchange: "BFO", symbol: "SENSEX26JAN80000PE" }],
    ["NFO symbol with CE in the middle (not suffix)", { symbol: "CESC26JANFUT" }],
  ])("%s", (_n, o) => {
    const d = check(e(), opt({ price: 0.01, ...o, quantity: CAP + 100 }));
    expect(d.reasons.filter((r) => r.startsWith("short option"))).toEqual([]);
    expect(d).toEqual({ allow: true, reasons: [] });
  });
});

describe("config: loadConfig / riskSchema / risk:lint", () => {
  const env = (risk: unknown) => {
    const f = path.join(dir, "risk.json");
    writeFileSync(f, typeof risk === "string" ? risk : JSON.stringify(risk));
    return {
      OPENALGO_URL: "http://127.0.0.1:5000",
      OPENALGO_API_KEY: "k",
      MCP_TOKEN: "x".repeat(32),
      RISK_CONFIG: f,
    };
  };

  it("accepts a positive integer, including 1", () => {
    expect(loadConfig(env({ maxShortOptionQtyPerOrder: 75 })).risk.maxShortOptionQtyPerOrder).toBe(75);
    expect(loadConfig(env({ maxShortOptionQtyPerOrder: 1 })).risk.maxShortOptionQtyPerOrder).toBe(1);
  });

  it("absent key stays undefined (off by default, no default injected)", () => {
    expect(loadConfig(env({})).risk.maxShortOptionQtyPerOrder).toBeUndefined();
    expect(riskSchema.parse({}).maxShortOptionQtyPerOrder).toBeUndefined();
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["non-integer", 1.5],
    ["string", "50"],
    ["null", null],
    ["boolean", true],
    ["Infinity-ish huge float", 1e400 as any],
  ])("rejects %s", (_n, v) => {
    const raw = v === (1e400 as any) ? `{"maxShortOptionQtyPerOrder": 1e400}` : { maxShortOptionQtyPerOrder: v };
    expect(() => loadConfig(env(raw))).toThrow(ConfigError);
    expect(() => loadConfig(env(raw))).toThrow(/maxShortOptionQtyPerOrder/);
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(riskSchema.safeParse(parsed).success).toBe(false);
    expect(lintRisk(typeof raw === "string" ? raw : JSON.stringify(raw), { today: "2026-06-15" }).code).toBe(1);
  });

  it("misspelt key is still rejected by the strict schema", () => {
    expect(() => loadConfig(env({ maxShortOptionQtyPerorder: 5 }))).toThrow(/unknown key/);
  });

  it("risk:lint main() on a real JSON file with the key exits 0", () => {
    const f = path.join(dir, "risk-lint.json");
    writeFileSync(f, JSON.stringify({ maxShortOptionQtyPerOrder: 50, marketHolidays: { NSE: ["2026-01-26"], MCX: ["2026-01-26"] } }));
    const out: string[] = [];
    const err: string[] = [];
    const code = lintMain([f, "--today", "2026-06-15"], { out: (s) => out.push(s), err: (s) => err.push(s) });
    expect(code).toBe(0);
    expect(out[0]).toBe("risk config OK");
    expect(err).toEqual([]);
    // also under --strict with a config that triggers no warnings
    expect(lintMain([f, "--today", "2026-06-15", "--strict"], { out: () => {}, err: () => {} })).toBe(0);
  });

  it("risk:lint main() rejects the key set to 0", () => {
    const f = path.join(dir, "risk-lint0.json");
    writeFileSync(f, JSON.stringify({ maxShortOptionQtyPerOrder: 0 }));
    const err: string[] = [];
    expect(lintMain([f, "--today", "2026-06-15"], { out: () => {}, err: (s) => err.push(s) })).toBe(1);
    expect(err.join("\n")).toMatch(/maxShortOptionQtyPerOrder/);
  });

  it("risk:lint built CLI (dist) exits 0 on a file with the key, when dist is built", () => {
    const cli = path.join(ROOT, "dist/src/risk/lint.js");
    if (!existsSync(cli)) return; // dist not built in this checkout; main() test above covers the logic
    const f = path.join(dir, "risk-cli.json");
    writeFileSync(f, JSON.stringify({ maxShortOptionQtyPerOrder: 50 }));
    // throws on non-zero exit
    const out = execSync(`node ${JSON.stringify(cli)} ${JSON.stringify(f)} --today 2026-06-15`, { encoding: "utf8" });
    expect(out).toMatch(/risk config OK/);
  });
});

describe("interaction with other checks", () => {
  it("kill switch still denies first", () => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: CAP }), OPEN, true), opt({ quantity: CAP + 1 }));
    expect(d.allow).toBe(false);
    expect(d.reasons[0]).toBe("kill switch active");
    expect(d.reasons).toEqual(["kill switch active", REASON(CAP + 1, CAP)]);
  });

  it("kill switch denies a capped-OK short option too", () => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: CAP }), OPEN, true), opt({ quantity: CAP }));
    expect(d).toEqual({ allow: false, reasons: ["kill switch active"] });
  });

  it("market closed is still reported (last) and still denies at the cap", () => {
    const e = engine(baseRisk({ maxShortOptionQtyPerOrder: CAP }), CLOSED);
    expect(check(e, opt({ quantity: CAP }))).toEqual({ allow: false, reasons: ["market closed for NFO"] });
    const d = check(e, opt({ quantity: CAP + 1 }));
    expect(d.reasons).toEqual([REASON(CAP + 1, CAP), "market closed for NFO"]);
  });

  it("weekend: BFO closed reason preserved", () => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: CAP }), SATURDAY), opt({ exchange: "BFO", symbol: "SENSEX26JAN80000PE", quantity: CAP + 1 }));
    expect(d.reasons.at(-1)).toBe("market closed for BFO");
  });

  it("maxQtyPerOrder and notional reasons keep their relative order; new reason sits between qty and notional", () => {
    const r = baseRisk({ maxShortOptionQtyPerOrder: CAP, maxQtyPerOrder: 100, maxNotionalPerOrder: 1000, maxNotionalPerDay: 1500 });
    const d = check(engine(r), opt({ quantity: 200, price: 10 }));
    expect(d.reasons).toEqual([
      "quantity 200 exceeds maxQtyPerOrder 100",
      REASON(200, CAP),
      "notional 2000 exceeds per-order limit 1000",
      "day notional 2000 exceeds maxNotionalPerDay 1500",
    ]);
  });

  it("missing price still reported alongside the cap", () => {
    const d = check(engine(baseRisk({ maxShortOptionQtyPerOrder: CAP })), opt({ quantity: CAP + 1, price: undefined }));
    expect(d.reasons).toEqual([REASON(CAP + 1, CAP), "price required for notional check"]);
  });

  it("reserve() refuses without reserving counters", () => {
    const e = engine(baseRisk({ maxShortOptionQtyPerOrder: CAP }));
    const d = e.reserve(opt({ quantity: CAP + 1 }), { ordersThisRun: 0 });
    expect(d.allow).toBe(false);
    expect(d.token).toBeUndefined();
    expect(e.status().today).toMatchObject({ orders: 0, notional: 0 });
    expect(e.status().limits.maxShortOptionQtyPerOrder).toBe(CAP);
  });
});

// --- Key absent vs key set: git-free oracle on the same engine ---------------
function matrix(): RiskOrder[] {
  const out: RiskOrder[] = [];
  const syms: [string, string][] = [
    ["NFO", "NIFTY26JAN24000CE"], ["NFO", "nifty26jan24000pe"], ["NFO", "NIFTY26JANFUT"],
    ["BFO", "SENSEX26JAN80000CE"], [" bfo ", "sensex26jan80000pe "], ["NSE", "ACMEPIPE"], ["BSE", "FOOPLACE"],
    ["MCX", "CRUDEOIL26JAN6000CE"], ["CRYPTO", "BTC28FEB2580000CE"], ["CDS", "USDINR26JAN83CE"],
  ];
  for (const [exchange, symbol] of syms)
    for (const side of ["BUY", "SELL", "sell"] as const)
      for (const quantity of [1, CAP, CAP + 1, 200, 2.5, 0, -1, Number.NaN])
        for (const price of [undefined, 10, 5000])
          for (const product of ["NRML", "BAD"]) out.push({ symbol, exchange, product, quantity, price, side: side as any });
  return out;
}

// Independent statement of the rule from the brief.
function capApplies(o: RiskOrder, cap: number): boolean {
  const ex = o.exchange.trim().toUpperCase();
  const sym = o.symbol.trim().toUpperCase();
  const isShortOpt = String(o.side).trim().toUpperCase() === "SELL" && (ex === "NFO" || ex === "BFO") && (sym.endsWith("CE") || sym.endsWith("PE"));
  return isShortOpt && o.quantity > cap;
}

describe("key set vs key absent (same engine)", () => {
  const r = baseRisk({ maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerDay: 200000 });

  it("matrix is the expected size", () => {
    expect(matrix().length).toBe(1440);
  });

  it.each([
    ["open", OPEN, false],
    ["closed", CLOSED, false],
    ["kill switch", OPEN, true],
    ["weekend + kill switch", SATURDAY, true],
  ])("key set = key absent plus exactly the new reason after the maxQtyPerOrder reason, %s", (_n, now, kill) => {
    const absent = engine(r, now as Date, kill as boolean);
    const set = engine({ ...r, maxShortOptionQtyPerOrder: CAP }, now as Date, kill as boolean);
    let capped = 0;
    for (const o of matrix()) {
      const a = check(absent, o);
      const s = check(set, o);
      const msg = JSON.stringify(o);
      const applies = capApplies(o, CAP);
      expect(a.reasons.some((x) => x.startsWith("short option qty")), msg).toBe(false);
      if (applies) {
        capped++;
        // insertion point: right after the quantity reasons (positive-integer / maxQtyPerOrder),
        // which come after kill switch / exchange / product / symbol reasons.
        let at = 0;
        for (let i = 0; i < a.reasons.length; i++) {
          const x = a.reasons[i];
          if (x === "kill switch active" || /^exchange .* not allowed$/.test(x) || /^product .* not allowed$/.test(x) ||
              /^symbol .* (is denied|not in allow list)$/.test(x) || x === "quantity must be a positive integer" ||
              /^quantity .* exceeds maxQtyPerOrder /.test(x)) at = i + 1;
        }
        const expected = [...a.reasons.slice(0, at), REASON(o.quantity, CAP), ...a.reasons.slice(at)];
        expect(s.reasons, msg).toEqual(expected);
      } else {
        expect(s.reasons, msg).toEqual(a.reasons);
      }
      expect(s.allow, msg).toBe(a.allow && !applies);
    }
    expect(capped).toBeGreaterThan(0);
  });

  it("a huge cap never changes any result", () => {
    const absent = engine(r);
    const set = engine({ ...r, maxShortOptionQtyPerOrder: Number.MAX_SAFE_INTEGER });
    for (const o of matrix()) expect(check(set, o), JSON.stringify(o)).toEqual(check(absent, o));
  });

  // Pinned baseline of reason ordering with the key absent (and the same orders with it set).
  const R = baseRisk({ maxQtyPerOrder: 100, maxNotionalPerOrder: 1000, maxNotionalPerDay: 1500, allowedExchanges: ["NSE", "NFO"] });
  it.each([
    ["clean short CE", OPEN, false, opt({ quantity: 60 }), [], [REASON(60, CAP)]],
    ["kill + qty + notional", OPEN, true, opt({ quantity: 200, price: 10 }),
      ["kill switch active", "quantity 200 exceeds maxQtyPerOrder 100", "notional 2000 exceeds per-order limit 1000", "day notional 2000 exceeds maxNotionalPerDay 1500"],
      ["kill switch active", "quantity 200 exceeds maxQtyPerOrder 100", REASON(200, CAP), "notional 2000 exceeds per-order limit 1000", "day notional 2000 exceeds maxNotionalPerDay 1500"]],
    ["BFO not allowed + closed", CLOSED, false, opt({ exchange: "BFO", symbol: "SENSEX26JAN80000PE", quantity: 60 }),
      ["exchange BFO not allowed", "market closed for BFO"],
      ["exchange BFO not allowed", REASON(60, CAP), "market closed for BFO"]],
    ["no price, closed", CLOSED, false, opt({ quantity: 60, price: undefined }),
      ["price required for notional check", "market closed for NFO"],
      [REASON(60, CAP), "price required for notional check", "market closed for NFO"]],
    ["BUY over everything", OPEN, true, opt({ side: "BUY", quantity: 200, price: 10 }),
      ["kill switch active", "quantity 200 exceeds maxQtyPerOrder 100", "notional 2000 exceeds per-order limit 1000", "day notional 2000 exceeds maxNotionalPerDay 1500"],
      ["kill switch active", "quantity 200 exceeds maxQtyPerOrder 100", "notional 2000 exceeds per-order limit 1000", "day notional 2000 exceeds maxNotionalPerDay 1500"]],
  ] as const)("pinned ordering: %s", (_n, now, kill, o, absentReasons, setReasons) => {
    expect(check(engine(R, now, kill), o).reasons).toEqual(absentReasons);
    expect(check(engine({ ...R, maxShortOptionQtyPerOrder: CAP }, now, kill), o).reasons).toEqual(setReasons);
  });
});

// --- Caller-visible path: bindings + audit ---------------------------------
describe("caller-visible denial and audit", () => {
  let client: any;
  beforeEach(() => {
    client = {
      quotes: vi.fn(async () => ({ status: "success", data: { ltp: 10 } })),
      analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
      pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
      placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
      modifyOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    };
  });
  const setup = (cap?: number) => {
    const risk = baseRisk(cap === undefined ? {} : { maxShortOptionQtyPerOrder: cap });
    const e = engine(risk);
    const auditFile = path.join(dir, "audit.log");
    const cfg = { mode: "paper", risk, killSwitchFile: path.join(dir, "nokill") } as unknown as Config;
    return { b: createBindings({ client, risk: e, cfg, auditFile }, { id: "r1" }) as any, e, auditFile };
  };
  const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const order = { symbol: "NIFTY26JAN24000PE", exchange: "NFO", side: "SELL", quantity: 51, product: "NRML", priceType: "LIMIT", price: 10 };

  it("trade.place: exact error text, nothing placed, audit records denied with reason", async () => {
    const { b, e, auditFile } = setup(50);
    await expect(b.trade.place(order)).rejects.toThrow(new Error("risk denied: short option qty 51 exceeds maxShortOptionQtyPerOrder 50"));
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(e.status().today.orders).toBe(0);
    const [l] = lines(auditFile);
    expect(l).toMatchObject({
      run: "r1",
      action: "trade.place",
      decision: "denied",
      riskReasons: ["short option qty 51 exceeds maxShortOptionQtyPerOrder 50"],
      error: "risk denied: short option qty 51 exceeds maxShortOptionQtyPerOrder 50",
    });
  });

  it("trade.place MARKET order (price from LTP) is also denied", async () => {
    const { b } = setup(50);
    const { price: _p, ...mkt } = order;
    await expect(b.trade.place({ ...mkt, priceType: "MARKET" })).rejects.toThrow(/^risk denied: short option qty 51 exceeds maxShortOptionQtyPerOrder 50$/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it("trade.modify: denied the same way and audited", async () => {
    const { b, auditFile } = setup(50);
    await expect(b.trade.modify({ ...order, orderId: "9" })).rejects.toThrow(/^risk denied: short option qty 51 exceeds maxShortOptionQtyPerOrder 50$/);
    expect(client.modifyOrder).not.toHaveBeenCalled();
    expect(lines(auditFile)[0]).toMatchObject({ action: "trade.modify", decision: "denied" });
  });

  it("at the cap the order is placed and audited allowed", async () => {
    const { b, auditFile } = setup(50);
    await b.trade.place({ ...order, quantity: 50 });
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(lines(auditFile)[0]).toMatchObject({ decision: "allowed" });
  });

  it("key absent: same order is placed", async () => {
    const { b } = setup(undefined);
    await b.trade.place(order);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
  });
});
