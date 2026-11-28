import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { freemem, tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// O-16 adversarial edge tests: EXECUTE_MEMORY_MB reaches real sandbox runs through config -> server -> runCode.
// Seam (same as O-13 edge): a pass-through wrapper around quickjs-emscripten's newQuickJSWASMModule that records
// the per-run module, so the test can read its linear memory after the run (linear memory never shrinks, so its
// size after the run is the peak).
const hooks = vi.hoisted(() => ({
  mods: [] as { getWasmMemory(): WebAssembly.Memory }[],
}));
vi.mock("quickjs-emscripten", async (orig) => {
  const actual = await orig<typeof import("quickjs-emscripten")>();
  return {
    ...actual,
    newQuickJSWASMModule: async (...args: Parameters<typeof actual.newQuickJSWASMModule>) => {
      const mod = await actual.newQuickJSWASMModule(...args);
      hooks.mods.push(mod as unknown as { getWasmMemory(): WebAssembly.Memory });
      return mod;
    },
  };
});

const { loadConfig } = await import("../src/config.js");
const { createMcpServer } = await import("../src/server.js");
const { RiskEngine } = await import("../src/risk/engine.js");

const MB = 1024 * 1024;
const PAGE = 64 * 1024;
const BASE = { OPENALGO_URL: "http://localhost:5000", OPENALGO_API_KEY: "key-for-o16-edge-0123456789", MCP_TOKEN: "t".repeat(32) };
const BUSY = "busy: too many concurrent executes, retry shortly";

// ---------------------------------------------------------------------------------------------------------------
// Env parsing, compared exactly against EXECUTE_TIMEOUT_MS for the analogous input.
// ---------------------------------------------------------------------------------------------------------------
const memMb = (v?: string) =>
  loadConfig({ ...BASE, ...(v === undefined ? {} : { EXECUTE_MEMORY_MB: v }) }).executeMemoryBytes / MB;
const timeoutMs = (v?: string) =>
  loadConfig({ ...BASE, ...(v === undefined ? {} : { EXECUTE_TIMEOUT_MS: v }) }).executeTimeoutMs;
type Kind = "default" | "min" | "max" | "value";
const kindOf = (x: number, lo: number, hi: number, def: number): Kind =>
  x === lo ? "min" : x === hi ? "max" : x === def ? "default" : "value";
const memKind = (v?: string) => kindOf(memMb(v), 16, 512, 64);
const tKind = (v?: string) => kindOf(timeoutMs(v), 5000, 900000, 60000);

const BIG = "9".repeat(400); // Number() -> Infinity
describe("O-16 edge: EXECUTE_MEMORY_MB parsing mirrors EXECUTE_TIMEOUT_MS", () => {
  // [label, memory input, analogous timeout input, expected MB, expected kind]
  const cases: [string, string | undefined, string | undefined, number, Kind][] = [
    ["unset", undefined, undefined, 64, "default"],
    ["lower bound", "16", "5000", 16, "min"],
    ["upper bound", "512", "900000", 512, "max"],
    ["just below lower", "15", "4999", 16, "min"],
    ["just above upper", "513", "900001", 512, "max"],
    ["one above lower", "17", "5001", 17, "value"],
    ["one below upper", "511", "899999", 511, "value"],
    ["zero", "0", "0", 16, "min"],
    ["minus zero", "-0", "-0", 16, "min"],
    ["negative", "-1", "-1", 16, "min"],
    ["letters", "abc", "abc", 64, "default"],
    ["decimal", "1.5", "1.5", 64, "default"],
    ["decimal in range", "64.0", "60000.0", 64, "default"],
    ["empty", "", "", 64, "default"],
    ["whitespace", "   ", "   ", 64, "default"],
    ["tab/newline around a value", "\t128\n", "\t120000\n", 128, "value"],
    ["inner space", "1 28", "60 000", 64, "default"],
    ["plus sign", "+64", "+60000", 64, "default"],
    ["hex", "0x40", "0xEA60", 64, "default"],
    ["exponent", "1e2", "1e5", 64, "default"],
    ["leading zeros", "0128", "0120000", 128, "value"],
    ["unit suffix", "64MB", "60000ms", 64, "default"],
    ["huge digit string", BIG, BIG, 512, "max"],
    ["huge negative digit string", "-" + BIG, "-" + BIG, 16, "min"],
    ["2^53+1 digits", "9007199254740993", "9007199254740993", 512, "max"],
  ];
  it.each(cases)("%s: memory %j vs timeout %j -> %j MB, same outcome kind", (_l, mv, tv, mb, kind) => {
    expect(memMb(mv)).toBe(mb);
    expect(Number.isInteger(memMb(mv))).toBe(true);
    expect(memKind(mv)).toBe(kind);
    expect(tKind(tv)).toBe(kind);
  });

  it("the value is always an integer number of MB in [16, 512] and a whole number of bytes", () => {
    for (const [, mv] of cases) {
      const b = loadConfig({ ...BASE, ...(mv === undefined ? {} : { EXECUTE_MEMORY_MB: mv }) }).executeMemoryBytes;
      expect(b % MB).toBe(0);
      expect(b).toBeGreaterThanOrEqual(16 * MB);
      expect(b).toBeLessThanOrEqual(512 * MB);
    }
  });

  it("EXECUTE_MEMORY_MB is independent of EXECUTE_TIMEOUT_MS and EXECUTE_MAX_CONCURRENT", () => {
    const c = loadConfig({ ...BASE, EXECUTE_MEMORY_MB: "100", EXECUTE_TIMEOUT_MS: "abc", EXECUTE_MAX_CONCURRENT: "99" });
    expect(c.executeMemoryBytes).toBe(100 * MB);
    expect(c.executeTimeoutMs).toBe(60000);
    expect(c.executeMaxConcurrent).toBe(32);
    const d = loadConfig({ ...BASE, EXECUTE_TIMEOUT_MS: "5000", EXECUTE_MAX_CONCURRENT: "1" });
    expect(d.executeMemoryBytes).toBe(64 * MB);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real sandbox runs through the MCP server.
// ---------------------------------------------------------------------------------------------------------------
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function connect(env: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "o16e-"));
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const kill = path.join(dir, "KILL");
  const cfg = { ...loadConfig({ ...BASE, ...env }), mode: "paper", risk, killSwitchFile: kill } as any;
  const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: kill, stateFile: path.join(dir, "s.json") });
  const server = createMcpServer({ cfg, client: {} as any, risk: engine, auditFile: path.join(dir, "a.jsonl") });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "o16e", version: "1" });
  await c.connect(ct);
  closers.push(() => c.close());
  return c;
}
async function call(c: Client, code: string) {
  const r: any = await c.callTool({ name: "execute", arguments: { code } });
  const txt: string = r.content[0].text;
  return JSON.parse(txt.slice(txt.indexOf("{")));
}
// Retains `n` distinct flat 1 MB strings (padStart builds a flat string; no rope sharing).
const retain = (n: number) =>
  `const a = []; for (let i = 0; i < ${n}; i++) a.push(String(i).padStart(1048576, "x")); return a.length;`;

describe("O-16 edge: real runs at the boundaries", () => {
  it("16 MB: a retained ~30 MB allocation fails with 'memory limit exceeded', and the next run is ok", async () => {
    const c = await connect({ EXECUTE_MEMORY_MB: "16" });
    const bad = await call(c, retain(30));
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("memory limit exceeded");
    const next = await call(c, "return 6 * 7;");
    expect(next.ok).toBe(true);
    expect(next.result).toBe(42);
    expect(next.error).toBeNull();
  }, 60000);

  it("15 (clamped to 16) behaves exactly like 16", async () => {
    const c = await connect({ EXECUTE_MEMORY_MB: "15" });
    const bad = await call(c, retain(30));
    expect(bad.error).toBe("memory limit exceeded");
  }, 60000);

  it("16 MB: a small retained allocation (8 MB) still passes, so 16 is usable, not just a failure mode", async () => {
    const c = await connect({ EXECUTE_MEMORY_MB: "16" });
    const out = await call(c, retain(8));
    expect(out.error).toBeNull();
    expect(out.result).toBe(8);
  }, 60000);

  it("64 MB: the same ~30 MB allocation passes", async () => {
    const c = await connect({ EXECUTE_MEMORY_MB: "64" });
    const out = await call(c, retain(30));
    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
    expect(out.result).toBe(30);
  }, 60000);

  it("unset (default 64 MB): the ~30 MB allocation passes, but ~80 MB fails", async () => {
    const c = await connect({});
    expect((await call(c, retain(30))).result).toBe(30);
    expect((await call(c, retain(80))).error).toBe("memory limit exceeded");
  }, 60000);

  // ~300 MB guest strings + up to 544 MB of WASM linear memory + Node overhead.
  const NEED = 1536 * MB;
  const enough = freemem() >= NEED;
  it.skipIf(!enough)(
    `512 MB: a 300 MB retained allocation passes (skipped when free RAM < 1.5 GB; free now ${Math.round(freemem() / MB)} MB)`,
    async () => {
      const c = await connect({ EXECUTE_MEMORY_MB: "512" });
      const out = await call(c, retain(300));
      expect(out.error).toBeNull();
      expect(out.result).toBe(300);
    },
    120000,
  );

  it.skipIf(!enough)("513 (clamped to 512): 300 MB passes, 600 MB fails with the memory error", async () => {
    const c = await connect({ EXECUTE_MEMORY_MB: "513" });
    expect((await call(c, retain(300))).result).toBe(300);
    expect((await call(c, retain(600))).error).toBe("memory limit exceeded");
  }, 180000);
});

describe("O-16 edge: the hard WASM maximum scales with EXECUTE_MEMORY_MB", () => {
  // Grows flat 1 MB strings until the sandbox stops it.
  const hostile = `const a = []; for (;;) a.push(String(a.length).padStart(1048576, "y"));`;
  it.each([16, 64, 128])("%i MB: peak <= 16 MB + memory + 16 MB, and the memory cannot grow past that", async (mb) => {
    const c = await connect({ EXECUTE_MEMORY_MB: String(mb) });
    hooks.mods.length = 0;
    const out = await call(c, hostile);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("memory limit exceeded");
    expect(hooks.mods).toHaveLength(1);
    const mem = hooks.mods[0].getWasmMemory();
    const hardMax = 16 * MB + mb * MB + 16 * MB;
    expect(mem.buffer.byteLength).toBeLessThanOrEqual(hardMax);
    // The run actually used the configured budget (it is not stuck at some smaller fixed cap).
    expect(mem.buffer.byteLength).toBeGreaterThan(mb * MB);
    // Exact maximum: growing to hardMax works, one page beyond it throws.
    const cur = mem.buffer.byteLength / PAGE;
    const maxPages = hardMax / PAGE;
    expect(() => mem.grow(maxPages - cur + 1)).toThrow(RangeError);
    expect(() => mem.grow(maxPages - cur)).not.toThrow();
    expect(mem.buffer.byteLength).toBe(hardMax);
  }, 120000);
});

describe("O-16 edge: concurrency interaction", () => {
  it("EXECUTE_MAX_CONCURRENT=2, EXECUTE_MEMORY_MB=16: two hostile runs + one normal run -> normal is ok or busy, never a crash", async () => {
    const c = await connect({ EXECUTE_MAX_CONCURRENT: "2", EXECUTE_MEMORY_MB: "16" });
    const hostile = `const a = []; for (;;) a.push(String(a.length).padStart(1048576, "z"));`;
    const [h1, h2, n] = await Promise.all([call(c, hostile), call(c, hostile), call(c, "return 1 + 1;")]);
    for (const h of [h1, h2]) {
      expect(h.ok).toBe(false);
      expect([BUSY, "memory limit exceeded"]).toContain(h.error);
    }
    // At most one of the three can be busy (two slots).
    expect([h1, h2, n].filter((r) => r.error === BUSY).length).toBeLessThanOrEqual(1);
    if (n.ok) {
      expect(n.result).toBe(2);
      expect(n.error).toBeNull();
    } else {
      expect(n.error).toBe(BUSY);
    }
    // Slots are released: afterwards a normal run is ok, and two hostile runs again hit the memory error, not busy.
    expect((await call(c, "return 3;")).result).toBe(3);
    const again = await Promise.all([call(c, hostile), call(c, hostile)]);
    for (const h of again) expect(h.error).toBe("memory limit exceeded");
  }, 120000);
});
