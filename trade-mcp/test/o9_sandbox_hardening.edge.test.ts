import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as v8 from "node:v8";
import * as nodeVm from "node:vm";

// O-9 adversarial edge tests. Pass-through wrapper around quickjs-emscripten with test hooks:
// per-name init-delete suppression, survivor-check failure, fake wasm size, and recording of every
// string the host pulls out of the guest (getString / dump) so the host copy size can be asserted.
const hooks = vi.hoisted(() => ({
  skipDelete: new Set<string>(),
  breakSurvivorCheck: false,
  fakeWasm: undefined as { byteLength: number } | undefined,
  maxHostString: 0,
}));

vi.mock("quickjs-emscripten", async (orig) => {
  const actual = await orig<typeof import("quickjs-emscripten")>();
  const wrap = <T extends object>(t: T, over: Record<string, unknown>): T =>
    new Proxy(t, {
      get(target, p) {
        if (typeof p === "string" && p in over) return over[p];
        const v = Reflect.get(target, p, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  const note = (v: unknown) => {
    if (typeof v === "string" && v.length > hooks.maxHostString) hooks.maxHostString = v.length;
    return v;
  };
  return {
    ...actual,
    newQuickJSWASMModule: async () => {
      const mod = await actual.newQuickJSWASMModule();
      return wrap(mod, {
        getWasmMemory: () => (hooks.fakeWasm ? { buffer: hooks.fakeWasm } : mod.getWasmMemory()),
        newRuntime: () => {
          const rt = mod.newRuntime();
          return wrap(rt, {
            newContext: () => {
              const c = rt.newContext();
              return wrap(c, {
                evalCode: (code: string, ...rest: unknown[]) => {
                  const m = /^delete globalThis\["(\w+)"\]/.exec(code);
                  if (m && (hooks.skipDelete.has("*") || hooks.skipDelete.has(m[1]!))) return c.evalCode("undefined");
                  if (hooks.breakSurvivorCheck && code.includes(".filter(") && code.includes("globalThis[g]"))
                    return c.evalCode(`throw new Error("check broke")`);
                  return (c.evalCode as (...a: unknown[]) => unknown)(code, ...rest);
                },
                getString: (h: unknown) => note(c.getString(h as never)),
              });
            },
          });
        },
      });
    },
  };
});

const { runCode } = await import("../src/sandbox/quickjs.js");

const MB = 1024 * 1024;
const ARG_MAX = MB;
const DEFAULT_CAP = 4 * MB;
// Truncated error text may carry a short constant marker past the cap; anything bigger is a bypass.
const MARKER = 64;

v8.setFlagsFromString("--expose-gc");
const gc = nodeVm.runInNewContext("gc") as () => void;

const reset = () => {
  hooks.skipDelete.clear();
  hooks.breakSurvivorCheck = false;
  hooks.fakeWasm = undefined;
  hooks.maxHostString = 0;
};

// Records every host-side JSON string (JSON.parse inputs, JSON.stringify outputs, getString results) and
// the peak heapUsed seen right after each, so a huge host copy is caught even if GC runs before the end.
async function watchHost<T>(fn: () => Promise<T>) {
  const realParse = JSON.parse;
  const realStringify = JSON.stringify;
  gc();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  const sample = () => {
    const h = process.memoryUsage().heapUsed;
    if (h > peak) peak = h;
  };
  const parse = vi.spyOn(JSON, "parse").mockImplementation(((s: string, r?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof s === "string" && s.length > hooks.maxHostString) hooks.maxHostString = s.length;
    const out = realParse(s, r);
    sample();
    return out;
  }) as typeof JSON.parse);
  const stringify = vi.spyOn(JSON, "stringify").mockImplementation(((v: unknown, r?: never, sp?: never) => {
    const out = realStringify(v, r, sp);
    if (typeof out === "string" && out.length > hooks.maxHostString) hooks.maxHostString = out.length;
    sample();
    return out;
  }) as typeof JSON.stringify);
  try {
    const result = await fn();
    sample();
    return { result, maxHostString: hooks.maxHostString, peakHeapDelta: peak - base };
  } finally {
    parse.mockRestore();
    stringify.mockRestore();
  }
}

// Host binding that records exactly what the host received.
const recorder = () => {
  const got: unknown[] = [];
  return { got, bindings: { t: { f: async (a: unknown) => (got.push(a), "ok") } } };
};

beforeEach(reset);
afterEach(reset);

describe("O-9 edge: in-guest argument sizing (TOCTOU, single snapshot)", () => {
  // Shape of every TOCTOU case: the guest records what it measured first, the host must receive exactly
  // that (or nothing), never a host string over ~1 MB, and the run must complete (host alive).
  const expectNoBigHostCopy = (w: { maxHostString: number; peakHeapDelta: number }) => {
    expect(w.maxHostString).toBeLessThanOrEqual(ARG_MAX + 16);
    expect(w.peakHeapDelta).toBeLessThan(12 * MB);
  };

  it("counter-based toJSON: small at measure, 16 MB at dump; serialized once, host copy equals the snapshot", async () => {
    const { got, bindings } = recorder();
    const w = await watchHost(() =>
      runCode(
        `let n = 0; const o = { toJSON() { n++; return n === 1 ? "small" : "x".repeat(16*1024*1024); } };
         let m; try { m = await t.f(o); } catch (e) { m = e.message; } return [m, n];`,
        bindings,
        { memoryBytes: 64 * MB },
      ),
    );
    expect(w.result.ok).toBe(true);
    const [m, n] = w.result.result as [string, number];
    expect(n).toBe(1); // stringified exactly once
    expect(m).toBe("ok");
    expect(got).toEqual(["small"]);
    expectNoBigHostCopy(w);
  }, 60_000);

  it("getter that grows on the second read: host copy equals the first read", async () => {
    const { got, bindings } = recorder();
    const w = await watchHost(() =>
      runCode(
        `let n = 0; const o = { get v() { n++; return n === 1 ? "small" : "x".repeat(16*1024*1024); } };
         let m; try { m = await t.f(o); } catch (e) { m = e.message; } return [m, n];`,
        bindings,
        { memoryBytes: 64 * MB },
      ),
    );
    const [m, n] = w.result.result as [string, number];
    expect(n).toBe(1);
    expect(m).toBe("ok");
    expect(got).toEqual([{ v: "small" }]);
    expectNoBigHostCopy(w);
  }, 60_000);

  it("Proxy whose ownKeys grows after the first enumeration: host copy equals the first snapshot", async () => {
    const { got, bindings } = recorder();
    const w = await watchHost(() =>
      runCode(
        `let n = 0;
         const p = new Proxy({}, {
           ownKeys() { n++; return n === 1 ? ["a"] : Array.from({ length: 200000 }, (_, i) => "k" + i); },
           getOwnPropertyDescriptor() { return { value: "v", enumerable: true, configurable: true }; },
           get() { return "v".repeat(64); },
         });
         let m; try { m = await t.f(p); } catch (e) { m = e.message; } return [m, n];`,
        bindings,
        { memoryBytes: 64 * MB },
      ),
    );
    const [m, n] = w.result.result as [string, number];
    expect(n).toBe(1);
    expect(m).toBe("ok");
    expect(got).toEqual([{ a: "v".repeat(64) }]);
    expectNoBigHostCopy(w);
  }, 60_000);

  it("Proxy whose get grows on the second read: host copy equals the first snapshot", async () => {
    const { got, bindings } = recorder();
    const w = await watchHost(() =>
      runCode(
        `let n = 0;
         const p = new Proxy({ a: 1 }, { get(t, k) { if (k !== "a") return undefined; n++; return n === 1 ? 1 : "x".repeat(16*1024*1024); } });
         let m; try { m = await t.f(p); } catch (e) { m = e.message; } return [m, n];`,
        bindings,
        { memoryBytes: 64 * MB },
      ),
    );
    const [m, n] = w.result.result as [string, number];
    expect(n).toBe(1);
    expect(m).toBe("ok");
    expect(got).toEqual([{ a: 1 }]);
    expectNoBigHostCopy(w);
  }, 60_000);

  it("array with a huge length and one element is rejected without a host copy", async () => {
    const { got, bindings } = recorder();
    const w = await watchHost(() =>
      runCode(
        `const a = []; a.length = 1e7; a[0] = 1;
         try { await t.f(a); return "no"; } catch (e) { return e.message; }`,
        bindings,
        { memoryBytes: 64 * MB, timeoutMs: 20_000 },
      ),
    );
    // Fail closed either way: a guest-side rejection, or the whole run stopped by the memory limit.
    if (w.result.ok) expect(w.result.result).toBe("binding argument too large");
    else expect(w.result.error).toBe("memory limit exceeded");
    expect(got).toEqual([]);
    expectNoBigHostCopy(w);
  }, 60_000);

  it("cyclic object (deep and via array) is rejected, host not called", async () => {
    const { got, bindings } = recorder();
    const r = await runCode(
      `const a = { x: [ { } ] }; a.x[0].back = a;
       try { await t.f(a); return "no"; } catch (e) { return e.message; }`,
      bindings,
    );
    expect(r.result).toMatch(/^binding argument (too large|not serialisable)$/);
    expect(got).toEqual([]);
  });

  it("toJSON that throws is rejected cleanly, host not called", async () => {
    const { got, bindings } = recorder();
    const r = await runCode(
      `try { await t.f({ toJSON() { throw new Error("nope"); } }); return "no"; } catch (e) { return e.message; }`,
      bindings,
    );
    expect(r.ok).toBe(true);
    expect(typeof r.result).toBe("string");
    expect(r.result).not.toBe("no");
    expect(got).toEqual([]);
  });

  it("Symbol keys are dropped (JSON semantics) and their huge values never reach the host", async () => {
    const { got, bindings } = recorder();
    const w = await watchHost(() =>
      runCode(
        `const o = { a: 1, [Symbol("s")]: "x".repeat(8*1024*1024) }; return await t.f(o);`,
        bindings,
        { memoryBytes: 64 * MB },
      ),
    );
    expect(w.result).toMatchObject({ ok: true, result: "ok" });
    expect(got).toEqual([{ a: 1 }]);
    expectNoBigHostCopy(w);
  }, 60_000);

  // JSON of a string of k surrogate pairs is 2k+2 UTF-16 units; the limit is 1 MB.
  const pairs = (units: number) => `"\\u{1F600}".repeat(${(units - 2) / 2})`;

  it("surrogate pairs: JSON exactly at the limit either passes intact or rejects; never a corrupt pair", async () => {
    const { got, bindings } = recorder();
    const r = await runCode(
      `const s = ${pairs(ARG_MAX)}; try { const m = await t.f(s); return [m, s.length]; } catch (e) { return [e.message, s.length]; }`,
      bindings,
      { memoryBytes: 64 * MB },
    );
    const [m] = r.result as [string, number];
    if (m === "ok") {
      expect(got).toHaveLength(1);
      const s = got[0] as string;
      expect(s.length).toBe(ARG_MAX - 2);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)).toBe(false);
    } else {
      expect(m).toBe("binding argument too large");
      expect(got).toEqual([]);
    }
  }, 60_000);

  it("surrogate pair straddling the limit (one unit over) is rejected", async () => {
    const { got, bindings } = recorder();
    // "a" * (MAX-3) + one pair + quotes = MAX+1 units: the pair's low half is the unit over the limit.
    const r = await runCode(
      `const s = "a".repeat(${ARG_MAX - 3}) + "\\u{1F600}"; try { await t.f(s); return "no"; } catch (e) { return e.message; }`,
      bindings,
      { memoryBytes: 64 * MB },
    );
    expect(r.result).toBe("binding argument too large");
    expect(got).toEqual([]);
  }, 60_000);

  it("ASCII boundary: JSON of exactly 1 MB passes intact, 1 MB + 1 is rejected", async () => {
    const { got, bindings } = recorder();
    const r = await runCode(
      `const at = "a".repeat(${ARG_MAX - 2}), over = at + "b";
       const r1 = await t.f(at); let r2; try { await t.f(over); r2 = "no"; } catch (e) { r2 = e.message; }
       return [r1, r2];`,
      bindings,
      { memoryBytes: 64 * MB },
    );
    expect(r.result).toEqual(["ok", "binding argument too large"]);
    expect(got).toHaveLength(1);
    expect((got[0] as string).length).toBe(ARG_MAX - 2);
  }, 60_000);

  it("replacing JSON.stringify in user code cannot spoof the guest measurement", async () => {
    const { got, bindings } = recorder();
    const w = await watchHost(() =>
      runCode(
        `JSON.stringify = () => "1"; Object.defineProperty(String.prototype, "length", { get() { return 1; } });
         try { await t.f("x".repeat(8*1024*1024)); return "no"; } catch (e) { return e.message; }`,
        bindings,
        { memoryBytes: 64 * MB },
      ),
    );
    expect(got).toEqual([]);
    expect(w.result.result).not.toBe("no");
    expectNoBigHostCopy(w);
  }, 60_000);

  it("empty and null-ish arguments round-trip", async () => {
    const { got, bindings } = recorder();
    const r = await runCode(`await t.f(""); await t.f(null); await t.f({}); await t.f([]); await t.f(0); return 1;`, bindings);
    expect(r).toMatchObject({ ok: true, result: 1 });
    expect(got).toEqual(["", null, {}, [], 0]);
  });
});

describe("O-9 edge: binding result cap = min(4 MB, memoryBytes/4)", () => {
  const callF = `try { const v = await t.f(); return ["ok", typeof v === "string" ? v.length : JSON.stringify(v).length]; } catch (e) { return ["err", e.message]; }`;
  // A string result of n units has JSON length n + 2.
  const strOfJson = (ch: string, jsonLen: number) => ch.repeat((jsonLen - 2) / ch.length);

  it.each([
    ["ASCII", "a"],
    ["3-byte BMP", "€"],
    ["surrogate pairs", "\u{1F600}"],
  ])("default cap: %s just below and at the cap pass, one unit above rejects", async (_n, ch) => {
    const below = strOfJson(ch, DEFAULT_CAP - ch.length);
    const at = strOfJson(ch, DEFAULT_CAP);
    for (const [v, ok] of [
      [below, true],
      [at, true],
      [at + "a", false],
    ] as const) {
      const r = await runCode(callF, { t: { f: async () => v } }, { memoryBytes: 64 * MB });
      expect(r.ok).toBe(true);
      const [tag, detail] = r.result as [string, unknown];
      if (ok) expect([tag, detail]).toEqual(["ok", v.length]);
      else {
        expect(tag).toBe("err");
        expect(detail).toMatch(/^binding result too large/);
      }
    }
  }, 120_000);

  it("memoryBytes/4 cap (4 MB memory -> 1 MB): at passes, one over rejects", async () => {
    const cap = MB;
    for (const [len, ok] of [
      [cap, true],
      [cap + 1, false],
    ] as const) {
      const v = "a".repeat(len - 2);
      const r = await runCode(callF, { t: { f: async () => v } }, { memoryBytes: 4 * MB });
      expect(r.ok).toBe(true);
      expect((r.result as unknown[])[0]).toBe(ok ? "ok" : "err");
    }
  }, 60_000);

  it("non-multiple-of-4 memoryBytes floors the cap", async () => {
    const mem = 4 * MB + 3; // cap = floor(mem/4) = 1 MB
    const r = await runCode(callF, { t: { f: async () => "a".repeat(MB - 1) } }, { memoryBytes: mem });
    expect((r.result as unknown[])[0]).toBe("err");
  }, 60_000);

  it("a rejected result leaks none of its data into the error", async () => {
    const secret = "TOPSECRET-4f2a";
    const r = await runCode(
      callF,
      { t: { f: async () => ({ token: secret, pad: secret.repeat(400_000) }) } },
      { memoryBytes: 64 * MB },
    );
    const [tag, msg] = r.result as [string, string];
    expect(tag).toBe("err");
    expect(msg).toMatch(/^binding result too large/);
    expect(msg).not.toContain("TOPSECRET");
    expect(JSON.stringify(r)).not.toContain("TOPSECRET");
  }, 60_000);

  it("a binding that throws a huge error message cannot push it past the cap into the guest", async () => {
    const r = await runCode(
      `try { await t.f(); return ["no"]; } catch (e) { return ["err", String(e.message).length]; }`,
      { t: { f: async () => { throw new Error("E".repeat(8 * MB)); } } },
      { memoryBytes: 64 * MB, timeoutMs: 20_000 },
    );
    expect(r.ok).toBe(true);
    const [tag, len] = r.result as [string, number];
    expect(tag).toBe("err");
    expect(len).toBeLessThanOrEqual(DEFAULT_CAP + MARKER);
  }, 60_000);

  it("a huge thrown error under small memory: host survives, run settles, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = await runCode(
        `try { await t.f(); return "no"; } catch (e) { return String(e.message).length; }`,
        { t: { f: async () => { throw new Error("E".repeat(6 * MB)); } } },
        { memoryBytes: 2 * MB, timeoutMs: 5_000 },
      );
      await new Promise((res) => setTimeout(res, 50));
      expect(unhandled).toEqual([]);
      // Either the guest sees a capped message, or the run fails with a memory error; never a timeout.
      if (r.ok) expect(r.result as number).toBeLessThanOrEqual(MB / 2 + MARKER);
      else expect(r.error).toBe("memory limit exceeded");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 60_000);

  it("a binding that rejects with a non-Error carrying huge data is capped too", async () => {
    const r = await runCode(
      `try { await t.f(); return ["no"]; } catch (e) { return ["err", String(e && e.message !== undefined ? e.message : e).length]; }`,
      { t: { f: async () => Promise.reject("R".repeat(8 * MB)) } },
      { memoryBytes: 64 * MB, timeoutMs: 20_000 },
    );
    expect(r.ok).toBe(true);
    const [tag, len] = r.result as [string, number];
    expect(tag).toBe("err");
    expect(len).toBeLessThanOrEqual(DEFAULT_CAP + MARKER);
  }, 60_000);

  it("a binding error whose message getter throws does not crash the host or hang the run", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const evil = {
        get message(): string {
          throw new Error("getter boom");
        },
      };
      const r = await runCode(
        `try { await t.f(); return "no"; } catch (e) { return "caught"; }`,
        { t: { f: async () => Promise.reject(evil) } },
        { timeoutMs: 3_000 },
      );
      await new Promise((res) => setTimeout(res, 50));
      expect(unhandled).toEqual([]);
      expect(r.error ?? "").not.toMatch(/^timeout/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 30_000);

  it("empty results (undefined, null, empty string/array) pass", async () => {
    const vals = [undefined, null, "", []];
    let i = 0;
    const r = await runCode(
      `const out = []; for (let k = 0; k < 4; k++) out.push(await t.f()); return out.map((v) => v === undefined ? "u" : v);`,
      { t: { f: async () => vals[i++] } },
    );
    expect(r).toMatchObject({ ok: true, result: ["u", null, "", []] });
  });
});

describe("O-9 edge: fail-closed init", () => {
  // Globals every QuickJS build defines (Atomics/WebAssembly/Float16Array depend on the build, so a skipped
  // delete there may leave nothing behind).
  it.each(["ArrayBuffer", "Uint8Array", "DataView", "Float64Array"])(
    "a single surviving global (%s) fails the run with sandbox init failed; user code and bindings never run",
    async (name) => {
      hooks.skipDelete.add(name);
      let called = 0;
      const r = await runCode(`console.log("ran"); await t.f(); return 1;`, { t: { f: async () => (called++, 1) } });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("sandbox init failed");
      expect(r.logs).toEqual([]);
      expect(called).toBe(0);
    },
  );

  it("all deletes suppressed: fails closed, no logs", async () => {
    hooks.skipDelete.add("*");
    const r = await runCode(`console.log("ran"); return 1;`, {});
    expect(r).toMatchObject({ ok: false, error: "sandbox init failed", logs: [] });
  });

  it("if the survivor check itself errors, the run still fails and user code never runs", async () => {
    hooks.breakSurvivorCheck = true;
    const r = await runCode(`console.log("ran"); return 1;`, {});
    expect(r.ok).toBe(false);
    expect(r.logs).toEqual([]);
  });

  it("after a fail-closed run, the next normal run is unaffected", async () => {
    hooks.skipDelete.add("DataView");
    await runCode(`return 1;`, {});
    reset();
    const r = await runCode(`return [typeof Atomics, typeof Uint8Array, 1];`, {});
    expect(r).toMatchObject({ ok: true, result: ["undefined", "undefined", 1] });
  });
});

describe("O-9 edge: heap ceiling checked when a binding settles", () => {
  it("binding resolves after memory grew: run ends with a memory error, guest does not resume", async () => {
    hooks.fakeWasm = { byteLength: MB };
    const fake = hooks.fakeWasm;
    const r = await runCode(
      `await t.grow(); console.log("resumed"); return "finished";`,
      { t: { grow: async () => ((fake.byteLength = 200 * MB), 1) } },
      { memoryBytes: 8 * MB },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("memory limit exceeded");
    expect(r.logs).toEqual([]);
  });

  it("binding rejects after memory grew: memory error, guest catch block does not run", async () => {
    hooks.fakeWasm = { byteLength: MB };
    const fake = hooks.fakeWasm;
    const r = await runCode(
      `try { await t.grow(); } catch (e) { console.log("caught"); } return "finished";`,
      {
        t: {
          grow: async () => {
            fake.byteLength = 200 * MB;
            throw new Error("x");
          },
        },
      },
      { memoryBytes: 8 * MB },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("memory limit exceeded");
    expect(r.logs).toEqual([]);
  });

  it("boundary: exactly at the ceiling is fine, one byte over fails", async () => {
    const mem = 8 * MB;
    const ceiling = mem + 16 * MB;
    for (const [size, ok] of [
      [ceiling, true],
      [ceiling + 1, false],
    ] as const) {
      hooks.fakeWasm = { byteLength: MB };
      const fake = hooks.fakeWasm;
      const r = await runCode(`await t.grow(); return 1;`, { t: { grow: async () => ((fake.byteLength = size), 1) } }, {
        memoryBytes: mem,
      });
      expect(r.ok).toBe(ok);
      if (!ok) expect(r.error).toBe("memory limit exceeded");
    }
  });

  it("real guest growth while parked on a slow binding: host survives with a memory error", async () => {
    const r = await runCode(
      `const p = t.slow(); const a = []; try { while (true) a.push("x".repeat(1e5)); } catch (e) {} await p; return a.length;`,
      { t: { slow: () => new Promise((res) => setTimeout(() => res(1), 100)) } },
      { memoryBytes: 8 * MB, timeoutMs: 10_000 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("memory limit exceeded");
    // Host still alive and usable.
    expect(await runCode(`return 2;`, {})).toMatchObject({ ok: true, result: 2 });
  }, 30_000);
});

describe("O-9 edge: normal workloads still pass", () => {
  const bars = Array.from({ length: 252 }, (_, i) => ({
    timestamp: 1704067200 + i * 86400,
    open: 21731.4 + i * 1.37,
    high: 21834.35 + i * 1.41,
    low: 21658.9 + i * 1.29,
    close: 21780.25 + i * 1.33,
    volume: 245678123 + i * 137,
    oi: 0,
  }));

  it("a year of daily bars (~27 KB) via market.history passes with the default and a small memory", async () => {
    const size = JSON.stringify(bars).length;
    expect(size).toBeGreaterThan(20 * 1024);
    expect(size).toBeLessThan(40 * 1024);
    for (const memoryBytes of [64 * MB, 2 * MB]) {
      const r = await runCode(
        `const b = await market.history({ symbol: "NIFTY", exchange: "NSE", interval: "D", start_date: "2024-01-01", end_date: "2024-12-31" });
         return [b.length, b[251].close];`,
        { market: { history: async () => bars } },
        { memoryBytes },
      );
      expect(r).toMatchObject({ ok: true, result: [252, bars[251]!.close] });
    }
  });

  it("a backtest result object round-trips intact", async () => {
    const result = {
      ok: true,
      metrics: { total_return: 0.1834, sharpe: 1.42, max_drawdown: -0.0921, calmar: 1.99, win_rate: 0.56 },
      equity: bars.map((b, i) => ({ date: new Date(b.timestamp * 1000).toISOString().slice(0, 10), value: i === 0 ? null : 100000 + i * 73.5 })),
      trades: Array.from({ length: 60 }, (_, i) => ({
        symbol: "RELIANCE",
        side: i % 2 ? "SELL" : "BUY",
        qty: 10,
        entry: 2900.5 + i,
        exit: 2912.25 + i,
        pnl: 117.5,
        entry_time: "2024-03-01T09:15:00+05:30",
        exit_time: "2024-03-04T15:29:00+05:30",
      })),
      tradeCount: 60,
      warnings: ["costs approximated"],
      error: null,
    };
    const r = await runCode(
      `return await backtest.run({ code: "def strategy(): pass", symbols: ["RELIANCE"], start: "2024-01-01", end: "2024-12-31" });`,
      { backtest: { run: async () => result } },
    );
    expect(r).toMatchObject({ ok: true, result });
  });
});
