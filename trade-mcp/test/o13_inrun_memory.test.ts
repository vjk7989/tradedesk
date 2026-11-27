import { describe, expect, it } from "vitest";
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
       for (let i = 0; i < 300; i++) { try { JSON.parse(big); } catch (e) {} console.log("p" + i); }
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
});
