import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAudit } from "../src/risk/audit.js";

let file: string;
const NOW = new Date("2026-01-02T03:04:05.000Z");
const write = (e: object) => appendAudit(file, e, () => NOW);
const lines = () => readFileSync(file, "utf8").split("\n").filter(Boolean);
const last = () => JSON.parse(lines().at(-1)!) as any;
const raw = () => lines().at(-1)!;

beforeEach(() => {
  file = path.join(mkdtempSync(path.join(tmpdir(), "o4-")), "audit.jsonl");
});

describe("O-4 bounds", () => {
  it("normal order entry is byte-identical to the pre-change output", () => {
    write({ run: "r1", action: "place_order", args: { symbol: "RELIANCE", qty: 10, price: 2500.5, tags: ["a", "b"], apiKey: "k", nested: { token: "t", ok: null, f: false } } });
    expect(raw()).toBe(
      '{"run":"r1","action":"place_order","args":{"symbol":"RELIANCE","qty":10,"price":2500.5,"tags":["a","b"],"apiKey":"[REDACTED]","nested":{"token":"[REDACTED]","ok":null,"f":false}},"ts":"2026-01-02T03:04:05.000Z"}',
    );
  });

  for (const [len, cut] of [[1999, false], [2000, false], [2001, true]] as const) {
    it(`string of ${len} chars ${cut ? "is cut" : "is kept"}`, () => {
      write({ s: "x".repeat(len) });
      expect(last().s).toBe(cut ? "x".repeat(2000) + "…[+1 chars]" : "x".repeat(len));
    });
  }

  for (const [n, cut] of [[99, false], [100, false], [101, true]] as const) {
    it(`array of ${n} items ${cut ? "is cut" : "is kept"}`, () => {
      write({ a: Array.from({ length: n }, (_, i) => i) });
      const a = last().a as unknown[];
      if (cut) {
        expect(a).toHaveLength(101);
        expect(a[99]).toBe(99);
        expect(a[100]).toBe("…[+1 items]");
      } else {
        expect(a).toHaveLength(n);
        expect(a.at(-1)).toBe(n - 1);
      }
    });
  }

  it("array marker reports the dropped count", () => {
    write({ a: new Array(250).fill(0) });
    expect(last().a.at(-1)).toBe("…[+150 items]");
  });

  const nest = (d: number) => {
    const e: any = {};
    let cur = e;
    for (let i = 0; i < d; i++) cur = cur.c = {};
    cur.leaf = 1;
    return e;
  };
  const walk = (e: any, d: number) => {
    let cur = e;
    for (let i = 0; i < d; i++) cur = cur.c;
    return cur;
  };
  for (const [d, cut] of [[7, false], [8, false], [9, true]] as const) {
    it(`object at depth ${d} ${cut ? "becomes [depth limit]" : "is kept"}`, () => {
      write(nest(d));
      const v = walk(last(), d);
      if (cut) expect(v).toBe("[depth limit]");
      else expect(v).toEqual({ leaf: 1 });
    });
  }

  it("arrays count toward depth too", () => {
    write({ a: [[[[[[[[[1]]]]]]]]] });
    expect(raw()).toContain("[depth limit]");
  });

  it("cycles give [cycle]; shared (non-cyclic) refs are kept", () => {
    const a: any = { n: 1 };
    a.self = a;
    write({ a });
    expect(last().a).toEqual({ n: 1, self: "[cycle]" });
    const shared = { z: 1 };
    write({ p: shared, q: shared });
    expect(last()).toMatchObject({ p: { z: 1 }, q: { z: 1 } });
  });

  it("key-name redaction applies at every depth", () => {
    write({ a: { b: [{ c: { password: "p", Authorization: "x", "api-key": "k", fine: "ok" } }] } });
    expect(last().a.b[0].c).toEqual({ password: "[REDACTED]", Authorization: "[REDACTED]", "api-key": "[REDACTED]", fine: "ok" });
  });

  // 32 strings of 2000 chars plus a short one; the last is sized so the final line is exactly `target` bytes.
  const sized = (target: number) => {
    const e: any = { run: "r9" };
    for (let i = 0; i < 32; i++) e[`k${i}`] = "x".repeat(2000);
    e.last = "";
    const base = Buffer.byteLength(JSON.stringify({ ...e, ts: NOW.toISOString() }));
    e.last = "y".repeat(target - base);
    return e;
  };
  for (const [target, cut] of [[65535, false], [65536, false], [65537, true]] as const) {
    it(`line of ${target} bytes ${cut ? "is replaced" : "is kept"}`, () => {
      write(sized(target));
      const r = raw();
      if (cut) {
        expect(last()).toEqual({ ts: NOW.toISOString(), run: "r9", truncated: true, bytes: target });
        expect(Buffer.byteLength(r)).toBeLessThan(200);
      } else {
        expect(Buffer.byteLength(r)).toBe(target);
        expect(last().truncated).toBeUndefined();
      }
    });
  }

  it("truncated entry without run omits it", () => {
    const e = sized(66000);
    delete e.run;
    write(e);
    const l = last();
    expect(Object.keys(l)).toEqual(["ts", "truncated", "bytes"]);
    expect(l.bytes).toBe(Buffer.byteLength(JSON.stringify({ ...e, ts: NOW.toISOString() })));
  });

  it("audit.recent parses truncated entries", async () => {
    const { createBindings } = await import("../src/sdk/bindings.js");
    write({ run: "ok", i: 1 });
    write(sized(66000));
    write({ run: "ok", i: 2 });
    const b = createBindings({ client: {} as any, risk: {} as any, cfg: {} as any, auditFile: file }, { id: "r1" }) as any;
    const r = await b.audit.recent({ limit: 10 });
    expect(r.skipped).toBe(0);
    expect(r.entries.some((x: any) => x.truncated === true && x.bytes === 66000)).toBe(true);
  });
});
