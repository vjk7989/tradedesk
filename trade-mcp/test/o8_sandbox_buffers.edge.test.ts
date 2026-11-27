import { describe, expect, it } from "vitest";
import { runCode } from "../src/sandbox/quickjs.js";

const MB = 1024 * 1024;
const REMOVED = [
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
];
const MEM = /memory/i;
const MEM_OR_TIMEOUT = /memory|timeout/i;
const HOST_CRASH_TEXT = /Aborted|RuntimeError|Assertion|detached|unreachable/i;
const echo = async (a: unknown) => a;
// Host growth for this process (WASM linear memory is an ArrayBuffer, so it shows in `external`
// and `arrayBuffers` as well as rss). There is no seam exposing the per-run module's
// WebAssembly.Memory, so the WASM heap is observed through these host counters.
const host = () => {
  const m = process.memoryUsage();
  return { rss: m.rss, ext: m.external };
};

describe("O-8 removed globals cannot be reached another way", () => {
  it("each removed name is undefined via bare name, globalThis[], this, Function, eval, new Function, Reflect", async () => {
    const names = JSON.stringify(REMOVED);
    const r = await runCode(
      `const N=${names}; const self=this; const fr=Function("return this")(); const nf=new Function("return globalThis")();
       const out={};
       for (const n of N) out[n]=[
         eval("typeof "+n), typeof globalThis[n], typeof self[n], typeof fr[n], typeof nf[n],
         typeof eval("globalThis")[n], typeof (0,eval)("this")[n], typeof Reflect.get(globalThis,n),
         Reflect.has(globalThis,n), Object.getOwnPropertyDescriptor(globalThis,n)===undefined,
         (function(){ return typeof this[n]; })(),
       ];
       return out;`,
      {},
    );
    expect(r.ok).toBe(true);
    for (const n of REMOVED) {
      expect((r.result as Record<string, unknown[]>)[n], n).toEqual([
        "undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined", false, true, "undefined",
      ]);
    }
  });

  it("no removed name appears in getOwnPropertyNames / Reflect.ownKeys of globalThis", async () => {
    const r = await runCode(`return [Object.getOwnPropertyNames(globalThis), Reflect.ownKeys(globalThis).map(String)];`, { m: { f: echo } });
    expect(r.ok).toBe(true);
    const [names, keys] = r.result as [string[], string[]];
    for (const n of REMOVED) {
      expect(names, n).not.toContain(n);
      expect(keys, n).not.toContain(n);
    }
  });

  it("walking every object reachable from globalThis finds no buffer / typed-array intrinsic", async () => {
    // BFS over own properties (values + getters' targets are skipped) and prototypes from the
    // guest global and every binding result: catches %TypedArray% or ArrayBuffer leaking through
    // a prototype chain, a constructor or an alias.
    const r = await runCode(
      `const seen=new Set(); const q=[globalThis, await m.f({a:[1,2]})]; const hits=[];
       const bad=/^(ArrayBuffer|SharedArrayBuffer|DataView|Atomics|WebAssembly|TypedArray|.*\\d+(Clamped)?Array)$/;
       while(q.length){ const o=q.shift(); if((typeof o!=="object"&&typeof o!=="function")||o===null||seen.has(o)) continue; seen.add(o);
         let tag=""; try{ tag=Object.prototype.toString.call(o).slice(8,-1);}catch{}
         let name=""; try{ name=typeof o==="function"?String(o.name):""; }catch{}
         if(bad.test(tag)||bad.test(name)) hits.push(tag+"/"+name);
         try{ q.push(Object.getPrototypeOf(o)); }catch{}
         let ks=[]; try{ ks=Reflect.ownKeys(o);}catch{}
         for(const k of ks){ let d; try{ d=Object.getOwnPropertyDescriptor(o,k);}catch{} if(d&&"value" in d) q.push(d.value); }
       }
       return [hits, seen.size];`,
      { m: { f: echo } },
    );
    expect(r.ok).toBe(true);
    const [hits, size] = r.result as [string[], number];
    expect(hits).toEqual([]);
    expect(size).toBeGreaterThan(100);
  });

  it("Symbol.species, Array.from on a typed-array-like and structuredClone give no typed array", async () => {
    const r = await runCode(
      `class X extends Array { static get [Symbol.species]() { return Array; } }
       const sp = new X(1,2,3).map(v=>v);
       const like = { length: 3, 0: 1, 1: 2, 2: 3, BYTES_PER_ELEMENT: 1, buffer: {} };
       const fromLike = Array.from(like);
       return [
         [].constructor[Symbol.species] === Array, Array.isArray(sp), sp.constructor === Array,
         Array.isArray(fromLike), fromLike.join(), Object.getPrototypeOf(fromLike) === Array.prototype,
         typeof structuredClone, typeof Object.getPrototypeOf(Object.getPrototypeOf([].values())),
       ];`,
      {},
    );
    expect(r).toMatchObject({ ok: true, result: [true, true, true, true, "1,2,3", true, "undefined", "object"] });
  });

  it("re-adding a deleted name in run 1 does not leak into run 2", async () => {
    const r1 = await runCode(`globalThis.Uint8Array = function fake(){}; return typeof Uint8Array;`, {});
    expect(r1).toMatchObject({ ok: true, result: "function" });
    const r2 = await runCode(`return [typeof Uint8Array, typeof ArrayBuffer];`, {});
    expect(r2).toMatchObject({ ok: true, result: ["undefined", "undefined"] });
  });
});

describe("O-8 large allocations through routes still available", () => {
  const hostile: Array<[string, string, RegExp]> = [
    ["huge string via repeat(2**29)", `const s = "x".repeat(2**29); return s.length;`, MEM],
    ["Array(1e8).fill(0)", `const a = Array(1e8).fill(0); return a.length;`, MEM],
    ["new Array(2**32-1) then fill", `const a = new Array(2**32-1); a.fill(0); return a.length;`, MEM_OR_TIMEOUT],
    ["JSON.parse of a huge built string", `const s = "[" + "1,".repeat(5e7) + "1]"; return JSON.parse(s).length;`, MEM],
    ["JSON.parse of growing chunks", `const a=[]; for(;;) a.push(JSON.parse("[" + "1,".repeat(1e5) + "1]"));`, MEM],
    ["Map flood", `const m = new Map(); for (let i = 0; ; i++) m.set(i, { i });`, MEM],
    ["Set flood", `const s = new Set(); for (let i = 0; ; i++) s.add("k" + i);`, MEM],
    ["padEnd with a huge length", `return "".padEnd(2**29, "ab").length;`, MEM],
    // QuickJS caps string length (2**30-1) before the heap: a guest-side length error is fine here.
    ["string concat doubling", `let s = "x"; for (;;) s += s;`, /memory|string too long|invalid string length/i],
  ];

  for (const [name, code, re] of hostile) {
    it(`${name} -> ${re.source} error, host survives, next run works`, async () => {
      const r = await runCode(code, {}, { memoryBytes: 64 * MB, timeoutMs: 20_000 });
      expect(r.ok, name).toBe(false);
      expect(r.result).toBeUndefined();
      expect(r.error, name).toMatch(re);
      expect(r.error, name).not.toMatch(HOST_CRASH_TEXT);
      expect(await runCode(`return [1, 2, 3].map((x) => x * 2);`, {})).toMatchObject({ ok: true, result: [2, 4, 6] });
    }, 45_000);
  }

  it("new Array(2**32-1) is sparse: succeeds without allocating", async () => {
    const before = host();
    const r = await runCode(`const a = new Array(2**32-1); a[2**32-2] = 1; return [a.length, a[2**32-2]];`, {}, { memoryBytes: 4 * MB });
    expect(r).toMatchObject({ ok: true, result: [2 ** 32 - 1, 1] });
    expect(host().rss - before.rss).toBeLessThan(64 * MB);
  });

  it("deep recursion stops on the stack limit, not a host overflow; next run works", async () => {
    const r = await runCode(`function f(n){ return f(n+1)+1; } return f(0);`, {}, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    // QuickJS reports its own stack guard, not memory/timeout: still a guest-side rejection.
    expect(r.error).toMatch(/stack|memory|timeout/i);
    expect(r.error).not.toMatch(HOST_CRASH_TEXT);
    expect(await runCode(`return 1;`, {})).toMatchObject({ ok: true, result: 1 });
  });

  it("RegExp catastrophic backtracking -> timeout fires; next run works", async () => {
    const t = Date.now();
    const r = await runCode(`return /^(a+)+$/.test("a".repeat(40) + "b");`, {}, { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(await runCode(`return 1;`, {})).toMatchObject({ ok: true, result: 1 });
  }, 15_000);

  it("WASM ceiling boundary: memoryBytes at the 1 MB minimum still runs a trivial script", async () => {
    // ceiling = memoryBytes + 16 MB: the fresh module's base heap must fit under it.
    expect(await runCode(`return 1;`, {}, { memoryBytes: MB })).toMatchObject({ ok: true, result: 1 });
    expect((await runCode(`return 1;`, {}, { memoryBytes: MB - 1 })).ok).toBe(false);
  });
});

describe("O-8 host safety", () => {
  it("one hostile run: host rss / external growth stays under memoryBytes + 64 MB", async () => {
    const memoryBytes = 64 * MB;
    const before = host();
    const r = await runCode(`const a = []; for (let i = 0; ; i++) a.push({ i, s: "y".repeat(1000) + i });`, {}, { memoryBytes, timeoutMs: 20_000 });
    const after = host();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(MEM);
    expect(after.rss - before.rss).toBeLessThan(memoryBytes + 64 * MB);
    expect(after.ext - before.ext).toBeLessThan(memoryBytes + 64 * MB);
  }, 45_000);

  it("10 hostile runs in a row: rss does not keep climbing", async () => {
    const rss: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await runCode(`const m = new Map(); for (let i = 0; ; i++) m.set(i, "v" + i);`, {}, { memoryBytes: 64 * MB, timeoutMs: 20_000 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(MEM);
      await new Promise((res) => setTimeout(res, 10));
      rss.push(process.memoryUsage().rss);
    }
    // Old WASM modules are collected lazily, so allow one run's worth of slack: the last runs must
    // not sit more than ~(ceiling + 64 MB) above the first ones (10 leaked heaps would be ~800 MB).
    const early = Math.max(...rss.slice(0, 3));
    const late = Math.max(...rss.slice(-3));
    expect(late - early).toBeLessThan(80 * MB + 64 * MB);
    expect(await runCode(`return 1;`, {})).toMatchObject({ ok: true, result: 1 });
  }, 240_000);

  // REPORT (security bug, fails today): binding arguments bypass both O-8 layers. The binding
  // wrapper in src/sandbox/quickjs.ts does `const arg = vm.dump(argHandle)` synchronously on every
  // call and keeps that host copy in the pending `Promise.resolve().then(() => hostFn(arg))`
  // closure. Host microtasks cannot run while the guest's synchronous loop runs, so N un-awaited
  // calls keep N host copies alive. The guest holds only ONE 1 MB string (well under a 4 MB cap)
  // and the WASM heap stays small, so neither setMemoryLimit nor the WASM ceiling fires.
  // Measured: 1000 calls at a 4 MB cap -> ok:true with host rss ~ +1 GB; `for(;;) m.f(s)` with a
  // never-settling binding killed the vitest worker (exit 134, V8 OOM abort) before the timeout.
  // Bounded here at 300 calls so the host survives. Left failing on purpose; do not weaken.
  it("REPORT: un-awaited binding calls with a 1 MB arg do not grow the host past memoryBytes + 64 MB", async () => {
    const memoryBytes = 4 * MB;
    const before = host();
    const r = await runCode(
      `const s = "x".repeat(1 << 20); for (let i = 0; i < 300; i++) m.f(s); return 1;`,
      { m: { f: async (a: unknown) => (typeof a === "string" ? a.length : 0) } },
      { memoryBytes, timeoutMs: 20_000 },
    );
    const grew = host().rss - before.rss;
    // Either the run is stopped on memory, or the host copies stay within the budget.
    if (r.ok) expect(grew, `run succeeded and host grew ${(grew / MB).toFixed(0)} MB`).toBeLessThan(memoryBytes + 64 * MB);
    else expect(r.error).toMatch(MEM);
    expect(await runCode(`return 1;`, {})).toMatchObject({ ok: true, result: 1 });
  }, 60_000);

  it("un-awaited binding flood with small args ends ok:false without killing the host; next run works", async () => {
    const r = await runCode(`for (;;) m.f(1);`, { m: { f: echo } }, { memoryBytes: 4 * MB, timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(await runCode(`return await m.f(7);`, { m: { f: echo } })).toMatchObject({ ok: true, result: 7 });
  }, 30_000);
});

describe("O-8 normal scripts unaffected", () => {
  it("backtest-style script: objects, arrays of numbers, math", async () => {
    const r = await runCode(
      `const bars = (await m.bars()).map((c, i) => ({ t: i, c }));
       const sma = (n, i) => bars.slice(i - n + 1, i + 1).reduce((s, b) => s + b.c, 0) / n;
       let pos = 0, cash = 10000, trades = [];
       for (let i = 4; i < bars.length; i++) {
         const fast = sma(2, i), slow = sma(5, i);
         if (fast > slow && pos === 0) { pos = Math.floor(cash / bars[i].c); cash -= pos * bars[i].c; trades.push({ side: "B", i }); }
         else if (fast < slow && pos > 0) { cash += pos * bars[i].c; pos = 0; trades.push({ side: "S", i }); }
       }
       const eq = cash + pos * bars[bars.length - 1].c;
       const rets = bars.slice(1).map((b, i) => Math.log(b.c / bars[i].c));
       const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
       const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
       const big = Array.from({ length: 100000 }, (_, i) => Math.sin(i));
       return { eq: Math.round(eq * 100) / 100, n: trades.length, mean: +mean.toFixed(6), sd: +sd.toFixed(6), big: big.length, max: Math.max(...big.slice(0, 1000)) <= 1 };`,
      { m: { bars: async () => [100, 101, 102, 101, 99, 98, 100, 103, 105, 104, 102, 101, 103, 106, 108] } },
    );
    expect(r.ok).toBe(true);
    const c = [100, 101, 102, 101, 99, 98, 100, 103, 105, 104, 102, 101, 103, 106, 108];
    // host-side reference for the same strategy
    const sma = (n: number, i: number) => c.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
    let pos = 0, cash = 10000, n = 0;
    for (let i = 4; i < c.length; i++) {
      if (sma(2, i) > sma(5, i) && pos === 0) { pos = Math.floor(cash / c[i]); cash -= pos * c[i]; n++; }
      else if (sma(2, i) < sma(5, i) && pos > 0) { cash += pos * c[i]; pos = 0; n++; }
    }
    expect(r.result).toMatchObject({ eq: Math.round((cash + pos * c[c.length - 1]) * 100) / 100, n, big: 100000, max: true });
  });

  it("default 64 MB cap: ~30 MB of retained data still succeeds (WASM ceiling does not misfire)", async () => {
    const r = await runCode(
      `const a=[]; for (let i=0;i<30;i++) a.push(String(i).padEnd(1<<20, "z")); const o=[]; for(let i=0;i<50000;i++) o.push({i, v:i*0.5}); return [a.length, o.length];`,
      {},
    );
    expect(r).toMatchObject({ ok: true, result: [30, 50000] });
  }, 30_000);
});
