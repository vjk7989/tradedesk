import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAudit } from "../src/risk/audit.js";
import { createBindings } from "../src/sdk/bindings.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const TS = NOW.toISOString();
const LIMIT = 64 * 1024;
const newFile = () => path.join(mkdtempSync(path.join(tmpdir(), "o4e-")), "audit.jsonl");
/** Each write goes to a fresh file so the fixed (past) clock never triggers rotation. */
const rawOf = (e: object): string => {
  const f = newFile();
  appendAudit(f, e, () => NOW);
  const ls = readFileSync(f, "utf8").split("\n").filter(Boolean);
  expect(ls).toHaveLength(1);
  return ls[0];
};
const parsed = (e: object): any => JSON.parse(rawOf(e));
/** Lone (unpaired) UTF-16 surrogate. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** JSON escape of a lone high surrogate, as JSON.stringify writes it. */
const ESC_HI = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i;
const deepStrings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), deepStrings(x, out));
  return out;
};
const EMOJI = "\u{1F680}"; // 2 UTF-16 units, 4 UTF-8 bytes
const DEVA = "म"; // 1 unit, 3 bytes
const HI = String.fromCharCode(0xd83d); // lone high surrogate
const nest = (d: number, leaf: object = { leaf: 1 }) => {
  const e: any = {};
  let cur = e;
  for (let i = 0; i < d; i++) cur = cur.c = {};
  Object.assign(cur, leaf);
  return e;
};
const walk = (e: any, d: number) => {
  let cur = e;
  for (let i = 0; i < d; i++) cur = cur.c;
  return cur;
};
const pad40 = () => Array.from({ length: 40 }, () => "x".repeat(2000)); // pushes any line past 64 KB

describe("O-4 edge: string length boundary (2000)", () => {
  for (const len of [1999, 2000, 2001]) {
    it(`ASCII ${len} chars`, () => {
      expect(parsed({ s: "a".repeat(len) }).s).toBe(len > 2000 ? "a".repeat(2000) + "…[+1 chars]" : "a".repeat(len));
    });
    it(`Devanagari ${len} chars (3-byte UTF-8)`, () => {
      expect(parsed({ s: DEVA.repeat(len) }).s).toBe(len > 2000 ? DEVA.repeat(2000) + "…[+1 chars]" : DEVA.repeat(len));
    });
  }

  it("emoji filling exactly 2000 units is kept", () => {
    expect(parsed({ s: EMOJI.repeat(1000) }).s).toBe(EMOJI.repeat(1000));
  });

  it("emoji ending exactly at the cut is kept whole", () => {
    expect(parsed({ s: EMOJI.repeat(1000) + "z" }).s).toBe(EMOJI.repeat(1000) + "…[+1 chars]");
  });

  it("emoji straddling unit 2000 is never split (output is well-formed UTF-16)", () => {
    const s: string = parsed({ s: "z" + EMOJI.repeat(1000) }).s;
    expect(LONE.test(s)).toBe(false);
    expect(s).toBe("z" + EMOJI.repeat(999) + "…[+1 chars]"); // marker counts characters, not units
  });

  it("2001 emoji (4002 units): marker counts dropped characters", () => {
    expect(parsed({ s: EMOJI.repeat(2001) }).s).toBe(EMOJI.repeat(1000) + "…[+1001 chars]");
  });

  it("emoji straddling the cut: raw line has no escaped lone surrogate and round-trips", () => {
    const r = rawOf({ s: "z" + EMOJI.repeat(1500) });
    expect(r).not.toMatch(ESC_HI);
    expect(deepStrings(JSON.parse(r)).some((x) => LONE.test(x))).toBe(false);
  });

  it("a lone surrogate already in the input still yields parseable JSON", () => {
    expect(() => JSON.parse(rawOf({ s: "a".repeat(1999) + HI + "b".repeat(10) }))).not.toThrow();
  });

  it("empty and 1-char strings are untouched", () => {
    expect(parsed({ a: "", b: "x" })).toMatchObject({ a: "", b: "x" });
  });
});

describe("O-4 edge: array length boundary (100)", () => {
  for (const n of [99, 100, 101]) {
    it(`${n} object items, secrets redacted inside kept items`, () => {
      const a = parsed({ a: Array.from({ length: n }, (_, i) => ({ i, token: "SECRET" + i })) }).a as any[];
      expect(a).toHaveLength(Math.min(n, 100) + (n > 100 ? 1 : 0));
      for (let i = 0; i < Math.min(n, 100); i++) expect(a[i]).toEqual({ i, token: "[REDACTED]" });
      if (n > 100) expect(a[100]).toBe("…[+1 items]");
    });
  }

  it("empty array is kept, sparse array holes serialize as null", () => {
    const sparse = new Array(3);
    sparse[1] = "x";
    expect(parsed({ e: [], s: sparse })).toMatchObject({ e: [], s: [null, "x", null] });
  });

  it("items past 100 never reach the line", () => {
    const a = Array.from({ length: 150 }, (_, i) => (i >= 100 ? { note: "LEAKME" + i } : i));
    const r = rawOf({ a });
    expect(r).not.toContain("LEAKME");
    expect(JSON.parse(r).a.at(-1)).toBe("…[+50 items]");
  });
});

describe("O-4 edge: object key cap (200)", () => {
  const obj = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["k" + i, i]));
  for (const n of [199, 200, 201]) {
    it(`${n} keys`, () => {
      const o = parsed({ o: obj(n) }).o;
      expect(Object.keys(o)).toHaveLength(Math.min(n, 200) + (n > 200 ? 1 : 0));
      expect(o.k199 === undefined).toBe(n < 200);
      if (n > 200) {
        expect(o["…"]).toBe("[+1 keys]");
        expect(o.k200).toBeUndefined();
      } else expect(o["…"]).toBeUndefined();
    });
  }

  it("secrets in kept keys are redacted; secrets past the cap never appear", () => {
    const o: Record<string, string> = { password: "SEKRET-0" };
    for (let i = 0; i < 300; i++) o["k" + i] = "v";
    o.secret = "SEKRET-LATE";
    const r = rawOf({ o });
    expect(r).not.toContain("SEKRET");
    expect(JSON.parse(r).o.password).toBe("[REDACTED]");
  });
});

describe("O-4 edge: depth boundary (8)", () => {
  for (const d of [7, 8, 9]) {
    it(`object at depth ${d}`, () => {
      const v = walk(parsed(nest(d)), d);
      if (d > 8) expect(v).toBe("[depth limit]");
      else expect(v).toEqual({ leaf: 1 });
    });
  }

  it("primitives inside the depth-8 object are kept (only containers are cut)", () => {
    expect(walk(parsed(nest(8, { leaf: "p" })), 8)).toEqual({ leaf: "p" });
  });

  it("secret key at depth 8 is redacted", () => {
    expect(walk(parsed(nest(8, { apiKey: "SEKRET-8", ok: 1 })), 8)).toEqual({ apiKey: "[REDACTED]", ok: 1 });
  });

  for (const d of [9, 10, 20]) {
    it(`secret at depth ${d} never appears in the line`, () => {
      const r = rawOf(nest(d, { password: "SEKRET-DEEP", sub: { token: "SEKRET-DEEP2" } }));
      expect(r).not.toContain("SEKRET");
      expect(r).toContain("[depth limit]");
    });
  }

  it("very deep input (10k levels) does not overflow the stack", () => {
    expect(() => rawOf(nest(10_000))).not.toThrow();
  });
});

describe("O-4 edge: redaction vs truncation markers", () => {
  it("a long secret string is [REDACTED], not cut (no length leak)", () => {
    const l = parsed({ secret: "s".repeat(5000), nested: { authorization: "B".repeat(3000) } });
    expect(l.secret).toBe("[REDACTED]");
    expect(l.nested.authorization).toBe("[REDACTED]");
    expect(JSON.stringify(l)).not.toMatch(/chars\]/);
  });

  it("a long secret array is [REDACTED], not an items marker", () => {
    const l = parsed({ session: Array.from({ length: 500 }, (_, i) => "tok" + i) });
    expect(l.session).toBe("[REDACTED]");
    expect(JSON.stringify(l)).not.toMatch(/items\]|tok\d/);
  });

  it("secret-keyed object at depth 9 is never revealed", () => {
    expect(rawOf(nest(9, { cookie: { v: "SEKRET-C" } }))).not.toContain("SEKRET");
  });

  it("over-64KB replacement drops every secret field", () => {
    const r = rawOf({ run: "rS", apiKey: "SEKRET-K", pad: pad40() });
    expect(r).not.toContain("SEKRET");
    expect(JSON.parse(r)).toMatchObject({ run: "rS", truncated: true });
  });
});

describe("O-4 edge: 64 KB line boundary", () => {
  /** Entry whose serialized line is exactly `target` bytes, with `tail` (possibly multi-byte) at the end of the last string. */
  const sized = (target: number, tail = "") => {
    const e: any = { run: "rB" };
    for (let i = 0; i < 32; i++) e[`k${i}`] = DEVA.repeat(600) + "x".repeat(200);
    e.last = tail;
    const base = Buffer.byteLength(JSON.stringify({ ...e, ts: TS }));
    e.last = "y".repeat(target - base) + tail;
    expect(e.last.length).toBeLessThanOrEqual(2000); // precondition: only the line cap is in play
    expect(Buffer.byteLength(JSON.stringify({ ...e, ts: TS }))).toBe(target);
    return e;
  };
  for (const tail of ["", EMOJI, DEVA, "é"]) {
    for (const target of [65535, 65536, 65537]) {
      it(`${target} bytes, tail ${JSON.stringify(tail)}`, () => {
        const r = rawOf(sized(target, tail));
        if (target > LIMIT) {
          expect(r).toBe(JSON.stringify({ ts: TS, run: "rB", truncated: true, bytes: target }));
        } else {
          expect(Buffer.byteLength(r)).toBe(target);
          expect(JSON.parse(r).last.endsWith(tail)).toBe(true);
        }
      });
    }
  }

  it("bytes counts UTF-8 bytes, not UTF-16 units", () => {
    const e = { run: "rU", p: Array.from({ length: 20 }, () => EMOJI.repeat(1000)) };
    const expected = Buffer.byteLength(JSON.stringify({ ...e, ts: TS }));
    expect(expected).toBeGreaterThan(LIMIT);
    const l = JSON.parse(rawOf(e));
    expect(l).toEqual({ ts: TS, run: "rU", truncated: true, bytes: expected });
    expect(l.bytes).not.toBe(JSON.stringify({ ...e, ts: TS }).length);
  });

  it("bytes is measured after sanitize (cut strings), not on the raw input", () => {
    const e = { run: "rC", p: Array.from({ length: 40 }, () => "x".repeat(10_000)) };
    const san = { run: "rC", p: Array.from({ length: 40 }, () => "x".repeat(2000) + "…[+8000 chars]"), ts: TS };
    expect(parsed(e).bytes).toBe(Buffer.byteLength(JSON.stringify(san)));
  });

  it("a caller-supplied ts is overwritten in both normal and replaced lines", () => {
    expect(parsed({ ts: "fake", a: 1 }).ts).toBe(TS);
    expect(parsed({ ts: "fake", run: "r", p: pad40() }).ts).toBe(TS);
  });

  it("over 64 KB without run: run omitted", () => {
    expect(Object.keys(parsed({ p: pad40() }))).toEqual(["ts", "truncated", "bytes"]);
  });

  it("one huge key (keys are not cut) still yields a bounded line", () => {
    const r = rawOf({ run: "rK", ["k".repeat(70_000)]: 1 });
    expect(Buffer.byteLength(r)).toBeLessThanOrEqual(LIMIT);
    expect(JSON.parse(r)).toMatchObject({ run: "rK", truncated: true });
  });

  it("replacement line stays within 64 KB even when run is large (run capped at 200 chars)", () => {
    const r = rawOf({ run: Array.from({ length: 50 }, () => "r".repeat(2000)), x: 1 });
    expect(Buffer.byteLength(r)).toBeLessThanOrEqual(LIMIT);
    expect(String(JSON.parse(r).run).length).toBeLessThanOrEqual(200);
  });

  for (const n of [199, 200, 201]) {
    it(`fallback run of ${n} chars is kept whole up to 200`, () => {
      expect(parsed({ run: "R".repeat(n), p: pad40() }).run).toBe("R".repeat(Math.min(n, 200)));
    });
  }

  // BUG (fix round 1): fallbackRun uses String(run).slice(0, 200), which is not surrogate-safe (unlike cutString).
  it("fallback run cap never splits a surrogate pair", () => {
    const r = rawOf({ run: "z" + EMOJI.repeat(150), p: pad40() });
    const l = JSON.parse(r);
    expect(l.truncated).toBe(true);
    expect(LONE.test(l.run)).toBe(false);
    expect(r).not.toMatch(ESC_HI);
  });
});

describe("O-4 edge: odd values never throw from appendAudit", () => {
  const cases: [string, () => object][] = [
    ["undefined", () => ({ u: undefined, a: [undefined] })],
    ["function", () => ({ f: () => 1, a: [function g() {}] })],
    ["Symbol value and Symbol key", () => ({ s: Symbol("x"), [Symbol("k")]: 1, a: [Symbol("y")] })],
    ["Date", () => ({ d: new Date(0), bad: new Date(NaN) })],
    ["Buffer", () => ({ b: Buffer.from("hello") })],
    ["Uint8Array", () => ({ u: new Uint8Array([1, 2, 3]) })],
    ["NaN / Infinity / -0", () => ({ n: NaN, i: Infinity, m: -Infinity, z: -0 })],
    ["null prototype", () => Object.assign(Object.create(null), { a: 1, token: "t", n: Object.assign(Object.create(null), { b: 2 }) })],
    ["Map / Set / RegExp / Error", () => ({ m: new Map([[1, 2]]), s: new Set([1]), r: /x/g, e: new Error("boom") })],
    ["object with toJSON", () => ({ t: { toJSON: () => "J", v: 1 } })],
    ["BigInt", () => ({ qty: 10n, a: [1n] })],
    [
      "getter that throws",
      () => {
        const o: any = { ok: 1 };
        Object.defineProperty(o, "bad", { enumerable: true, get() { throw new Error("getter boom"); } });
        return { o };
      },
    ],
    ["Proxy whose ownKeys throws", () => ({ p: new Proxy({}, { ownKeys() { throw new Error("trap"); } }) })],
  ];
  for (const [name, mk] of cases) {
    it(name, () => {
      const f = newFile();
      expect(() => appendAudit(f, mk(), () => NOW)).not.toThrow();
      const ls = readFileSync(f, "utf8").split("\n").filter(Boolean);
      expect(ls).toHaveLength(1);
      expect(JSON.parse(ls[0]).ts).toBe(TS);
    });
  }

  it("rulings: bigint -> string, throwing getter / ownKeys -> [unreadable], binary -> [binary N bytes]", () => {
    const o: any = { ok: 1, apiKey: "k" };
    Object.defineProperty(o, "bad", { enumerable: true, get() { throw new Error("boom"); } });
    const l = parsed({
      qty: 10n,
      big: [2n ** 70n],
      o,
      p: new Proxy({}, { ownKeys() { throw new Error("trap"); } }),
      b: Buffer.from("hello"),
      u: new Uint8Array(3),
      f64: new Float64Array(2),
      dv: new DataView(new ArrayBuffer(7)),
    });
    expect(l).toMatchObject({
      qty: "10",
      big: [(2n ** 70n).toString()],
      o: { ok: 1, apiKey: "[REDACTED]", bad: "[unreadable]" },
      p: "[unreadable]",
      b: "[binary 5 bytes]",
      u: "[binary 3 bytes]",
      f64: "[binary 16 bytes]",
      dv: "[binary 7 bytes]",
    });
  });

  it("binary under a secret key is [REDACTED]; empty Buffer is [binary 0 bytes]", () => {
    expect(parsed({ token: Buffer.from("s"), b: Buffer.alloc(0) })).toMatchObject({ token: "[REDACTED]", b: "[binary 0 bytes]" });
  });

  it("toJSON functions are dropped, never invoked", () => {
    let called = false;
    expect(parsed({ t: { toJSON: () => ((called = true), "J"), v: 1 } }).t).toEqual({ v: 1 });
    expect(called).toBe(false);
  });

  it("throwing getter on the top-level entry does not lose the entry", () => {
    const e: any = { run: "rT", a: 1 };
    Object.defineProperty(e, "bad", { enumerable: true, get() { throw new Error("x"); } });
    expect(parsed(e)).toMatchObject({ run: "rT", a: 1, bad: "[unreadable]", ts: TS });
  });

  it("null-prototype secret is still redacted", () => {
    const e = Object.assign(Object.create(null), { token: "SEKRET", a: 1 });
    expect(parsed(e)).toEqual({ token: "[REDACTED]", a: 1, ts: TS });
  });

  it("NaN/Infinity serialize as null", () => {
    expect(parsed({ n: NaN, i: Infinity })).toMatchObject({ n: null, i: null });
  });

  it("cycle via object and via array gives [cycle]", () => {
    const o: any = { n: 1 };
    o.me = o;
    const a: any[] = [1];
    a.push(a);
    const l = parsed({ o, a });
    expect(l.o).toEqual({ n: 1, me: "[cycle]" });
    expect(l.a).toEqual([1, "[cycle]"]);
  });

  it("indirect cycle (a -> b -> a) gives [cycle] at the back-edge only", () => {
    const a: any = { name: "a" };
    const b: any = { name: "b", a };
    a.b = b;
    expect(parsed({ a }).a).toEqual({ name: "a", b: { name: "b", a: "[cycle]" } });
  });

  it("shared non-cyclic reference is expanded at every use, including inside arrays", () => {
    const s = { z: 1, token: "t" };
    const exp = { z: 1, token: "[REDACTED]" };
    expect(parsed({ p: s, q: s, arr: [s, s, { s }] })).toMatchObject({ p: exp, q: exp, arr: [exp, exp, { s: exp }] });
  });

  it("does not mutate the caller's entry", () => {
    const e = { a: "x".repeat(3000), arr: new Array(200).fill(1), apiKey: "k" };
    const snap = JSON.stringify(e);
    rawOf(e);
    expect(JSON.stringify(e)).toBe(snap);
  });
});

describe("O-4 edge: audit.recent round trip", () => {
  it("parses cut-string, cut-array, depth-limited, cycle and >64KB entries", async () => {
    const f = newFile();
    const cyc: any = { n: 1 };
    cyc.self = cyc;
    appendAudit(f, { run: "a", s: "z" + EMOJI.repeat(1500) });
    appendAudit(f, { run: "b", arr: new Array(300).fill({ token: "t" }) });
    appendAudit(f, { run: "c", ...nest(12) });
    appendAudit(f, { run: "d", cyc });
    appendAudit(f, { run: "e", p: Array.from({ length: 40 }, () => DEVA.repeat(2000)) });
    const b = createBindings({ client: {} as any, risk: {} as any, cfg: {} as any, auditFile: f }, { id: "r1" }) as any;
    const r = await b.audit.recent({ limit: 10 });
    expect(r.skipped).toBe(0);
    const byRun = Object.fromEntries((r.entries as any[]).map((x) => [x.run, x]));
    expect(byRun.a.s).toBe("z" + EMOJI.repeat(999) + "…[+501 chars]");
    expect(byRun.b.arr).toHaveLength(101);
    expect(byRun.b.arr[0]).toEqual({ token: "[REDACTED]" });
    expect(JSON.stringify(byRun.c)).toContain("[depth limit]");
    expect(byRun.d.cyc).toEqual({ n: 1, self: "[cycle]" });
    expect(byRun.e).toMatchObject({ truncated: true });
    expect(byRun.e.bytes).toBeGreaterThan(LIMIT);
  });

  it("the audit.recent call's own entry (with huge args) is itself bounded", async () => {
    const f = newFile();
    const b = createBindings({ client: {} as any, risk: {} as any, cfg: {} as any, auditFile: f }, { id: "r1" }) as any;
    await b.audit.recent({ limit: 5, junk: "q".repeat(200_000) }).catch(() => undefined);
    for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      expect(Buffer.byteLength(l)).toBeLessThanOrEqual(LIMIT);
      expect(l).not.toContain("q".repeat(2001));
    }
  });
});

describe("O-4 edge: normal entries are byte-identical to main", () => {
  // Snapshots produced by main's audit.ts (origin/main 38a3ec4) for the same inputs and clock.
  it("order entry (unicode, -0, 1e21, nested secrets)", () => {
    const ORDER = { run: "run-7f3a", action: "placeorder", args: { symbol: "RELIANCE", exchange: "NSE", action: "BUY", quantity: 10, price: 2500.5, pricetype: "LIMIT", product: "MIS", strategy: "मोमेंटम 🚀", apikey: "sk-live-123", headers: { Authorization: "Bearer x", "x-session-id": "s" } }, decision: "allowed", order_id: "250102000012345", result: { status: "success", orderid: "250102000012345", data: [1, -0, 1e21, 0.1, null, true, "é"] } };
    expect(rawOf(ORDER)).toBe(
      '{"run":"run-7f3a","action":"placeorder","args":{"symbol":"RELIANCE","exchange":"NSE","action":"BUY","quantity":10,"price":2500.5,"pricetype":"LIMIT","product":"MIS","strategy":"मोमेंटम 🚀","apikey":"[REDACTED]","headers":{"Authorization":"[REDACTED]","x-session-id":"[REDACTED]"}},"decision":"allowed","order_id":"250102000012345","result":{"status":"success","orderid":"250102000012345","data":[1,0,1e+21,0.1,null,true,"é"]},"ts":"2026-01-02T03:04:05.000Z"}',
    );
  });

  it("backtest entry", () => {
    const BT = { run: "run-7f3a", action: "backtest.run", args: { codeSha256: "ab".repeat(32), codeBytes: 1234, symbols: ["NSE:RELIANCE", "NSE:TCS"], start: "2024-01-01", end: "2024-12-31", interval: "1d", capital: 100000, costs: { brokerage: 20, slippage_bps: 5 }, signal_parameters: { fast: 10, slow: 50, apiToken: "zzz" } }, decision: "allowed", ok: true, error: null };
    expect(rawOf(BT)).toBe(
      '{"run":"run-7f3a","action":"backtest.run","args":{"codeSha256":"abababababababababababababababababababababababababababababababab","codeBytes":1234,"symbols":["NSE:RELIANCE","NSE:TCS"],"start":"2024-01-01","end":"2024-12-31","interval":"1d","capital":100000,"costs":{"brokerage":20,"slippage_bps":5},"signal_parameters":{"fast":10,"slow":50,"apiToken":"[REDACTED]"}},"decision":"allowed","ok":true,"error":null,"ts":"2026-01-02T03:04:05.000Z"}',
    );
  });
});

// Bounds are loose on purpose (O-7): they catch pathological (quadratic / unbounded) behaviour, not load noise.
// 10 MB inputs must finish in under 5 s; the 500k-key object in under 15 s; each test may take up to 30 s.
const PERF_MS = 5_000;
const WIDE_MS = 15_000;
const PERF_TIMEOUT = 30_000;

describe("O-4 edge: performance (10 MB input under 5 s)", () => {
  const MB10 = 10 * 1024 * 1024;
  const time = (e: object) => {
    const f = newFile();
    const t0 = performance.now();
    appendAudit(f, e, () => NOW);
    return performance.now() - t0;
  };
  it("bounds are ordered: per-case bound < 500k-key bound < test timeout", () => {
    expect(PERF_MS).toBe(5_000);
    expect(WIDE_MS).toBe(15_000);
    expect(PERF_TIMEOUT).toBe(30_000);
    expect(PERF_MS).toBeLessThan(WIDE_MS);
    expect(WIDE_MS).toBeLessThan(PERF_TIMEOUT);
  });
  it("one 10 MB string", { timeout: PERF_TIMEOUT }, () => {
    expect(time({ run: "p", s: "x".repeat(MB10) })).toBeLessThan(PERF_MS);
  });
  it("10 MB array of short strings", { timeout: PERF_TIMEOUT }, () => {
    expect(time({ run: "p", a: Array.from({ length: MB10 / 10 }, () => "abcdefghij") })).toBeLessThan(PERF_MS);
  });
  it("10 MB spread over 5000 strings of 2 KB in nested arrays", { timeout: PERF_TIMEOUT }, () => {
    const rows = Array.from({ length: 50 }, () => Array.from({ length: 100 }, () => "y".repeat(2048)));
    expect(time({ run: "p", rows })).toBeLessThan(PERF_MS);
  });
  it("10 MB wide object (500k keys; key cap is 200) under 15 s", { timeout: PERF_TIMEOUT }, () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 500_000; i++) wide["k" + i] = "0123456789abcdef";
    expect(time({ run: "p", wide })).toBeLessThan(WIDE_MS);
  });
  it("10 MB Buffer (summarised as [binary N bytes])", { timeout: PERF_TIMEOUT }, () => {
    expect(time({ run: "p", b: Buffer.alloc(MB10) })).toBeLessThan(PERF_MS);
  });
});
