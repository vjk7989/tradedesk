import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config, RiskConfig } from "../src/config.js";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import { API_DOCS, API_HEADER } from "../src/sdk/api-docs.js";

// O-7 edge tests: the kill-switch rule line and the risk.status signature must match the code, not just read well.

const SRC = path.resolve(__dirname, "../src");
const HEADER_LINES = API_HEADER.split("\n");
const KILL_LINES = HEADER_LINES.filter((l) => /^Kill switch: /.test(l));
const KILL_LINE = KILL_LINES[0] ?? "";
// Tue 2026-01-27 10:00 IST = 04:30Z: a normal NSE trading session (pinned clock, no holiday configured).
const TUE_10 = new Date("2026-01-27T04:30:00Z");

/** Reason text pushed by engine.ts when the kill file exists. */
function engineKillReason(): string {
  const src = readFileSync(path.join(SRC, "risk/engine.ts"), "utf8");
  const m = src.match(/existsSync\(this\.opts\.killSwitchFile\)\)\s*r\.push\(\s*"([^"]+)"\s*\)/);
  if (!m) throw new Error("kill-switch reason not found in engine.ts");
  return m[1];
}
/** Prefix bindings.ts puts on every risk denial. */
function bindingsDenyPrefix(): string {
  const src = readFileSync(path.join(SRC, "sdk/bindings.ts"), "utf8");
  const all = [...src.matchAll(/throw new Error\(\s*"([^"]*)"\s*\+\s*d\.reasons\.join\("; "\)\s*\)/g)].map((m) => m[1]);
  expect(all.length).toBeGreaterThanOrEqual(2); // place and modify
  expect(new Set(all).size).toBe(1);
  return all[0];
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "o7x-"));
  return () => rmSync(dir, { recursive: true, force: true });
});

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
const killFile = () => path.join(dir, "KILL");
const mkEngine = (risk: RiskConfig = baseRisk(), now: Date = TUE_10) =>
  new RiskEngine(risk, { mode: "paper", killSwitchFile: killFile(), stateFile: path.join(dir, "state.json"), now: () => now });

function setup(risk: RiskConfig = baseRisk()) {
  const client = {
    quotes: vi.fn(async () => ({ status: "success", data: { ltp: 100 } })),
    analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
    pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
    placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    modifyOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    cancelOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    closePosition: vi.fn(async () => ({ status: "success" })),
  };
  const engine = mkEngine(risk);
  const cfg = { mode: "paper", risk, killSwitchFile: killFile() } as unknown as Config;
  const b = createBindings({ client: client as any, risk: engine, cfg, auditFile: path.join(dir, "audit.log") }, { id: "o7" });
  return { b, engine, client };
}
const ORDER = { symbol: "SBIN", exchange: "NSE", side: "BUY", quantity: 1, product: "MIS", priceType: "LIMIT", price: 100 };
const errMsg = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected rejection");
};

describe("O-7 edge: kill-switch rule line quotes the code", () => {
  it("API_HEADER has exactly one kill-switch line, placed after the risk-denied line", () => {
    expect(KILL_LINES).toHaveLength(1);
    const denied = HEADER_LINES.findIndex((l) => l.startsWith("Risk violations are thrown as Error('risk denied"));
    expect(denied).toBeGreaterThanOrEqual(0);
    expect(HEADER_LINES.indexOf(KILL_LINE)).toBeGreaterThan(denied);
  });

  it("quotes the exact denial text: bindings prefix + engine.ts reason", () => {
    const full = bindingsDenyPrefix() + engineKillReason();
    expect(full).toBe("risk denied: kill switch active");
    expect(KILL_LINE).toContain(`'${full}'`);
    // exactly one quoted string, and it is the denial text (no stale or paraphrased variant)
    expect(KILL_LINE.match(/'[^']*'/g)).toEqual([`'${full}'`]);
  });

  it("says new orders and modifications are refused, and names risk.status().killSwitch", () => {
    expect(KILL_LINE).toMatch(/new orders and modifications are refused/);
    expect(KILL_LINE).toContain("risk.status().killSwitch");
    expect(KILL_LINE).toMatch(/KILL file/);
  });

  it("says cancel and closePosition are still allowed, without trade.* names (readonly-safe)", () => {
    expect(KILL_LINE).toMatch(/cancel and closePosition[^;]*still allowed/);
    expect(KILL_LINE).not.toMatch(/trade\.(place|modify|cancel|closePosition)/);
  });

  it("the trade.cancel / trade.closePosition entries agree with the header line", () => {
    for (const name of ["cancel", "closePosition"]) {
      const d = API_DOCS.find((x) => x.ns === "trade" && x.name === name)!;
      expect(d.doc).toContain("Allowed even when the kill switch is on.");
    }
  });
});

describe("O-7 edge: kill-file behaviour matches the line (real bindings, pinned clock)", () => {
  it("kill file present: trade.place is refused with exactly the quoted text and never reaches the broker", async () => {
    const { b, engine, client } = setup();
    writeFileSync(killFile(), "");
    expect(await errMsg(b.trade.place(ORDER))).toBe("risk denied: kill switch active");
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(engine.status().today.orders).toBe(0);
  });

  it("kill file present: trade.modify is refused with the same text and never reaches the broker", async () => {
    const { b, client } = setup();
    writeFileSync(killFile(), "STOP");
    expect(await errMsg(b.trade.modify({ ...ORDER, orderId: "42" }))).toBe("risk denied: kill switch active");
    expect(client.modifyOrder).not.toHaveBeenCalled();
  });

  it("kill file present: cancel and closePosition still reach the broker", async () => {
    const { b, client } = setup();
    writeFileSync(killFile(), "");
    await expect(b.trade.cancel({ orderId: "42" })).resolves.toMatchObject({ status: "success" });
    await expect(b.trade.closePosition()).resolves.toMatchObject({ status: "success" });
    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.closePosition).toHaveBeenCalledTimes(1);
  });

  it("concurrent place calls under the kill file are all refused", async () => {
    const { b, client } = setup();
    writeFileSync(killFile(), "");
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => b.trade.place(ORDER)));
    for (const r of rs) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason.message).toBe("risk denied: kill switch active");
    }
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it("other reasons are joined after the kill-switch reason (the quoted text is a prefix, not the whole message)", async () => {
    const { b } = setup();
    writeFileSync(killFile(), "");
    const m = await errMsg(b.trade.place({ ...ORDER, quantity: 101 }));
    expect(m.startsWith("risk denied: kill switch active; ")).toBe(true);
    expect(m).toContain("quantity 101 exceeds maxQtyPerOrder 100");
  });

  it("toggle: no file -> place allowed; file -> refused; file removed -> allowed again; status().killSwitch tracks it", async () => {
    const { b, client } = setup();
    expect(((await b.risk.status()) as any).killSwitch).toBe(false);
    await expect(b.trade.place(ORDER)).resolves.toBeDefined();
    writeFileSync(killFile(), "");
    expect(((await b.risk.status()) as any).killSwitch).toBe(true);
    await expect(b.trade.place(ORDER)).rejects.toThrow("risk denied: kill switch active");
    await expect(b.trade.modify({ ...ORDER, orderId: "1" })).rejects.toThrow("risk denied: kill switch active");
    rmSync(killFile());
    expect(((await b.risk.status()) as any).killSwitch).toBe(false);
    await expect(b.trade.place(ORDER)).resolves.toBeDefined();
    await expect(b.trade.modify({ ...ORDER, orderId: "1" })).resolves.toBeDefined();
    expect(client.placeOrder).toHaveBeenCalledTimes(2);
    expect(client.modifyOrder).toHaveBeenCalledTimes(1);
  });
});

// ---- risk.status signature vs runtime output ----
type Shape = { [k: string]: Shape | string };

/** Parse a TS object type literal "{ a: T; b?: { c: U } }" into key -> nested shape or leaf type text. */
function parseObjectType(src: string): Shape {
  let i = 0;
  const ws = () => {
    while (/\s/.test(src[i] ?? "")) i++;
  };
  const obj = (): Shape => {
    ws();
    if (src[i] !== "{") throw new Error(`expected { at ${i}`);
    i++;
    const out: Shape = {};
    for (;;) {
      ws();
      if (src[i] === "}") {
        i++;
        return out;
      }
      const km = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(src.slice(i));
      if (!km) throw new Error(`bad key at ${i}: ${src.slice(i, i + 20)}`);
      if (km[1] in out) throw new Error(`duplicate key ${km[1]}`);
      i += km[0].length;
      ws();
      if (src[i] === "{") {
        const start = i;
        const nested = obj();
        ws();
        // "{...}[]" or "{...} | null" is a leaf, not a nested object
        if (src[i] === "[" || src[i] === "|") {
          let depth = 0;
          while (i < src.length && !(depth === 0 && (src[i] === ";" || src[i] === "}"))) {
            if (src[i] === "{") depth++;
            if (src[i] === "}") depth--;
            i++;
          }
          out[km[1]] = src.slice(start, i).trim();
        } else out[km[1]] = nested;
      } else {
        const start = i;
        let depth = 0;
        while (i < src.length && !(depth === 0 && (src[i] === ";" || src[i] === "}"))) {
          if ("{<([".includes(src[i])) depth++;
          if ("}>)]".includes(src[i])) depth--;
          i++;
        }
        out[km[1]] = src.slice(start, i).trim();
      }
      ws();
      if (src[i] === ";") i++;
    }
  };
  const r = obj();
  ws();
  if (i !== src.length) throw new Error(`trailing text at ${i}`);
  return r;
}

function statusShape(): Shape {
  const d = API_DOCS.find((x) => x.ns === "risk" && x.name === "status")!;
  const m = /^status\(\): Promise<([\s\S]*)>$/.exec(d.signature);
  if (!m) throw new Error("unexpected risk.status signature");
  return parseObjectType(m[1]);
}

/** Does a runtime value fit a leaf type text like "string[]", "number | null", "boolean"? */
function fits(v: unknown, t: string): boolean {
  return t.split("|").map((s) => s.trim()).some((alt) => {
    if (alt === "null") return v === null;
    if (alt.endsWith("[]")) return Array.isArray(v) && v.every((x) => fits(x, alt.slice(0, -2)));
    if (alt === "string" || alt === "number" || alt === "boolean") return typeof v === alt;
    if (alt === "object") return typeof v === "object" && v !== null;
    return false;
  });
}

/** Compare runtime value to the parsed shape; returns a list of mismatches (empty = equal). */
function diffShape(v: unknown, s: Shape, at = "status()"): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${at}: expected object`];
  const out: string[] = [];
  const rk = Object.keys(v).sort();
  const sk = Object.keys(s).sort();
  if (rk.join(",") !== sk.join(",")) out.push(`${at}: runtime keys [${rk}] != signature keys [${sk}]`);
  for (const k of sk) {
    if (!(k in v)) continue;
    const sub = s[k];
    const val = (v as Record<string, unknown>)[k];
    if (typeof sub === "string") {
      if (!fits(val, sub)) out.push(`${at}.${k}: ${JSON.stringify(val)} does not fit ${sub}`);
    } else out.push(...diffShape(val, sub, `${at}.${k}`));
  }
  return out;
}

describe("O-7 edge: risk.status signature equals the runtime status() output (real RiskEngine, pinned clock)", () => {
  it("parser self-check on a small literal", () => {
    expect(parseObjectType("{ a: string; b?: { c: number | null; d: string[] }; e: { x: number }[] }")).toEqual({
      a: "string",
      b: { c: "number | null", d: "string[]" },
      e: "{ x: number }[]",
    });
    expect(() => parseObjectType("{ a: string; a: number }")).toThrow(/duplicate/);
  });

  it("signature parses and has the four top-level keys", () => {
    expect(Object.keys(statusShape())).toEqual(["mode", "killSwitch", "limits", "today"]);
  });

  it("minimal config (optional limits unset, no holidays): keys and leaf types match exactly", () => {
    const s = mkEngine().status();
    expect(s.limits.maxShortOptionQtyPerOrder).toBeNull();
    expect(s.limits.marketHolidays.nextNSE).toBeNull();
    expect(diffShape(s, statusShape())).toEqual([]);
  });

  it("full config (cap set, holidays, contractValues, kill file on, orders used): keys and leaf types match", () => {
    writeFileSync(killFile(), "");
    const e = mkEngine(
      baseRisk({
        maxShortOptionQtyPerOrder: 5,
        contractValues: { ETHUSDFUT: 0.01, BTCUSDFUT: 0.001 },
        marketHolidays: { NSE: ["2026-01-26", "2026-03-03"], MCX: ["2026-03-03"] },
      }),
    );
    const s = e.status();
    expect(s.killSwitch).toBe(true);
    expect(s.limits.maxShortOptionQtyPerOrder).toBe(5);
    expect(s.limits.contractValues).toBe(2);
    expect(s.limits.marketHolidays).toEqual({ NSE: 2, MCX: 1, nextNSE: "2026-03-03" });
    expect(s.today.date).toBe("2026-01-27");
    expect(diffShape(s, statusShape())).toEqual([]);
  });

  it("the binding returns the same keys as the engine (no extra or missing fields at the SDK boundary)", async () => {
    const { b, engine } = setup();
    const viaSdk = await b.risk.status();
    expect(diffShape(viaSdk, statusShape())).toEqual([]);
    expect(viaSdk).toEqual(engine.status());
  });

  it("an extra or missing runtime key would be reported (the comparison is not vacuous)", () => {
    const s = mkEngine().status() as any;
    expect(diffShape({ ...s, extra: 1 }, statusShape()).length).toBeGreaterThan(0);
    const { remainingOrders: _r, ...todayMissing } = s.today;
    expect(diffShape({ ...s, today: todayMissing }, statusShape()).length).toBeGreaterThan(0);
    expect(diffShape({ ...s, killSwitch: "yes" }, statusShape()).length).toBeGreaterThan(0);
  });
});

describe("O-7 edge: search 'kill switch' returns the Rules line", () => {
  for (const scope of ["full", "readonly"] as const) {
    it(`${scope}: Rules block contains the kill-switch line verbatim and in full`, () => {
      const out = searchApi("kill switch", scope);
      expect(out.startsWith("// Rules:\n")).toBe(true);
      const rules = out.slice("// Rules:\n".length).split("\n\n")[0].split("\n");
      expect(rules).toContain(KILL_LINE);
      expect(out).toContain(`\n${KILL_LINE}\n`); // whole line, not truncated
      expect(out).toContain("declare namespace risk {"); // risk.status still rendered
    });
  }

  it("readonly: no trade.* entry is rendered even though the rule mentions cancel and closePosition", () => {
    const out = searchApi("kill switch", "readonly");
    expect(out).not.toContain("declare namespace trade");
    expect(out).not.toMatch(/function (place|modify|cancel|closePosition)\(/);
  });

  it.each(["KILL SWITCH", "  kill   switch  ", "Kill", "closePosition", "killswitch"])("%j also surfaces the line", (q) => {
    expect(searchApi(q)).toContain(KILL_LINE);
  });

  it("a near-miss query does not surface the line", () => {
    expect(searchApi("kil-swich")).not.toContain(KILL_LINE);
  });
});
