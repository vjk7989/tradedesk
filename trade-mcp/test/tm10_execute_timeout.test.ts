import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const base = { OPENALGO_URL: "http://localhost:5000", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(32) };
const timeout = (v?: string) => loadConfig({ ...base, ...(v === undefined ? {} : { EXECUTE_TIMEOUT_MS: v }) }).executeTimeoutMs;

describe("EXECUTE_TIMEOUT_MS config", () => {
  it.each([
    ["4999", 5000], ["5000", 5000], ["900000", 900000], ["900001", 900000],
    ["abc", 60000], ["", 60000], ["12.5", 60000], [" 70000 ", 70000], [undefined, 60000],
  ])("%j -> %j", (v, want) => {
    expect(timeout(v as string | undefined)).toBe(want);
  });
});

describe("execute timeout at runtime", () => {
  it("deps.executeTimeoutMs bounds an infinite loop", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tm10-"));
    const risk = {
      allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
    };
    const kill = path.join(dir, "KILL");
    const cfg = { mode: "paper", risk, killSwitchFile: kill } as unknown as Config;
    const engine = new RiskEngine(risk as any, { mode: "paper", killSwitchFile: kill, stateFile: path.join(dir, "s.json") });
    // index.ts forwards cfg.executeTimeoutMs into these deps (no seam in index.ts: main() is not exported).
    const server = createMcpServer({ cfg, client: {} as any, risk: engine, auditFile: path.join(dir, "a.jsonl"), executeTimeoutMs: 50 });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(ct);
    const t0 = Date.now();
    const r: any = await c.callTool({ name: "execute", arguments: { code: "while(true){}" } });
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(JSON.stringify(r)).toMatch(/time|interrupt/i);
    await c.close();
  });
});
