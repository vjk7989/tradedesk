import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMarketOpen, istParts } from "../src/risk/hours.js";
import { RiskEngine, type RiskOrder } from "../src/risk/engine.js";
import { loadConfig, ConfigError, type Config, type RiskConfig } from "../src/config.js";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import { API_DOCS, API_HEADER } from "../src/sdk/api-docs.js";

// 2026-01-26 is a Monday (Republic Day). 10:00 IST = 04:30Z.
const MON_26_10 = new Date("2026-01-26T04:30:00Z");
const TUE_27_10 = new Date("2026-01-27T04:30:00Z");
const NSE_26 = { NSE: ["2026-01-26"] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tm3x-"));
});

function loadRaw(json: string) {
  const f = path.join(dir, "risk.json");
  writeFileSync(f, json);
  return loadConfig({ OPENALGO_URL: "http://x", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(24), RISK_CONFIG: f });
}
const load = (risk: unknown) => loadRaw(JSON.stringify(risk));
function errOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected throw");
}

const baseRisk = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  allowedExchanges: ["NSE", "NFO", "BSE", "BFO", "CDS", "MCX", "CRYPTO"],
  allowedProducts: ["CNC", "MIS", "NRML"],
  symbolAllow: [],
  symbolDeny: [],
  maxQtyPerOrder: 100,
  maxNotionalPerOrder: 50000,
  maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 20,
  maxNotionalPerDay: 200000,
  maxDailyLoss: 5000,
  maxOrdersPerRun: 50,
  ...over,
});
const mkEngine = (risk: RiskConfig, now: Date) =>
  new RiskEngine(risk, { mode: "paper", killSwitchFile: path.join(dir, "KILL"), stateFile: path.join(dir, "s.json"), now: () => now });
const ord = (exchange: string, over: Partial<RiskOrder> = {}): RiskOrder => ({
  symbol: "INFY", exchange, product: "MIS", quantity: 1, price: 100, side: "BUY", ...over,
});

describe("IST date boundary (ms precision)", () => {
  it("18:29:59.999Z is still the 25th, 18:30:00.000Z is the 26th", () => {
    expect(istParts(new Date("2026-01-25T18:29:59.999Z")).date).toBe("2026-01-25");
    expect(istParts(new Date("2026-01-25T18:30:00.000Z")).date).toBe("2026-01-26");
  });
  it("year boundary: 2025-12-31T18:30Z is 2026-01-01 IST", () => {
    expect(istParts(new Date("2025-12-31T18:29:59.999Z")).date).toBe("2025-12-31");
    expect(istParts(new Date("2025-12-31T18:30:00.000Z")).date).toBe("2026-01-01");
  });
  it("MCX evening session: last minute of a non-holiday day stays open when only the next day is listed", () => {
    // Fri 2026-01-23 23:29:59 IST = 17:59:59Z
    expect(isMarketOpen("MCX", new Date("2026-01-23T17:59:59.999Z"), { MCX: ["2026-01-24"] })).toBe(true);
    expect(isMarketOpen("MCX", new Date("2026-01-23T17:59:59.999Z"), { MCX: ["2026-01-23"] })).toBe(false);
  });
  it("IST 00:00-05:29 has a different UTC date: the IST date is what counts", () => {
    // Mon 2026-01-26 05:00 IST = 2026-01-25T23:30Z
    expect(istParts(new Date("2026-01-25T23:30:00Z")).date).toBe("2026-01-26");
    // Mon 26th 09:00 IST (03:30Z): listing the 25th (Sunday) does not block MCX, listing the 26th does
    expect(isMarketOpen("MCX", new Date("2026-01-26T03:30:00Z"), { MCX: ["2026-01-25"] })).toBe(true);
  });
});

describe("holiday on Friday + weekend", () => {
  // Fri 2026-01-30 listed
  const H = { NSE: ["2026-01-30"] };
  it("Fri blocked, Sat/Sun closed as before, Mon open", () => {
    expect(isMarketOpen("NSE", new Date("2026-01-29T04:30:00Z"), H)).toBe(true); // Thu
    expect(isMarketOpen("NSE", new Date("2026-01-30T04:30:00Z"), H)).toBe(false); // Fri holiday
    expect(isMarketOpen("NSE", new Date("2026-01-31T04:30:00Z"), H)).toBe(false); // Sat
    expect(isMarketOpen("NSE", new Date("2026-02-01T04:30:00Z"), H)).toBe(false); // Sun
    expect(isMarketOpen("NSE", new Date("2026-02-02T04:30:00Z"), H)).toBe(true); // Mon
  });
  it("listing a weekend date changes nothing on weekdays", () => {
    const W = { NSE: ["2026-01-31", "2026-02-01"] };
    expect(isMarketOpen("NSE", new Date("2026-01-30T04:30:00Z"), W)).toBe(true);
    expect(isMarketOpen("NSE", new Date("2026-02-02T04:30:00Z"), W)).toBe(true);
    expect(isMarketOpen("NSE", new Date("2026-01-31T04:30:00Z"), W)).toBe(false);
  });
});

describe("exchange groups", () => {
  it.each(["NSE", "NFO", "CDS", "BSE", "BFO"])("%s blocked by NSE group, open the next day", (ex) => {
    expect(isMarketOpen(ex, MON_26_10, NSE_26)).toBe(false);
    expect(isMarketOpen(ex, TUE_27_10, NSE_26)).toBe(true);
  });
  it.each(["nse", "nfo", "cds", "bse", "bfo", "Nse", "mcx"])("lowercase/mixed exchange %s still mapped", (ex) => {
    const h = { NSE: ["2026-01-26"], MCX: ["2026-01-26"] };
    expect(isMarketOpen(ex, MON_26_10, h)).toBe(false);
    expect(isMarketOpen(ex, MON_26_10, {})).toBe(true);
  });
  it("MCX is separate: NSE list does not block MCX, MCX list does not block NSE group", () => {
    expect(isMarketOpen("MCX", MON_26_10, NSE_26)).toBe(true);
    for (const ex of ["NSE", "NFO", "CDS", "BSE", "BFO"]) expect(isMarketOpen(ex, MON_26_10, { MCX: ["2026-01-26"] })).toBe(true);
  });
  it("engine: lowercase/space-padded exchange on a holiday is denied with the original exchange text", () => {
    const e = mkEngine(baseRisk({ marketHolidays: NSE_26 }), MON_26_10);
    const r = e.checkOrder(ord(" nfo "), { ordersThisRun: 0 });
    expect(r.allow).toBe(false);
    expect(r.reasons).toContain("market closed for  nfo ");
  });
  it("unknown exchange stays closed regardless of holidays", () => {
    expect(isMarketOpen("XYZ", MON_26_10, {})).toBe(false);
    expect(isMarketOpen("", MON_26_10, {})).toBe(false);
  });
});

describe("CRYPTO never blocked", () => {
  it("CRYPTO open on listed NSE/MCX dates, weekends and night", () => {
    const h = { NSE: ["2026-01-26"], MCX: ["2026-01-26"] };
    expect(isMarketOpen("CRYPTO", MON_26_10, h)).toBe(true);
    expect(isMarketOpen("crypto", MON_26_10, h)).toBe(true);
    expect(isMarketOpen("CRYPTO", new Date("2026-01-25T20:00:00Z"), h)).toBe(true);
  });
  it("engine allows CRYPTO on a full holiday", () => {
    const e = mkEngine(baseRisk({ marketHolidays: { NSE: ["2026-01-26"], MCX: ["2026-01-26"] } }), MON_26_10);
    expect(e.checkOrder(ord("CRYPTO", { symbol: "BTCUSDT", price: 10 }), { ordersThisRun: 0 }).allow).toBe(true);
  });
  it("a CRYPTO group in config is rejected as unknown group, without echoing it", () => {
    const err = errOf(() => load({ marketHolidays: { CRYPTO: ["2026-01-26"] } }));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("marketHolidays");
    expect(err.message).not.toContain("CRYPTO");
    expect(err.message).not.toContain("2026");
  });
});

describe("config validation", () => {
  const bad: Array<[string, unknown]> = [
    ["impossible day 2026-02-30", { NSE: ["2026-02-30"] }],
    ["non-leap 2026-02-29", { NSE: ["2026-02-29"] }],
    ["month 13", { NSE: ["2026-13-01"] }],
    ["month 00", { NSE: ["2026-00-10"] }],
    ["day 00", { NSE: ["2026-01-00"] }],
    ["unpadded 2026-1-5", { NSE: ["2026-1-5"] }],
    ["empty string", { NSE: [""] }],
    ["number 20260126", { NSE: [20260126] }],
    ["null date", { NSE: [null] }],
    ["null list", { NSE: null }],
    ["datetime suffix", { NSE: ["2026-01-26T00:00:00Z"] }],
    ["leading space", { NSE: [" 2026-01-26"] }],
    ["trailing newline", { NSE: ["2026-01-26\n"] }],
    ["slash format", { NSE: ["2026/01/26"] }],
    ["DD-MM-YYYY", { NSE: ["26-01-2026"] }],
    ["object date", { NSE: [{ d: "2026-01-26" }] }],
    ["lowercase group nse", { nse: ["2026-01-26"] }],
    ["BSE group (covered by NSE)", { BSE: ["2026-01-26"] }],
    ["empty group name", { "": ["2026-01-26"] }],
    ["top-level array", ["2026-01-26"]],
    ["top-level string", "2026-01-26"],
  ];
  it.each(bad)("rejects %s", (_n, mh) => {
    const err = errOf(() => load({ marketHolidays: mh }));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("marketHolidays");
  });
  it("marketHolidays: null rejected", () => {
    expect(errOf(() => load({ marketHolidays: null }))).toBeInstanceOf(ConfigError);
  });
  it("__proto__ group key is rejected, not silently dropped", () => {
    const err = errOf(() => loadRaw('{"marketHolidays":{"__proto__":["2026-01-26"]}}'));
    expect(err).toBeInstanceOf(ConfigError);
    expect((Object.prototype as Record<string, unknown>)[0]).toBeUndefined(); // no prototype pollution
  });
  it("leap day 2028-02-29 accepted; empty lists accepted", () => {
    expect(load({ marketHolidays: { NSE: ["2028-02-29"], MCX: [] } }).risk.marketHolidays).toEqual({ NSE: ["2028-02-29"], MCX: [] });
  });
  it("duplicates are accepted and still block", () => {
    const r = load({ marketHolidays: { NSE: ["2026-01-26", "2026-01-26"] } }).risk;
    expect(r.marketHolidays?.NSE).toHaveLength(2);
    expect(isMarketOpen("NSE", MON_26_10, r.marketHolidays)).toBe(false);
  });
  it("error messages never echo values (dates, group names, secret-looking strings)", () => {
    const cases: unknown[] = [
      { NSE: ["SECRET-TOKEN-abc123"] },
      { NSE: ["2026-02-30"] },
      { SECRETGROUP: ["2026-01-26"] },
      { NSE: "SECRET-TOKEN-abc123" },
      { MCX: [99999999] },
    ];
    for (const mh of cases) {
      const err = errOf(() => load({ marketHolidays: mh }));
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).not.toMatch(/SECRET|abc123|2026|02-30|99999999/);
    }
  });
  it("default {} yields identical decisions to no holidays", () => {
    const r = load({}).risk;
    expect(r.marketHolidays).toEqual({});
    for (const t of [MON_26_10, TUE_27_10, new Date("2026-01-24T04:30:00Z"), new Date("2026-01-27T03:44:59Z")]) {
      for (const ex of ["NSE", "MCX", "CRYPTO", "BFO"]) expect(isMarketOpen(ex, t, r.marketHolidays)).toBe(isMarketOpen(ex, t));
    }
  });
});

describe("large list performance", () => {
  const many = (() => {
    const out: string[] = [];
    const d = new Date("2000-01-01T00:00:00Z");
    for (let i = 0; i < 5000; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  })();
  // TM2-52: no wall-clock bound (it flaked under machine load). Instead scale-invariant relative bounds:
  // each "large" workload is 20x its "small" one, so linear cost gives a ~20x ratio and O(n^2) ~400x.
  // - Cost is CPU time, not wall time: other processes delay a run but add no CPU time to it.
  //   threadCpuUsage (Node >=22.19) counts only this thread; older Node falls back to process-wide cpuUsage.
  // - Windows CPU clocks tick at ~15.6 ms, so every sample repeats its workload k times so that it costs
  //   >= MIN_SAMPLE_MS of CPU (quantisation < ~8%), and the per-run cost is sample / k. A sample under
  //   MIN_SAMPLE_MS (in particular one of <= 2 ticks) is never divided by a floor: it is retaken with 2k.
  // - Each workload's cost is the median of REPS samples, interleaved small/large, after a warm-up.
  // MAX_RATIO is 1.5x linear and far below O(n^2).
  const MAX_RATIO = 30;
  const REPS = 9;
  const TICK_MS = 15.6;
  const MIN_SAMPLE_MS = 200;
  const cpuMs: () => number =
    typeof process.threadCpuUsage === "function"
      ? () => {
          const u = process.threadCpuUsage();
          return (u.user + u.system) / 1000;
        }
      : () => {
          const u = process.cpuUsage();
          return (u.user + u.system) / 1000;
        };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const runK = (fn: () => void, k: number) => {
    const t0 = cpuMs();
    for (let j = 0; j < k; j++) fn();
    return cpuMs() - t0;
  };
  /** One adaptive workload: k grows until a sample costs >= MIN_SAMPLE_MS of CPU; samples are kept per run. */
  function workload(fn: () => void) {
    let k = 1;
    const perRun: number[] = [];
    const sampleMs: number[] = [];
    const take = (): number => {
      for (;;) {
        const ms = runK(fn, k);
        if (ms >= MIN_SAMPLE_MS) return ms;
        // a reading of <= 2 ticks says little about the real cost: grow k geometrically, else estimate
        k = ms <= 2 * TICK_MS ? k * 4 : Math.max(2 * k, Math.ceil((k * MIN_SAMPLE_MS * 1.3) / ms));
        if (k > 1e7) throw new Error("workload costs no measurable CPU");
      }
    };
    return {
      calibrate: () => void take(),
      sample: () => {
        const ms = take();
        sampleMs.push(ms);
        perRun.push(ms / k);
      },
      result: () => ({ perRun: median(perRun), sampleMs, k }),
    };
  }
  type Ratio = { small: number; large: number; ratio: number; sampleMs: { small: number[]; large: number[] }; k: { small: number; large: number } };
  function costRatio(small: () => void, large: () => void): Ratio {
    small();
    large(); // warm-up: JIT and caches, not measured
    const s = workload(small);
    const l = workload(large);
    s.calibrate();
    l.calibrate();
    for (let r = 0; r < REPS; r++) {
      s.sample();
      l.sample();
    }
    const [rs, rl] = [s.result(), l.result()];
    return {
      small: rs.perRun,
      large: rl.perRun,
      ratio: rl.perRun / rs.perRun,
      sampleMs: { small: rs.sampleMs, large: rl.sampleMs },
      k: { small: rs.k, large: rl.k },
    };
  }
  const why = (what: string, m: Ratio) =>
    `${what}: large ${m.large.toFixed(3)} / small ${m.small.toFixed(3)} CPU ms per run = ${m.ratio.toFixed(1)}x ` +
    `(k ${m.k.large}/${m.k.small}; linear ~20x, O(n^2) ~400x)`;

  it("5000 dates parse and 10k checks stay fast", () => {
    const r = load({ marketHolidays: { NSE: many, MCX: many } }).risk;
    expect(r.marketHolidays?.NSE).toHaveLength(5000);
    // the last date (2013-09-08) is not 2026-01-26, so NSE stays open
    expect(isMarketOpen("NSE", MON_26_10, r.marketHolidays)).toBe(true);
    expect(isMarketOpen("NSE", MON_26_10, { NSE: [...many, "2026-01-26"] })).toBe(false);

    // parse: 5000 dates per group vs 250 (20x list length)
    const few = many.slice(0, 250);
    const parse = costRatio(
      () => load({ marketHolidays: { NSE: few, MCX: few } }),
      () => load({ marketHolidays: { NSE: many, MCX: many } }),
    );
    expect(parse.ratio, why("parse", parse)).toBeLessThanOrEqual(MAX_RATIO);

    // checks vs call count: 10k vs 500 checks (20x) against the full 5000-date list
    const hol = r.marketHolidays;
    const checks = (n: number, h: typeof hol) => () => {
      for (let i = 0; i < n; i++) isMarketOpen("NSE", MON_26_10, h);
    };
    const calls = costRatio(checks(500, hol), checks(10_000, hol));
    expect(calls.ratio, why("checks vs call count", calls)).toBeLessThanOrEqual(MAX_RATIO);

    // checks vs list length: the same 100 checks against 5000 vs 250 holidays (20x)
    const fewHol = { NSE: few, MCX: few };
    expect(isMarketOpen("NSE", MON_26_10, fewHol)).toBe(true);
    const lists = costRatio(checks(100, fewHol), checks(100, hol));
    expect(lists.ratio, why("checks vs list length", lists)).toBeLessThanOrEqual(MAX_RATIO);
  }, 300_000);
});

describe("engine paths on a holiday", () => {
  it("reserve() denies, issues no token, and does not touch day counters", () => {
    const e = mkEngine(baseRisk({ marketHolidays: NSE_26 }), MON_26_10);
    for (let i = 0; i < 5; i++) {
      const r = e.reserve(ord("NSE"), { ordersThisRun: i });
      expect(r.allow).toBe(false);
      expect(r.token).toBeUndefined();
      expect(r.reasons).toEqual(["market closed for NSE"]);
    }
    expect(e.status().today).toMatchObject({ orders: 0, notional: 0 });
  });
  it("reserve() still allows MCX the same day when only NSE listed", () => {
    const e = mkEngine(baseRisk({ marketHolidays: NSE_26 }), MON_26_10);
    expect(e.reserve(ord("MCX"), { ordersThisRun: 0 }).token).toBeDefined();
  });
  it("status() returns a copy including holidays; mutating it does not change the engine", () => {
    const e = mkEngine(baseRisk({ marketHolidays: { NSE: ["2026-01-26"], MCX: [] } }), MON_26_10);
    const s = e.status();
    // TM2-27: holidays are summarised (counts + next NSE holiday on/after today IST), not listed.
    expect(s.limits.marketHolidays).toEqual({ NSE: 1, MCX: 0, nextNSE: "2026-01-26" });
    (s.limits.marketHolidays as any).NSE = 0;
    (s.limits.marketHolidays as any).nextNSE = null;
    (s.limits.marketHolidays as any).MCX = 5;
    s.limits.allowedExchanges.length = 0;
    expect(e.checkOrder(ord("NSE"), { ordersThisRun: 0 }).allow).toBe(false);
    expect(e.checkOrder(ord("MCX"), { ordersThisRun: 0 }).allow).toBe(true);
    expect(e.status().limits.marketHolidays).toEqual({ NSE: 1, MCX: 0, nextNSE: "2026-01-26" });
    expect(e.status().limits.allowedExchanges).toContain("MCX");
  });
});

describe("SDK bindings on a holiday", () => {
  let client: any;
  function setup() {
    client = {
      quotes: vi.fn(async () => ({ status: "success", data: { ltp: 100 } })),
      analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
      pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
      placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
      modifyOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
      cancelOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
      closePosition: vi.fn(async () => ({ status: "success" })),
    };
    const risk = baseRisk({ marketHolidays: NSE_26 });
    const kill = path.join(dir, "KILL");
    const engine = mkEngine(risk, MON_26_10);
    const cfg = { mode: "paper", risk, killSwitchFile: kill } as unknown as Config;
    const b = createBindings({ client, risk: engine, cfg, auditFile: path.join(dir, "audit.log") }, { id: "r1" });
    return { b, engine };
  }
  const order = { symbol: "SBIN", exchange: "NSE", side: "BUY", quantity: 1, product: "MIS", priceType: "LIMIT", price: 100 };

  it("concurrent trade.place calls are all denied and never reach the broker", async () => {
    const { b, engine } = setup();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => b.trade.place(order)));
    for (const r of rs) {
      expect(r.status).toBe("rejected");
      expect(String((r as PromiseRejectedResult).reason?.message)).toContain("market closed for NSE");
    }
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(engine.status().today.orders).toBe(0);
  });
  it("trade.modify is denied on a holiday", async () => {
    const { b } = setup();
    await expect(b.trade.modify({ ...order, orderId: "1" })).rejects.toThrow(/market closed for NSE/);
    expect(client.modifyOrder).not.toHaveBeenCalled();
  });
  it("cancel and closePosition (reduce risk) still go through on a holiday", async () => {
    const { b } = setup();
    await b.trade.cancel({ orderId: "1" });
    await b.trade.closePosition();
    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.closePosition).toHaveBeenCalledTimes(1);
  });
  it("risk.status binding exposes holidays as a copy", async () => {
    const { b, engine } = setup();
    const s: any = await b.risk.status();
    expect(s.limits.marketHolidays).toEqual({ NSE: 1, MCX: 0, nextNSE: "2026-01-26" });
    s.limits.marketHolidays.NSE = 0;
    s.limits.marketHolidays.nextNSE = null;
    s.limits.allowedExchanges.length = 0;
    expect(engine.checkOrder(ord("NSE"), { ordersThisRun: 0 }).allow).toBe(false);
    expect(engine.checkOrder(ord("MCX"), { ordersThisRun: 0 }).allow).toBe(true);
    expect((await b.risk.status() as any).limits.marketHolidays).toEqual({ NSE: 1, MCX: 0, nextNSE: "2026-01-26" });
  });
});

// Owner ruling (O-7): ADR-5 forbids the sandbox CHANGING limits or holidays. A read-only holiday summary in
// risk.status is allowed. These pins assert that intent instead of "holidays are never mentioned".
describe("search / API docs: holidays and limits are read-only (ADR-5)", () => {
  const WRITE_VERB = /^(set|update|add|remove|delete|del|put|patch|edit|change|modify|clear|reset|write|create|upsert|toggle|enable|disable)/i;
  const LIMITS_TEXT = /holiday|limit/i;
  const text = (d: { ns: string; name: string; signature: string; doc: string }) => `${d.ns}.${d.name} ${d.signature} ${d.doc}`;

  it("no API entry can set or modify holidays or limits (no set*/update*/add*... name, no holiday/limit ns or name)", () => {
    for (const d of API_DOCS) {
      if (d.ns !== "trade") expect(d.name, `${d.ns}.${d.name}`).not.toMatch(WRITE_VERB);
      expect(d.ns, `${d.ns}.${d.name}`).not.toMatch(LIMITS_TEXT);
      expect(d.name, `${d.ns}.${d.name}`).not.toMatch(LIMITS_TEXT);
    }
    // trade.* write orders, never config: no entry takes a holiday or risk-limit key as an argument
    // (priceType 'LIMIT' is an order type, not a risk limit, so match argument keys only)
    for (const d of API_DOCS) {
      const args = d.signature.slice(d.signature.indexOf("("), d.signature.indexOf("):"));
      expect(args, `${d.ns}.${d.name}`).not.toMatch(/holiday|\bmax[A-Z]\w*|allowed(Exchanges|Products)|symbol(Allow|Deny)|contractValues|killSwitch/);
    }
    // the only risk entry is the read-only status()
    expect(API_DOCS.filter((d) => d.ns === "risk").map((d) => d.name)).toEqual(["status"]);
    expect(API_DOCS.find((d) => d.ns === "risk")!.signature).toMatch(/^status\(\):/); // takes no arguments
  });

  it("the WRITE_VERB guard itself catches the names it must forbid", () => {
    for (const n of ["setHolidays", "updateLimits", "addHoliday", "removeHoliday", "resetLimits", "SetLimit"]) expect(n).toMatch(WRITE_VERB);
    for (const n of ["status", "recent", "quote", "holdings", "walkForward"]) expect(n).not.toMatch(WRITE_VERB);
  });

  it("any doc mention of holidays is in the read-only risk.status entry only (not the header, not another entry)", () => {
    expect(API_HEADER).not.toMatch(/holiday/i);
    const mentions = API_DOCS.filter((d) => /holiday/i.test(text(d))).map((d) => `${d.ns}.${d.name}`);
    expect(mentions.every((k) => k === "risk.status")).toBe(true);
  });

  it("searching 'holiday' finds only risk.status, in both scopes, and no Rules block", () => {
    for (const scope of ["full", "readonly"] as const) {
      const out = searchApi("holiday", scope);
      expect(out).not.toContain("// Rules:");
      const fns = [...out.matchAll(/function (\w+)\(/g)].map((m) => m[1]);
      expect(fns.every((f) => f === "status")).toBe(true);
      if (fns.length) expect(out).toContain("declare namespace risk {");
      else expect(out).toContain("No API entries match");
    }
  });

  it("the SDK binding exposes only risk.status (no setter), and it cannot change holidays", async () => {
    const client = {
      quotes: vi.fn(async () => ({ status: "success", data: { ltp: 100 } })),
      analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
      pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
    };
    const risk = baseRisk({ marketHolidays: NSE_26 });
    const engine = mkEngine(risk, MON_26_10);
    const cfg = { mode: "paper", risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
    const b = createBindings({ client: client as any, risk: engine, cfg, auditFile: path.join(dir, "audit.log") }, { id: "r1" });
    expect(Object.keys(b.risk)).toEqual(["status"]);
    for (const ns of Object.keys(b)) {
      for (const fn of Object.keys((b as any)[ns])) {
        if (ns !== "trade") expect(`${ns}.${fn}`).not.toMatch(/\.(set|update|add|remove|delete|reset)/i);
      }
    }
    expect(await b.risk.status(undefined as never)).toMatchObject({ limits: { marketHolidays: { NSE: 1, MCX: 0, nextNSE: "2026-01-26" } } });
    // passing args to status() does not change anything either
    await (b.risk.status as (a?: unknown) => Promise<unknown>)({ marketHolidays: { NSE: [] }, maxQtyPerOrder: 1e9 });
    expect(engine.checkOrder(ord("NSE"), { ordersThisRun: 0 }).allow).toBe(false);
    expect(engine.status().limits.maxQtyPerOrder).toBe(100);
    expect(engine.status().limits.marketHolidays).toEqual({ NSE: 1, MCX: 0, nextNSE: "2026-01-26" });
  });
});
