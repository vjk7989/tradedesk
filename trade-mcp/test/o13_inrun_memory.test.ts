import { describe, expect, it, vi } from "vitest";
import { runCode } from "../src/sandbox/quickjs.js";

const MB16 = { memoryBytes: 16 * 1024 * 1024, timeoutMs: 60_000 };
const BIG = `JSON.stringify(Array.from({ length: 150000 }, (_, i) => ({ a: i, b: "xxxxxxxx" })))`;

describe("O-13: in-run memory ceiling catches native-call allocation loops", () => {
  it("a JSON.parse loop fails during the run: the guest log stops early", async () => {
    const r = await runCode(
      `const big = ${BIG};
       let hold; for (let i = 0; i < 300; i++) { hold = JSON.parse(big); console.log("p" + i); }
       return "done";`,
      {},
      MB16,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("memory limit exceeded");
    expect(r.logs.length).toBeLessThan(10); // 300 if it ran to completion
  }, 60_000);

  it("a guest that swallows the error still ends with the memory error", async () => {
    const r = await runCode(
      `const big = ${BIG};
       for (let i = 0; i < 40; i++) { try { JSON.parse(big); } catch (e) {} console.log("p" + i); }
       return "done";`,
      {},
      MB16,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("memory limit exceeded");
  }, 60_000);

  it("JSON.parse keeps its behaviour for normal scripts", async () => {
    const r = await runCode(
      `const o = JSON.parse('{"a":[1,2,{"b":3}]}', (k, v) => (typeof v === "number" ? v * 2 : v));
       let err = ""; try { JSON.parse("{"); } catch (e) { err = e.name; }
       return { o, err, len: JSON.parse.length };`,
      {},
      { memoryBytes: 16 * 1024 * 1024 },
    );
    expect(r).toMatchObject({ ok: true, result: { o: { a: [2, 4, { b: 6 }] }, err: "SyntaxError", len: 2 } });
  });

  it("JSON.parse of a non-string that coerces to a big string is still guarded", async () => {
    for (const arg of ["{ toString() { return big; } }", "[big]"]) {
      const r = await runCode(
        `const big = ${BIG}; let hold;
         for (let i = 0; i < 300; i++) { hold = JSON.parse(${arg}); console.log("p" + i); }
         return "done";`,
        {},
        MB16,
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/memory/i);
      expect(r.logs.length).toBeLessThan(10);
    }
  }, 60_000);

  // Native calls the JSON.parse wrapper does not cover: the hard WASM maximum makes malloc fail in-run.
  const loops: Record<string, string> = {
    join: `const a = new Array(1e6).fill("abcdefgh"); let h; for (let i = 0; i < 400; i++) { h = a.join(","); log(i); }`,
    replace: `const s = "a".repeat(2e6); let h; for (let i = 0; i < 400; i++) { h = s.replace(/a/g, "bcdefgh"); log(i); }`,
    stringify: `const a = Array.from({ length: 300000 }, (_, i) => ({ a: i })); let h; for (let i = 0; i < 400; i++) { h = JSON.stringify(a); log(i); }`,
  };
  for (const [name, body] of Object.entries(loops)) {
    it(`${name} loop is stopped in-run (log stops early)`, async () => {
      const r = await runCode(`const log = (i) => console.log("p" + i); ${body} return "done";`, {}, MB16);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/memory/i);
      expect(r.logs.length).toBeLessThan(399);
    }, 60_000);
  }

  it("the WASM memory never grows past its hard maximum", async () => {
    const spy = vi.spyOn(WebAssembly, "Memory");
    try {
      const r = await runCode(`const a = []; for (let i = 0; i < 400; i++) a.push("x".repeat(8e6)); return 1;`, {}, MB16);
      expect(r.ok).toBe(false);
      const mem = spy.mock.results[0].value as WebAssembly.Memory;
      expect(mem.buffer.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024 * 3);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
