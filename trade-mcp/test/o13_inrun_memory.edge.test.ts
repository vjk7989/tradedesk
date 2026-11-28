import { appendFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// O-13 adversarial edge tests.
// Seam: a pass-through wrapper around quickjs-emscripten's newQuickJSWASMModule (the variant argument is
// forwarded untouched) that records the per-run module, so the test can read its linear memory after the
// run. Linear memory never shrinks, so its size after the run is the peak reached during it.
const hooks = vi.hoisted(() => ({
  mod: undefined as { getWasmMemory(): WebAssembly.Memory } | undefined,
}));

vi.mock("quickjs-emscripten", async (orig) => {
  const actual = await orig<typeof import("quickjs-emscripten")>();
  return {
    ...actual,
    newQuickJSWASMModule: async (...args: Parameters<typeof actual.newQuickJSWASMModule>) => {
      const mod = await actual.newQuickJSWASMModule(...args);
      hooks.mod = mod as unknown as { getWasmMemory(): WebAssembly.Memory };
      return mod;
    },
  };
});

const { runCode } = await import("../src/sandbox/quickjs.js");
// A function call, so TS does not narrow hooks.mod across the awaited run that sets it.
const lastMemory = (): WebAssembly.Memory | undefined => hooks.mod?.getWasmMemory();

const MB = 1024 * 1024;
const PAGE = 64 * 1024;
const CAP = 16 * MB;
const OPTS = { memoryBytes: CAP, timeoutMs: 90_000 };
// Hard WASM maximum per run (fix round 1): 16 MB baseline + memoryBytes + 16 MB headroom.
const maxPagesFor = (memoryBytes: number) => Math.ceil((memoryBytes + 16 * MB) / PAGE) + 256;
const MAX = maxPagesFor(CAP) * PAGE; // 48 MB at a 16 MB cap
// The soft ceiling checked in-run by the interrupt handler / JSON.parse guard and after the run.
const CEILING = CAP + 16 * MB;
const BIG = `JSON.stringify(Array.from({ length: 150000 }, (_, i) => ({ a: i, b: "xxxxxxxx" })))`;
const N = 300;

async function probe(code: string, tag = "") {
  hooks.mod = undefined;
  const r = await runCode(code, {}, OPTS);
  const peak = lastMemory()?.buffer.byteLength ?? NaN;
  // Set O13_LOG=<file> to record the per-operation table.
  if (process.env.O13_LOG)
    appendFileSync(
      process.env.O13_LOG,
      `[o13-edge] ${tag} ok=${r.ok} err=${r.error} logs=${r.logs.length} peak=${(peak / MB).toFixed(1)}MB\n`,
    );
  return { r, peak };
}

// In-run: the log stops before `before` entries (the loop logs `N` times if it runs to completion).
const expectInRun = (p: Awaited<ReturnType<typeof probe>>, before = 10) => {
  expect(p.r.ok).toBe(false);
  expect(p.r.error).toBe("memory limit exceeded");
  expect(p.r.logs.length).toBeLessThan(before);
  expect(p.peak).toBeLessThanOrEqual(MAX);
};

describe("O-13 edge: the WASM hard maximum is really set, per run", () => {
  // WebAssembly.Memory does not expose `maximum` in Node (no type reflection), so read the growth
  // limit directly: after the run, growing to exactly the maximum succeeds and one page more throws.
  for (const memoryBytes of [CAP, 32 * MB, 1 * MB]) {
    it(`memoryBytes=${memoryBytes / MB} MB: maximum = 16 MB baseline + memoryBytes + 16 MB`, async () => {
      hooks.mod = undefined;
      const r = await runCode(`return 1 + 1;`, {}, { memoryBytes });
      expect(r).toMatchObject({ ok: true, result: 2 });
      const mem = lastMemory()!;
      expect(mem).toBeInstanceOf(WebAssembly.Memory);
      const pages = mem.buffer.byteLength / PAGE;
      expect(pages).toBe(256); // initial: the 16 MB baseline, untouched by a trivial script
      const room = maxPagesFor(memoryBytes) - pages;
      expect(() => mem.grow(room + 1)).toThrow(RangeError);
      expect(mem.grow(room)).toBe(pages);
      expect(mem.buffer.byteLength).toBe(maxPagesFor(memoryBytes) * PAGE);
      expect(() => mem.grow(1)).toThrow(RangeError);
    });
  }

  it("each run gets its own Memory (a grown one is not reused)", async () => {
    await runCode(`return 1;`, {}, { memoryBytes: CAP });
    const first = lastMemory()!;
    first.grow(maxPagesFor(CAP) - first.buffer.byteLength / PAGE);
    await runCode(`return 1;`, {}, { memoryBytes: CAP });
    const second = lastMemory()!;
    expect(second).not.toBe(first);
    expect(second.buffer.byteLength).toBe(256 * PAGE);
  });

  it("a legitimate repeat/padEnd/template loop well below the cap still succeeds", async () => {
    const p = await probe(
      `let h; for (let i = 0; i < 200; i++) { h = "abcd".repeat(1 << 18); h = h.padEnd(2 << 20, "z"); h = \`\${h}\${i}\`; console.log("p" + i); }
       return h.length;`,
      "legit",
    );
    expect(p.r).toMatchObject({ ok: true, result: (2 << 20) + 3 });
    expect(p.r.logs.length).toBe(200);
    expect(p.peak).toBeLessThanOrEqual(CEILING);
  }, 120_000);
});

describe("O-13 edge: the JSON.parse guard cannot be sidestepped", () => {
  const loop = (pre: string, call: string) =>
    `const big = ${BIG}; ${pre}
     let hold; for (let i = 0; i < ${N}; i++) { hold = ${call}; console.log("p" + i); }
     return "done";`;

  it("a reference captured at the top of the script is the guarded one", async () => {
    expectInRun(await probe(loop(`const early = JSON.parse;`, `early(big)`), "early-ref"));
  }, 120_000);

  it("Reflect.apply(JSON.parse, ...)", async () => {
    expectInRun(await probe(loop(``, `Reflect.apply(JSON.parse, JSON, [big])`), "reflect.apply"));
  }, 120_000);

  it("JSON.parse.call / .apply / .bind", async () => {
    expectInRun(await probe(loop(``, `JSON.parse.call(null, big)`), "call"));
    expectInRun(
      await probe(loop(`const b = JSON.parse.bind(null);`, `JSON.parse.apply(undefined, [big]) && b(big)`), "apply+bind"),
    );
  }, 240_000);

  it("Object.getPrototypeOf(JSON) has no parse; an object inheriting from JSON gets the guarded one", async () => {
    expectInRun(
      await probe(
        loop(
          `if ("parse" in Object.getPrototypeOf(JSON)) throw new Error("proto has parse");
           const d = Object.getOwnPropertyDescriptor(JSON, "parse").value; const child = Object.create(JSON);`,
          `(i % 2 ? d(big) : child.parse(big))`,
        ),
        "proto",
      ),
    );
  }, 120_000);

  it("deleting or redefining the JSON global does not reach the unguarded native", async () => {
    expectInRun(
      await probe(
        loop(`const p = JSON.parse; delete globalThis.JSON; globalThis.JSON = { parse: p };`, `JSON.parse(big)`),
        "delete-JSON",
      ),
    );
    expectInRun(
      await probe(
        loop(`const p = JSON.parse; Object.defineProperty(JSON, "parse", { value: (t) => p(t) });`, `JSON.parse(big)`),
        "redefine-parse",
      ),
    );
  }, 240_000);

  it("eval('JSON.parse') and new Function('return JSON.parse') return the guarded one", async () => {
    expectInRun(await probe(loop(`const e = eval("JSON.parse");`, `e(big)`), "eval"));
    expectInRun(await probe(loop(`const f = new Function("return JSON.parse")();`, `f(big)`), "new-Function"));
  }, 240_000);

  it("non-string inputs that coerce to the big string (String object, toString, toPrimitive)", async () => {
    expectInRun(await probe(loop(`const so = new String(big);`, `JSON.parse(so)`), "String-object"));
    expectInRun(await probe(loop(`const t = { toString() { return big; } };`, `JSON.parse(t)`), "toString"));
    expectInRun(
      await probe(loop(`const t = { [Symbol.toPrimitive]() { return big; } };`, `JSON.parse(t)`), "toPrimitive"),
    );
  }, 360_000);

  // REAL BYPASS (kept failing on purpose, fix round 1 head fc0672b): measured logs=300/300, error only
  // from the post-run check, peak 33.3 MB (over the 32 MB soft ceiling, under the 48 MB hard maximum).
  // The wrapper calls guard() only after P() returns, so a big parse that allocates and then throws a
  // SyntaxError never reaches the check, and a try/catch loop of them runs too few bytecodes for the
  // interrupt handler. The hard maximum still bounds the host; the in-run check is what is bypassed.
  // Fix idea: run guard() in a finally around P() (or before rethrowing) for inputs over the threshold.
  it("a big parse that throws (SyntaxError at the last char) in a swallowing loop", async () => {
    expectInRun(
      await probe(
        `const big = ${BIG} + "x";
         for (let i = 0; i < ${N}; i++) { try { JSON.parse(big); } catch (e) { if (/memory/.test(e.message)) throw e; } console.log("p" + i); }
         return "done";`,
        "throwing-parse",
      ),
    );
  }, 120_000);
});

// Native allocators the JSON.parse wrapper does not cover, in the "few large native calls" loop shape at
// a 16 MB cap with a log after each call.
//  - transient: keep only the latest result. These may legitimately finish (the allocator reuses its
//    freed blocks); then the peak must stay under the soft ceiling. If they fail, it is with the memory
//    error, and the peak never passes the hard maximum.
//  - accumulate: keep every result. Must end with the memory error in-run (log stops before 100),
//    peak <= max. Exception: template literal results are ropes over the shared `s` (no growth at all,
//    peak stays at the 16 MB baseline), so that loop legitimately completes.
// Measured at fc0672b: sort transient is CAUGHT ONLY POST-RUN (logs 100/100, peak 38.6 MB: over the
// soft ceiling, under the hard maximum); the assertions below allow it because the peak is bounded.
const OPS: Record<string, { setup: string; expr: string }> = {
  "RegExp replace": { setup: `const s = "ab".repeat(1 << 20);`, expr: `s.replace(/a/g, "cc")` },
  "RegExp exec": { setup: `const s = "ab".repeat(1 << 20);`, expr: `/(?:ab)*$/.exec(s)` },
  "Array.join": { setup: `const a = Array(600000).fill("xxxxxxxxxx");`, expr: `a.join(",")` },
  "String.repeat": { setup: ``, expr: `"abcd".repeat(3 << 20)` },
  "String.padEnd": { setup: ``, expr: `"".padEnd(12 << 20, "ab")` },
  split: { setup: `const s = "abcdefghi,".repeat(350000);`, expr: `s.split(",")` },
  "Array.from": { setup: `const a = Array.from({ length: 300000 }, (_, i) => i);`, expr: `Array.from(a)` },
  "JSON.stringify": {
    setup: `const o = Array.from({ length: 100000 }, (_, i) => ({ a: i, b: "xxxxxxxx" }));`,
    expr: `JSON.stringify(o)`,
  },
  sort: { setup: `const a = Array.from({ length: 400000 }, (_, i) => (i * 7919) % 400000);`, expr: `a.slice().sort()` },
  "template literal": { setup: `const s = "x".repeat(4 << 20);`, expr: `\`\${s}\${i}\${s}\`` },
  normalize: { setup: `const u = "e\\u0301".repeat(1 << 19);`, expr: `u.normalize("NFC").normalize("NFD")` },
};

describe("O-13 edge: other native allocators stay within the hard WASM maximum", () => {
  for (const [name, { setup, expr }] of Object.entries(OPS)) {
    it(`${name}: transient loop never overshoots unseen`, async () => {
      const p = await probe(
        `${setup} let h; for (let i = 0; i < 100; i++) { h = null; h = ${expr}; console.log("p" + i); } return 1;`,
        `${name} transient`,
      );
      expect(p.peak).toBeLessThanOrEqual(MAX);
      if (p.r.ok) expect(p.peak).toBeLessThanOrEqual(CEILING);
      else expect(p.r.error).toBe("memory limit exceeded");
    }, 180_000);

    it(`${name}: accumulating loop is stopped in-run`, async () => {
      const p = await probe(
        `${setup} const keep = []; for (let i = 0; i < 100; i++) { keep.push(${expr}); console.log("p" + i); } return 1;`,
        `${name} accumulate`,
      );
      if (name === "template literal") {
        expect(p.r.ok).toBe(true);
        expect(p.peak).toBeLessThanOrEqual(CEILING);
      } else expectInRun(p, 100);
    }, 180_000);
  }
});
