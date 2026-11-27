import { describe, it, expect, vi } from "vitest";
import * as v8 from "node:v8";
import * as nodeVm from "node:vm";

// Pass-through wrapper around quickjs-emscripten with test hooks (init-delete suppression, fake wasm size,
// dispose failure injection and recording).
const hooks = vi.hoisted(() => ({
  skipDelete: false,
  fakeWasm: undefined as { byteLength: number } | undefined,
  vmDisposeThrows: false,
  disposeCalls: [] as string[],
  disposeErrors: [] as string[],
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
  return {
    ...actual,
    newQuickJSWASMModule: async () => {
      const mod = await actual.newQuickJSWASMModule();
      return wrap(mod, {
        getWasmMemory: () => (hooks.fakeWasm ? { buffer: hooks.fakeWasm } : mod.getWasmMemory()),
        newRuntime: () => {
          const rt = mod.newRuntime();
          return wrap(rt, {
            dispose: () => {
              hooks.disposeCalls.push("runtime");
              try {
                rt.dispose();
              } catch (e) {
                hooks.disposeErrors.push(`runtime: ${(e as Error).message}`);
                throw e;
              }
            },
            newContext: () => {
              const c = rt.newContext();
              return wrap(c, {
                evalCode: (code: string, ...rest: unknown[]) =>
                  hooks.skipDelete && code.startsWith("delete globalThis")
                    ? c.evalCode("undefined")
                    : (c.evalCode as (...a: unknown[]) => unknown)(code, ...rest),
                dispose: () => {
                  hooks.disposeCalls.push("vm");
                  try {
                    c.dispose();
                  } catch (e) {
                    hooks.disposeErrors.push(`vm: ${(e as Error).message}`);
                    throw e;
                  }
                  if (hooks.vmDisposeThrows) throw new Error("injected vm.dispose failure");
                },
              });
            },
          });
        },
      });
    },
  };
});

const { runCode } = await import("../src/sandbox/quickjs.js");

const reset = () => {
  hooks.skipDelete = false;
  hooks.fakeWasm = undefined;
  hooks.vmDisposeThrows = false;
  hooks.disposeCalls.length = 0;
  hooks.disposeErrors.length = 0;
};

// A realistic year of daily bars (OpenAlgo history rows).
const dailyBars = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000 + i * 86400,
    open: 1234.55 + i,
    high: 1250.1 + i,
    low: 1220.35 + i,
    close: 1240.8 + i,
    volume: 1234567 + i,
    oi: 0,
  }));

describe("O-9 fail-closed globals", () => {
  it("fails with sandbox init failed when a removed global survives, before user code runs", async () => {
    reset();
    hooks.skipDelete = true;
    const r = await runCode(`console.log("user code ran"); return 1;`, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe("sandbox init failed");
    expect(r.logs).toEqual([]);
    reset();
  });
  it("normal init passes the check", async () => {
    reset();
    const r = await runCode(`return typeof ArrayBuffer;`, {});
    expect(r).toMatchObject({ ok: true, result: "undefined" });
  });
});

describe("O-9 in-guest argument sizing", () => {
  it("rejects an oversized argument and never calls the host fn", async () => {
    let called = 0;
    const r = await runCode(
      `try { await t.f("x".repeat(2*1024*1024)); return "no"; } catch (e) { return e.message; }`,
      { t: { f: async () => (called++, 1) } },
      { memoryBytes: 64 * 1024 * 1024 },
    );
    expect(r.result).toBe("binding argument too large");
    expect(called).toBe(0);
  });
  it("does not build a host copy of an oversized argument", async () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const r = await runCode(
        `try { await t.f("y".repeat(3*1024*1024)); return "no"; } catch (e) { return e.message; }`,
        { t: { f: async () => 1 } },
        { memoryBytes: 64 * 1024 * 1024 },
      );
      expect(r.result).toBe("binding argument too large");
      for (const call of spy.mock.calls) {
        const a = call[0];
        expect(typeof a === "string" && a.length > 1024 * 1024).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
  });
  it("circular arguments are rejected, normal arguments still pass", async () => {
    const r = await runCode(
      `const c = {}; c.self = c; let m; try { await t.f(c); m = "no"; } catch (e) { m = e.message; }
       return [m, await t.f({ a: 1 }), await t.f()];`,
      { t: { f: async (a: unknown) => a ?? "none" } },
    );
    expect(r.result).toEqual(["binding argument too large", { a: 1 }, "none"]);
  });
  it("an argument just under the limit passes (host check is a second check)", async () => {
    const r = await runCode(`return (await t.f("z".repeat(1000*1000))).length;`, {
      t: { f: async (a: unknown) => a },
    });
    expect(r).toMatchObject({ ok: true, result: 1000 * 1000 });
  });
});

describe("O-9 binding result cap", () => {
  it("rejects a result over the default 4 MB cap with an actionable message", async () => {
    const r = await runCode(
      `try { await t.f(); return "no"; } catch (e) { return e.message; }`,
      { t: { f: async () => "a".repeat(5 * 1024 * 1024) } },
      { memoryBytes: 64 * 1024 * 1024 },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/^binding result too large/);
    expect(r.result).toMatch(/fewer bars or a shorter date range/);
  });
  it("cap is memoryBytes/4 when smaller", async () => {
    const r = await runCode(
      `try { await t.f(); return "no"; } catch (e) { return e.message; }`,
      { t: { f: async () => "a".repeat(600 * 1024) } },
      { memoryBytes: 2 * 1024 * 1024 },
    );
    expect(r.result).toMatch(/^binding result too large/);
  });
  it("a year of daily bars (252) fits comfortably", async () => {
    const bars = dailyBars(252);
    const size = JSON.stringify(bars).length;
    expect(size).toBeLessThan(40 * 1024);
    const r = await runCode(`return (await market.history({})).length;`, {
      market: { history: async () => bars },
    });
    expect(r).toMatchObject({ ok: true, result: 252 });
  });
  it("a year of 5-minute bars (~19k) also fits under the default 4 MB cap", async () => {
    const bars = dailyBars(75 * 252);
    expect(JSON.stringify(bars).length).toBeLessThan(4 * 1024 * 1024);
    const r = await runCode(
      `return (await market.history({})).length;`,
      { market: { history: async () => bars } },
      { memoryBytes: 64 * 1024 * 1024 },
    );
    expect(r).toMatchObject({ ok: true, result: 75 * 252 });
  });
});

describe("O-9 dispose and handle leaks", () => {
  it("normal run disposes everything without throwing (jsonParse handle released)", async () => {
    reset();
    const r = await runCode(`return await t.f({ a: 1 });`, { t: { f: async () => ({ ok: 1 }) } });
    expect(r.ok).toBe(true);
    expect(hooks.disposeCalls).toEqual(["vm", "runtime"]);
    expect(hooks.disposeErrors).toEqual([]);
  });
  it("timeout and error runs also dispose cleanly", async () => {
    reset();
    await runCode(`while(true){}`, {}, { timeoutMs: 200 });
    await runCode(`throw new Error("x")`, {});
    expect(hooks.disposeErrors).toEqual([]);
  });
  it("runtime is disposed even if vm.dispose throws", async () => {
    reset();
    hooks.vmDisposeThrows = true;
    const r = await runCode(`return 1;`, {});
    expect(r.ok).toBe(true);
    expect(hooks.disposeCalls).toEqual(["vm", "runtime"]);
    reset();
  });
});

describe("O-9 heap ceiling on settle", () => {
  it("memory exceeded while parked on a binding is reported when the binding settles", async () => {
    reset();
    hooks.fakeWasm = { byteLength: 1024 * 1024 };
    const fake = hooks.fakeWasm;
    const r = await runCode(
      `await t.grow(); await t.shrink(); return "finished";`,
      {
        t: {
          grow: async () => ((fake.byteLength = 200 * 1024 * 1024), 1),
          shrink: async () => ((fake.byteLength = 1024 * 1024), 1),
        },
      },
      { memoryBytes: 8 * 1024 * 1024 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("memory limit exceeded");
    reset();
  });
});

describe("O-9 loop: no leak across 200 mixed runs", () => {
  it("RSS and external stay flat", async () => {
    reset();
    v8.setFlagsFromString("--expose-gc");
    const gc = nodeVm.runInNewContext("gc") as () => void;
    const hostile = [
      `while(true){}`,
      `const a=[]; while(true) a.push("x".repeat(1e5));`,
      `try { await t.f("x".repeat(2e6)); } catch (e) {} return typeof ArrayBuffer;`,
      `try { await t.big(); } catch (e) { return e.message; }`,
      `throw new Error("boom")`,
      `for (let i=0;i<100;i++) t.f({i}); return 1;`,
    ];
    const normal = `return (await t.f({ a: [1,2,3] })).a.length;`;
    const bindings = { t: { f: async (a: unknown) => a, big: async () => "a".repeat(5 * 1024 * 1024) } };
    const once = (i: number) =>
      runCode(i % 2 ? normal : hostile[(i >> 1) % hostile.length]!, bindings, {
        timeoutMs: 300,
        memoryBytes: 8 * 1024 * 1024,
      });
    for (let i = 0; i < 20; i++) await once(i);
    gc();
    const base = process.memoryUsage();
    for (let i = 0; i < 200; i++) await once(i);
    gc();
    await new Promise((r) => setTimeout(r, 50));
    gc();
    const end = process.memoryUsage();
    const MB = 1024 * 1024;
    // Stated tolerance: +64 MB RSS, +32 MB external over 200 runs (a per-run leak would be several MB each).
    expect(end.rss - base.rss).toBeLessThan(64 * MB);
    expect(end.external - base.external).toBeLessThan(32 * MB);
  }, 300_000);
});
