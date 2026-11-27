import { describe, expect, it, vi } from "vitest";
import * as v8 from "node:v8";
import * as nodeVm from "node:vm";
import { runCode } from "../src/sandbox/quickjs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const echo = async (a: unknown) => a;

describe("sandbox escapes", () => {
  it("constructor.constructor('return this') stays inside guest", async () => {
    const r = await runCode(
      `const g = ({}).constructor.constructor('return this')(); return [typeof g.process, typeof g.require, typeof g.fetch, typeof g.Buffer];`,
      {},
    );
    expect(r).toMatchObject({ ok: true, result: ["undefined", "undefined", "undefined", "undefined"] });
  });

  it("Function / eval give guest globalThis only", async () => {
    const r = await runCode(
      `const a = Function('return globalThis')(); const b = eval('globalThis'); return [a===globalThis, b===globalThis, typeof a.process, eval('typeof require')];`,
      {},
    );
    expect(r.result).toEqual([true, true, "undefined", "undefined"]);
  });

  it("import('fs') fails", async () => {
    const r = await runCode(`const fs = await import('fs'); return typeof fs.readFileSync;`, {});
    expect(r.ok).toBe(false);
  });

  it("require / process / setTimeout / fetch are unavailable", async () => {
    for (const k of ["require('fs')", "process.exit(1)", "setTimeout(()=>{},1)", "fetch('http://x')"]) {
      const r = await runCode(`${k}; return 1;`, {});
      expect(r.ok, k).toBe(false);
    }
  });

  it("globalThis keys are std JS + console + bindings only", async () => {
    const r = await runCode(`return Object.getOwnPropertyNames(globalThis);`, { market: { quote: echo } });
    const keys = r.result as string[];
    const std = new Set([
      "Object", "Function", "Array", "Number", "parseFloat", "parseInt", "isNaN", "isFinite", "decodeURI", "decodeURIComponent",
      "encodeURI", "encodeURIComponent", "escape", "unescape", "Infinity", "NaN", "undefined", "Error", "EvalError", "RangeError",
      "ReferenceError", "SyntaxError", "TypeError", "URIError", "InternalError", "AggregateError", "globalThis", "eval", "Math",
      "JSON", "Reflect", "Symbol", "String", "Boolean", "BigInt", "Date", "RegExp", "Proxy", "Map", "Set", "WeakMap", "WeakSet",
      "WeakRef", "FinalizationRegistry", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Promise", "Atomics", "Iterator",
      "Uint8ClampedArray", "Int8Array", "Uint8Array", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array",
      "BigUint64Array", "Float16Array", "Float32Array", "Float64Array", "console", "market",
    ]);
    expect(keys.filter((k) => !std.has(k))).toEqual([]);
    expect(keys).toContain("market");
  });

  it("Proxy/Symbol/prototype tricks on binding objects find no host object", async () => {
    const r = await runCode(
      `const f = market.quote;
       const out = [];
       out.push(f.constructor('return typeof process')());
       out.push(Object.getOwnPropertySymbols(market).length);
       out.push(Object.getPrototypeOf(f) === Function.prototype);
       const pm = new Proxy(market, { get(t,k){ return t[k]; } });
       out.push(typeof (await pm.quote({a:1})).a);
       return out;`,
      { market: { quote: echo } },
    );
    expect(r).toMatchObject({ ok: true, result: ["undefined", 0, true, "number"] });
  });

  it("guest Proxy as arg: host receives plain data", async () => {
    const seen: unknown[] = [];
    const r = await runCode(
      `const p = new Proxy({a:1}, { get(t,k){ return k==='a' ? 2 : t[k]; } }); await m.f(p); return 1;`,
      { m: { f: async (a) => { seen.push(a); return null; } } },
    );
    expect(r.ok).toBe(true);
    expect(seen.length).toBe(1);
    if (seen[0] && typeof seen[0] === "object") expect(Object.getPrototypeOf(seen[0])).toBe(Object.prototype);
  });

  it("prototype pollution in run 1 invisible in run 2 and on host", async () => {
    const r1 = await runCode(`Object.prototype.polluted = 'yes'; Array.prototype.evil = 1; JSON.parse = () => 'hacked'; JSON.stringify = () => '"hacked"'; return ({}).polluted;`, {});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).evil).toBeUndefined();
    void r1;
    const r2 = await runCode(`return [typeof ({}).polluted, typeof [].evil, JSON.parse('1')];`, {});
    expect(r2.result).toEqual(["undefined", "undefined", 1]);
  });

  it("guest overriding JSON before return cannot crash host", async () => {
    const r = await runCode(`JSON.stringify = () => { throw new Error('nope'); }; return 1;`, {});
    expect(typeof r.ok).toBe("boolean");
  });

  it("__proto__ in binding results does not pollute host or reach host", async () => {
    const r = await runCode(`const v = await m.f({}); return v.constructor.constructor('return typeof process')();`, {
      m: { f: async () => JSON.parse('{"__proto__":{"x":1}}') },
    });
    expect(r.result).toBe("undefined");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("code trying to close the wrapper does not run outside", async () => {
    const host = vi.fn(async () => "pwned");
    const invalid = [`}); m.f(); (async()=>{`, `})()); m.f(); ((async()=>{`];
    const validLiteral = ["`); m.f(); (`", `"); m.f(); ("`];
    for (const code of [...invalid, ...validLiteral]) {
      const r = await runCode(code, { m: { f: host } });
      expect(host, code).not.toHaveBeenCalled();
      if (invalid.includes(code)) expect(r.ok, code).toBe(false);
    }
  });
});

describe("sandbox bindings", () => {
  it("20 concurrent calls keep result order despite varying latency", async () => {
    const r = await runCode(
      `return await Promise.all(Array.from({length:20},(_, i) => m.f({i})));`,
      { m: { f: async (a) => { const i = (a as { i: number }).i; await sleep((20 - i) * 2); return i * 10; } } },
    );
    expect(r.result).toEqual(Array.from({ length: 20 }, (_, i) => i * 10));
  });

  it("binding throwing synchronously becomes guest exception (no host stack)", async () => {
    const r = await runCode(`try { await m.f({}); return 'no'; } catch(e) { return [e.message, String(e.stack||'').includes('.ts')]; }`, {
      m: { f: (() => { throw new Error("sync boom"); }) as unknown as (a: unknown) => Promise<unknown> },
    });
    expect(r.result).toEqual(["sync boom", false]);
  });

  it("binding rejecting with non-Error is a message", async () => {
    const r = await runCode(`try { await m.f({}); } catch(e) { return e.message; }`, { m: { f: () => Promise.reject("str") } });
    expect(r.result).toBe("str");
  });

  it("uncaught binding rejection -> ok:false with message, no host stack", async () => {
    const r = await runCode(`await m.f({}); return 1;`, { m: { f: async () => { throw new Error("denied"); } } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied");
    expect(r.error).not.toMatch(/\.ts:\d+/);
  });

  it("binding returns undefined/null", async () => {
    const r = await runCode(`return [typeof (await a.u()), await a.n()];`, { a: { u: async () => undefined, n: async () => null } });
    expect(r.result).toEqual(["undefined", null]);
  });

  it("binding returns huge object", async () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ({ i, s: "abc" }));
    const r = await runCode(`const v = await a.f(); return v.length + v[49999].i;`, { a: { f: async () => big } });
    expect(r.result).toBe(50_000 + 49_999);
  });

  it("binding returns BigInt / circular -> guest exception, no crash", async () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const r = await runCode(
      `const out=[]; for (const k of ['big','circ']) { try { await a[k](); out.push('ok'); } catch(e) { out.push('err'); } } return out;`,
      { a: { big: async () => 10n, circ: async () => circ } },
    );
    expect(r).toMatchObject({ ok: true, result: ["err", "err"] });
  });

  it("binding returning a function is not exposed as a function", async () => {
    const r = await runCode(`const v = await a.f(); return typeof v;`, { a: { f: async () => () => 1 } });
    expect(r.ok).toBe(true);
    expect(r.result).not.toBe("function");
  });

  it("circular arg from guest does not crash host", async () => {
    const r = await runCode(`const o={}; o.o=o; try { await m.f(o); return 'sent'; } catch(e) { return 'err'; }`, {
      m: { f: async () => 1 },
    });
    expect(r.ok).toBe(true);
    expect(["sent", "err"]).toContain(r.result);
  });

  it("guest arg with function / BigInt does not hand live handles to host", async () => {
    const seen: unknown[] = [];
    const r = await runCode(`try { await m.f({fn: () => 1, n: 1n}); } catch(e) {} return 1;`, {
      m: { f: async (a) => { seen.push(a); return 1; } },
    });
    expect(r.ok).toBe(true);
    for (const s of seen) expect(typeof (s as { fn?: unknown } | undefined)?.fn).not.toBe("function");
  });
});

describe("sandbox results", () => {
  it.each([
    ["function", `return () => 1;`],
    ["BigInt", `return 10n;`],
    ["circular", `const o={}; o.o=o; return o;`],
  ])("non-serialisable result (%s) handled without crash", async (_n, code) => {
    const r = await runCode(code, {});
    if (r.ok) expect(typeof r.result).not.toBe("function");
    else expect(typeof r.error).toBe("string");
  });

  it("BigInt / circular results are ok:false", async () => {
    expect((await runCode(`return 10n;`, {})).ok).toBe(false);
    expect((await runCode(`const o={}; o.o=o; return o;`, {})).ok).toBe(false);
  });

  it("syntax error and throw -> ok:false", async () => {
    expect(await runCode(`return (;`, {})).toMatchObject({ ok: false });
    const t = await runCode(`throw new Error("x1")`, {});
    expect(t.ok).toBe(false);
    expect(t.error).toContain("x1");
  });

  it("throwing non-Error value -> ok:false", async () => {
    const r = await runCode(`throw {weird: true}`, {});
    expect(r.ok).toBe(false);
  });

  it("empty code -> ok, undefined result", async () => {
    const r = await runCode(``, {});
    expect(r).toMatchObject({ ok: true, logs: [] });
    expect(r.result).toBeUndefined();
  });
});

describe("sandbox logs", () => {
  it("exact maxLogBytes boundary: fits at N, truncates at N+1", async () => {
    const at = await runCode(`console.log("a".repeat(10));`, {}, { maxLogBytes: 10 });
    expect(at.truncated).toBeUndefined();
    expect(at.logs).toEqual(["a".repeat(10)]);
    const over = await runCode(`console.log("a".repeat(11));`, {}, { maxLogBytes: 10 });
    expect(over.truncated).toBe(true);
    expect(over.logs.join("").length).toBeLessThanOrEqual(10);
  });

  it("unicode logs preserved and counted in bytes", async () => {
    const r = await runCode(`console.log("héllo ✓ 😀 日本");`, {});
    expect(r.logs).toEqual(["héllo ✓ 😀 日本"]);
    const t = await runCode(`console.log("😀😀");`, {}, { maxLogBytes: 7 });
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.logs.join(""))).toBeLessThanOrEqual(7);
  });

  it("logs preserved on failure", async () => {
    const r = await runCode(`console.log("before"); throw new Error("x");`, {});
    expect(r.ok).toBe(false);
    expect(r.logs).toEqual(["before"]);
  });

  it("logging non-JSON values does not crash", async () => {
    const r = await runCode(`const o={}; o.o=o; console.log(o, 1n, () => 1, Symbol('s'), undefined); return 1;`, {});
    expect(r.ok).toBe(true);
  });
});

describe("sandbox limits", () => {
  it("infinite loop -> timeout", async () => {
    const r = await runCode(`while(true){}`, {}, { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });

  it("never-resolving await -> timeout", async () => {
    const r = await runCode(`await new Promise(()=>{}); return 1;`, {}, { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });

  it("timeoutMs = 1 does not hang or crash", async () => {
    const r = await runCode(`while(true){}`, {}, { timeoutMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });

  it("host call pending at timeout; late host resolve/reject does not crash", async () => {
    const onErr = vi.fn();
    process.on("unhandledRejection", onErr);
    try {
      const r = await runCode(
        `const a = m.ok(); const b = m.bad(); await Promise.all([a,b]); return 1;`,
        { m: { ok: async () => { await sleep(300); return { x: 1 }; }, bad: async () => { await sleep(300); throw new Error("late"); } } },
        { timeoutMs: 100 },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/timeout/);
      await sleep(400);
      expect(onErr).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onErr);
    }
  });

  it("bindings chained after run ended never reach host", async () => {
    const trade = vi.fn(async () => "filled");
    const r = await runCode(`m.slow().then(() => t.buy({qty: 1000})); return 'done';`, {
      m: { slow: async () => { await sleep(100); return 1; } },
      t: { buy: trade },
    });
    expect(r.result).toBe("done");
    await sleep(250);
    expect(trade).not.toHaveBeenCalled();
  });

  it("memory cap -> ok:false, stopped by cap, host survives", async () => {
    const r = await runCode(`const a=[]; for(let i=0;;i++) a.push({ i, s: [i, i, i, i] });`, {}, { memoryBytes: 8 * 1024 * 1024, timeoutMs: 30_000 });
    // GC-heap allocator (O-8 removed ArrayBuffer/typed arrays from the guest, so the GC heap and
    // strings are the only allocation routes left; both are counted by the cap).
    // The memory cap must stop the run (positive match on the QuickJS OOM error), not the
    // deadline, a syntax/reference error or a stack overflow; no WASM abort text leaks and the
    // host still works. timeoutMs is generous so the cap always fires before the deadline.
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error).toMatch(/memory|InternalError/i);
    expect(r.error).not.toMatch(/timeout|syntax|ReferenceError|stack|Aborted|RuntimeError|Assertion/i);
    expect(r.result).toBeUndefined();
    const next = await runCode(`return 1 + 1;`, {});
    expect(next).toMatchObject({ ok: true, result: 2 });
  }, 45_000);

  it("tiny memoryBytes fails gracefully before QuickJS starts", async () => {
    const r = await runCode(`return 1;`, {}, { memoryBytes: 1024 });
    expect(r.ok).toBe(false);
    // Host-generated message (pre-QuickJS guard), so the text is stable.
    expect(r.error).toMatch(/memory limit too small/i);
    const next = await runCode(`return 1;`, {});
    expect(next).toMatchObject({ ok: true, result: 1 });
  });

  const MEM_OK = /memory|InternalError/i;
  const MEM_NOT = /timeout|syntax|ReferenceError|stack/i;
  const capPair = async (code: string, expected: unknown) => {
    const big = await runCode(code, {}, { memoryBytes: 64 * 1024 * 1024, timeoutMs: 30_000 });
    expect(big).toMatchObject({ ok: true, result: expected });
    const small = await runCode(code, {}, { memoryBytes: 4 * 1024 * 1024, timeoutMs: 30_000 });
    expect(small.ok).toBe(false);
    expect(small.result).toBeUndefined();
    expect(small.error).toMatch(MEM_OK);
    expect(small.error).not.toMatch(MEM_NOT);
  };

  it("control pair (GC objects): same finite allocation passes at 64 MB, fails on memory at 4 MB", async () => {
    // 200k small retained objects (~10 MB of GC heap): only the cap differs between the two runs.
    await capPair(`const a=[]; for(let i=0;i<200000;i++) a.push({ i, s: [i, i, i, i] }); return a.length;`, 200000);
  }, 70_000);

  // Was the Uint8Array REPORT pair (typed-array backing stores escaped the cap). O-8 removed
  // ArrayBuffer/typed arrays from the guest, so the pair now uses ~16 MB of retained strings +
  // objects: 16 x (1 MB string + small object) passes at 64 MB, fails on memory at 4 MB.
  it("control pair (objects/strings, was Uint8Array): ~16 MB retained passes at 64 MB, fails on memory at 4 MB", async () => {
    await capPair(
      `const a=[]; for(let i=0;i<16;i++) a.push({ i, s: String(i).padEnd(1 << 20, "x") }); return [a.length, a[15].s.length, typeof Uint8Array];`,
      [16, 1 << 20, "undefined"],
    );
    const t = await runCode(`return typeof Uint8Array === "undefined";`, {});
    expect(t).toMatchObject({ ok: true, result: true });
  }, 70_000);

  it("memory cap stops allocation, does not leak, and next run is clean", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await runCode(`const a=[]; for(let i=0;;i++) a.push({ i, s: [i, i, i, i] });`, {}, { memoryBytes: 4 * 1024 * 1024, timeoutMs: 30_000 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(MEM_OK);
      expect(r.error).not.toMatch(/timeout|syntax|ReferenceError|stack|Aborted|RuntimeError|Assertion/i);
    }
    const next = await runCode(
      `const s = "x".repeat(1 << 20); const n = []; for (let i = 0; i < 1000; i++) n.push(i * 1.5); return [s.length, n.length];`,
      {},
      { memoryBytes: 4 * 1024 * 1024 },
    );
    expect(next).toMatchObject({ ok: true, result: [1 << 20, 1000] });
  }, 120_000);

  it("deep recursion -> ok:false, not host stack overflow", async () => {
    const r = await runCode(`function f(n){ return f(n+1)+1; } return f(0);`, {}, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  // TM2-37: under load (2 full suites in parallel) one run measured p50 ~28 ms, p99 ~175 ms,
  // max ~570 ms, and a whole 50-run loop took up to ~3.9 s, so the old 5 s default flaked.
  // The timeout is ~3x the loaded worst case. Wall time is not the leak signal: the run-to-run
  // degradation check, the memory check and the handle check are.
  it("50 sequential runs: fresh context each, every run ok, no leak or degradation", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = nodeVm.runInNewContext("gc") as () => void;
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
    };
    const once = (i: number) =>
      runCode(`globalThis.counter = (globalThis.counter ?? 0) + 1; return [counter, await m.f(${i})];`, { m: { f: echo } });

    // Warm-up (JIT, first WASM compile) so the baselines measure steady state.
    for (let i = 0; i < 5; i++) expect(await once(i)).toMatchObject({ ok: true, result: [1, i] });
    gc();
    const base = process.memoryUsage();
    const baseHandles = process.getActiveResourcesInfo().length;

    const ms: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const r = await once(i);
      ms.push(performance.now() - t0);
      // Fresh context each run: the guest global never carries over.
      expect(r, `run ${i}`).toMatchObject({ ok: true, result: [1, i] });
    }

    gc();
    await sleep(20);
    gc();
    const end = process.memoryUsage();
    const MB = 1024 * 1024;
    // Same tolerance as the O-9 200-run RSS-flat test: a per-run leak of a context/module is several MB each.
    expect(end.rss - base.rss, "rss growth").toBeLessThan(64 * MB);
    expect(end.external - base.external, "external growth").toBeLessThan(32 * MB);
    // No timers/handles left behind per run.
    expect(process.getActiveResourcesInfo().length, "active handles").toBeLessThanOrEqual(baseHandles + 2);
    // Degradation: the last 10 runs are not slower than 2x the first 10 (medians, robust to load spikes).
    const first = median(ms.slice(0, 10));
    const last = median(ms.slice(-10));
    expect(last, `median last10 ${last.toFixed(1)} ms vs first10 ${first.toFixed(1)} ms`).toBeLessThanOrEqual(2 * first);
  }, 12_000);
});
