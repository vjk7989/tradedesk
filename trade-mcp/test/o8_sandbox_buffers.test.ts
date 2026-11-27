import { describe, it, expect } from "vitest";
import { runCode } from "../src/sandbox/quickjs.js";

describe("O-8 sandbox buffers", () => {
  it("shared-memory / raw-view / wasm globals are removed", async () => {
    const r = await runCode(
      `return [typeof SharedArrayBuffer, typeof DataView, typeof Atomics, typeof WebAssembly, typeof globalThis.Atomics];`,
      {},
    );
    expect(r).toMatchObject({ ok: true, result: Array(5).fill("undefined") });
    for (const c of ["new DataView(new ArrayBuffer(8))", "Atomics.add", "new SharedArrayBuffer(8)", "new WebAssembly.Memory({initial:1})"]) {
      const x = await runCode(`${c}; return 1;`, {});
      expect(x.ok, c).toBe(false);
    }
  });

  it("huge ArrayBuffer / Uint8Array allocation ends with a memory error, host survives", async () => {
    for (const c of ["new Uint8Array(1e6 * 1000)", "new ArrayBuffer(1e9)", `const a=[]; for(;;) a.push(new Uint8Array(1<<20));`]) {
      const r = await runCode(`${c}; return 1;`, {}, { memoryBytes: 4 * 1024 * 1024, timeoutMs: 20_000 });
      expect(r.ok, c).toBe(false);
      expect(r.error, c).toMatch(/memory/i);
    }
    expect(await runCode(`return 1+1;`, {})).toMatchObject({ ok: true, result: 2 });
  }, 60_000);

  it("object/string allocation past the cap still ends with a memory error", async () => {
    const r = await runCode(`const a=[]; for(let i=0;;i++) a.push('x'.repeat(1000)+i);`, {}, { memoryBytes: 4 * 1024 * 1024, timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/memory/i);
    expect(await runCode(`return 2;`, {})).toMatchObject({ ok: true, result: 2 });
  }, 30_000);
});
