import { describe, it, expect } from "vitest";
import { runCode } from "../src/sandbox/quickjs.js";

const REMOVED = [
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
];

describe("O-8 sandbox buffers", () => {
  it("every buffer/typed-array global is undefined", async () => {
    const r = await runCode(`return [${REMOVED.map((n) => `typeof ${n}, typeof globalThis.${n}`).join(",")}];`, {});
    expect(r).toMatchObject({ ok: true, result: Array(REMOVED.length * 2).fill("undefined") });
  });

  it("constructing them throws and nothing hands one back", async () => {
    for (const c of ["new Uint8Array(1e6)", "new ArrayBuffer(8)", "new DataView(1)", "Atomics.add", "new WebAssembly.Memory({initial:1})", "Object.getPrototypeOf(Int8Array)"]) {
      expect((await runCode(`${c}; return 1;`, {})).ok, c).toBe(false);
    }
    const r = await runCode(
      `return [Object.getOwnPropertyNames(globalThis).filter(k=>/Array$|Buffer|View|Atomics|WebAssembly/.test(k)).join(","), typeof (await m.f(1)).constructor];`,
      { m: { f: async () => ({ a: 1 }) } },
    );
    expect(r).toMatchObject({ ok: true, result: ["Array", "function"] });
  });

  it("new ArrayBuffer(2**31) fails fast with no host growth", async () => {
    const before = process.memoryUsage().rss;
    const t = Date.now();
    const r = await runCode(`new ArrayBuffer(2**31); return 1;`, {});
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  });

  it("object/string allocation past the cap ends with a memory error (heap ceiling layer)", async () => {
    for (const code of [
      `const a=[]; for(let i=0;;i++) a.push('x'.repeat(1000)+i);`,
      `const a=[]; for(let i=0;;i++) a.push({i,s:[i,i,i,i]});`,
    ]) {
      const r = await runCode(code, {}, { memoryBytes: 4 * 1024 * 1024, timeoutMs: 20_000 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/memory/i);
    }
    expect(await runCode(`return 2;`, {})).toMatchObject({ ok: true, result: 2 });
  }, 60_000);
});
