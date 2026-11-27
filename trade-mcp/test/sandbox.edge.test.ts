import { describe, expect, it, vi } from "vitest";
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
    const r = await runCode(`const a=[]; for(;;) a.push(new Uint8Array(1 << 20));`, {}, { memoryBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
    // Stable properties only: the run is rejected as a string error, it was stopped by the
    // memory cap (not the 20s deadline), no WASM abort text leaks, and the host still works.
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error).not.toMatch(/timeout|Aborted|RuntimeError|Assertion/);
    expect(r.result).toBeUndefined();
    const next = await runCode(`return 1 + 1;`, {});
    expect(next).toMatchObject({ ok: true, result: 2 });
  }, 30_000);

  it("tiny memoryBytes fails gracefully before QuickJS starts", async () => {
    const r = await runCode(`return 1;`, {}, { memoryBytes: 1024 });
    expect(r.ok).toBe(false);
    // Host-generated message (pre-QuickJS guard), so the text is stable.
    expect(r.error).toMatch(/memory limit too small/i);
    const next = await runCode(`return 1;`, {});
    expect(next).toMatchObject({ ok: true, result: 1 });
  });

  it("memory cap stops allocation, does not leak, and next run is clean", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await runCode(`const a=[]; for(;;) a.push(new Uint8Array(1 << 20));`, {}, { memoryBytes: 4 * 1024 * 1024, timeoutMs: 20_000 });
      expect(r.ok).toBe(false);
      expect(r.error).not.toMatch(/timeout|Aborted|RuntimeError|Assertion/);
    }
    const next = await runCode(`const b = new Uint8Array(1 << 20); return b.length;`, {}, { memoryBytes: 4 * 1024 * 1024 });
    expect(next).toMatchObject({ ok: true, result: 1 << 20 });
  }, 60_000);

  it("deep recursion -> ok:false, not host stack overflow", async () => {
    const r = await runCode(`function f(n){ return f(n+1)+1; } return f(0);`, {}, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("50 sequential runs: fresh context each, no growth errors", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await runCode(`globalThis.counter = (globalThis.counter ?? 0) + 1; return [counter, await m.f(${i})];`, { m: { f: echo } });
      expect(r).toMatchObject({ ok: true, result: [1, i] });
    }
  });
});
