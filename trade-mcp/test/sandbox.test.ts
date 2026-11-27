import { describe, expect, it } from "vitest";
import { runCode } from "../src/sandbox/quickjs.js";

const quote = async (a: unknown) => ({ symbol: (a as { symbol: string }).symbol, ltp: 100 });

describe("sandbox", () => {
  it("returns value with top-level await and concurrent host calls", async () => {
    const r = await runCode(
      `const [a,b] = await Promise.all([market.quote({symbol:"A"}), market.quote({symbol:"B"})]); return [a.symbol,b.symbol,a.ltp];`,
      { market: { quote } },
    );
    expect(r).toMatchObject({ ok: true, result: ["A", "B", 100] });
  });

  it("allows undefined result", async () => {
    const r = await runCode(`let x = 1;`, {});
    expect(r.ok).toBe(true);
    expect(r.result).toBeUndefined();
  });

  it("host rejection becomes message-only exception", async () => {
    const r = await runCode(`try { await m.f({}); } catch (e) { return [e.message, String(e.stack ?? "").includes("sandbox.test")]; }`, {
      m: {
        f: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(r.result).toEqual(["boom", false]);
  });

  it("captures and caps logs", async () => {
    const r = await runCode(`console.log("hi",{a:1}); console.warn("w"); for(let i=0;i<100;i++) console.error("xxxxxxxxxx");`, {}, { maxLogBytes: 50 });
    expect(r.logs[0]).toBe('hi {"a":1}');
    expect(r.truncated).toBe(true);
    expect(r.logs.join("").length).toBeLessThanOrEqual(50);
  });

  it("does not expose host globals", async () => {
    const r = await runCode(`return ["fetch","require","process","setTimeout","import","Buffer"].map(k => typeof globalThis[k]);`, {});
    expect(r.result).toEqual(Array(6).fill("undefined"));
  });

  it("times out infinite loop", async () => {
    const r = await runCode(`while(true){}`, {}, { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });

  it("times out never-resolving await", async () => {
    const r = await runCode(`await new Promise(()=>{})`, {}, { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });

  it("enforces memory limit", async () => {
    const r = await runCode(`const a=[]; for(let i=0;;i++) a.push({ i, s: [i, i, i, i] });`, {}, { memoryBytes: 4 * 1024 * 1024, timeoutMs: 30_000 });
    // Stable properties only: the run is rejected as a string error, it was stopped by the
    // memory cap (generous 30s deadline so the cap always fires first), no WASM abort text leaks, and the host still works.
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error).toMatch(/memory|InternalError/i);
    expect(r.error).not.toMatch(/timeout|syntax|ReferenceError|stack|Aborted|RuntimeError|Assertion/i);
    expect(r.result).toBeUndefined();
    const next = await runCode(`return 1 + 1;`, {});
    expect(next).toMatchObject({ ok: true, result: 2 });
  }, 45_000);

  it("reports syntax and thrown errors", async () => {
    const s = await runCode(`let = = 1`, {});
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
    const t = await runCode(`throw new Error("bad")`, {});
    expect(t).toMatchObject({ ok: false, error: "bad" });
  });

  it("isolates runs", async () => {
    await runCode(`globalThis.leak = 1`, {});
    expect((await runCode(`return typeof leak`, {})).result).toBe("undefined");
  });
});
