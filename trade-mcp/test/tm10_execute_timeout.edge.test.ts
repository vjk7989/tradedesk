import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { RiskEngine } from "../src/risk/engine.js";
import { API_DOCS } from "../src/sdk/api-docs.js";
import type { Config } from "../src/config.js";

const ROOT = path.resolve(__dirname, "..");
const base = { OPENALGO_URL: "http://localhost:5000", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(32) };
const timeout = (v?: string) =>
  loadConfig({ ...base, ...(v === undefined ? {} : { EXECUTE_TIMEOUT_MS: v }) }).executeTimeoutMs;

describe("TM-10 EXECUTE_TIMEOUT_MS parsing (edges)", () => {
  it.each([
    // clamp boundaries, both sides of each limit
    ["4999", 5000], ["5000", 5000], ["5001", 5001], ["899999", 899999], ["900000", 900000], ["900001", 900000],
    ["0", 5000], ["99999999999999999999", 900000],
    // non-integer -> default
    ["abc", 60000], ["", 60000], ["   ", 60000], ["12.5", 60000], ["60000ms", 60000], ["0x1000", 60000], ["+70000", 60000],
    // whitespace around an integer is trimmed
    [" 60000 ", 60000], ["\t70000\n", 70000],
    // exponent notation is not an integer literal -> default (not 100000)
    ["1e5", 60000],
    ["660000", 660000],
  ])("%j -> %j", (v, want) => {
    expect(timeout(v)).toBe(want);
  });

  it('"-1" is an integer below the floor, so it clamps to 5000 (AC: integers are clamped, only non-integers default)', () => {
    expect(timeout("-1")).toBe(5000);
  });

  it("default stays 60000 when unset", () => {
    expect(timeout(undefined)).toBe(60000);
    expect(loadConfig({ ...base }).executeTimeoutMs).toBe(60000);
  });

  it("every value lands inside [5000, 900000]", () => {
    for (const v of ["-1", "-999999", "1e5", " 60000 ", "NaN", "Infinity", "1".repeat(400)]) {
      const t = timeout(v);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(5000);
      expect(t).toBeLessThanOrEqual(900000);
    }
  });

  it("a bad EXECUTE_TIMEOUT_MS never throws, and unrelated config errors do not echo its value", () => {
    const marker = "secret-looking-ETM-value-123";
    expect(() => loadConfig({ ...base, EXECUTE_TIMEOUT_MS: marker })).not.toThrow();
    let err: unknown;
    try {
      loadConfig({ ...base, OPENALGO_URL: "not a url", EXECUTE_TIMEOUT_MS: marker });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain(marker);
  });
});

describe("TM-10 execute honours the configured timeout (deps.executeTimeoutMs)", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function connect(executeTimeoutMs: number | undefined, client: Record<string, unknown> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "tm10-edge-"));
    const risk = {
      allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
    };
    const kill = path.join(dir, "KILL");
    const cfg = { mode: "paper", risk, killSwitchFile: kill, mcpToken: "t".repeat(32), openalgoApiKey: "k".repeat(20) } as unknown as Config;
    const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: kill, stateFile: path.join(dir, "s.json") });
    const server = createMcpServer({
      cfg, client: client as any, risk: engine, auditFile: path.join(dir, "a.jsonl"),
      ...(executeTimeoutMs === undefined ? {} : { executeTimeoutMs }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(ct);
    closers.push(() => c.close());
    return c;
  }
  const exec = async (c: Client, code: string) => {
    const r: any = await c.callTool({ name: "execute", arguments: { code } });
    const txt: string = r.content[0].text;
    return { isError: !!r.isError, out: JSON.parse(txt.slice(txt.indexOf("{"))) };
  };

  it("a CPU-bound run longer than the timeout returns a timeout error", async () => {
    const c = await connect(150);
    const t0 = Date.now();
    const { isError, out } = await exec(c, "while (true) {}");
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(isError).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("timeout: execution exceeded 150ms");
  });

  it("a run awaiting a slow host call longer than the timeout returns a timeout error", async () => {
    const c = await connect(150, { funds: () => new Promise((r) => setTimeout(() => r({ status: "success" }), 1500)) });
    const t0 = Date.now();
    const { isError, out } = await exec(c, "return await account.funds();");
    expect(Date.now() - t0).toBeLessThan(1400);
    expect(isError).toBe(true);
    expect(out.error).toBe("timeout: execution exceeded 150ms");
  });

  it("a run that finishes under the timeout succeeds", async () => {
    const c = await connect(2000, { funds: () => new Promise((r) => setTimeout(() => r({ cash: 7 }), 20)) });
    const { isError, out } = await exec(c, "const f = await account.funds(); let s = 0; for (let i = 0; i < 1000; i++) s += i; return [f, s];");
    expect(isError).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
    expect(out.result).toEqual([{ cash: 7 }, 499500]);
  });
});

describe("TM-10 wiring and docs", () => {
  it("index.ts forwards cfg.executeTimeoutMs into createMcpServer deps (no exported seam; source check)", () => {
    const src = readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
    expect(src).toMatch(/executeTimeoutMs:\s*cfg\.executeTimeoutMs/);
  });

  it("walkForward doc tells the operator to set EXECUTE_TIMEOUT_MS >= 660000 and mentions client timeouts, once", () => {
    const wf = API_DOCS.find((d) => d.ns === "backtest" && d.name === "walkForward")!;
    expect(wf.doc).toMatch(/EXECUTE_TIMEOUT_MS\s*(>=|≥)\s*660000/);
    expect(wf.doc).toMatch(/client.*timeout/i);
    expect(wf.doc.split("EXECUTE_TIMEOUT_MS >= 660000").length - 1).toBe(1);
  });
});
