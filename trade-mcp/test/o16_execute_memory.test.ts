import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import { RiskEngine } from "../src/risk/engine.js";

const MB = 1024 * 1024;
const base = { OPENALGO_URL: "http://localhost:5000", OPENALGO_API_KEY: "key-for-o16-tests-0123456789", MCP_TOKEN: "t".repeat(32) };
const mem = (v?: string) => loadConfig({ ...base, ...(v === undefined ? {} : { EXECUTE_MEMORY_MB: v }) }).executeMemoryBytes;

describe("O-16 EXECUTE_MEMORY_MB parsing (same style as EXECUTE_TIMEOUT_MS)", () => {
  it.each([
    ["16", 16], ["512", 512], ["15", 16], ["513", 512], ["-1", 16],
    ["abc", 64], ["1.5", 64], ["", 64], ["   ", 64], [" 128 ", 128],
  ])("%j -> %j MB", (v, mb) => {
    expect(mem(v)).toBe(mb * MB);
  });
  it("unset gives 64 MB", () => {
    expect(mem(undefined)).toBe(64 * MB);
  });
});

describe("O-16 execute honours EXECUTE_MEMORY_MB", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });
  async function run(memMb: string, code: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "o16-"));
    const risk = {
      allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
    };
    const kill = path.join(dir, "KILL");
    const cfg = { ...loadConfig({ ...base, EXECUTE_MEMORY_MB: memMb }), mode: "paper", risk, killSwitchFile: kill } as any;
    const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: kill, stateFile: path.join(dir, "s.json") });
    const server = createMcpServer({ cfg, client: {} as any, risk: engine, auditFile: path.join(dir, "a.jsonl") });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(ct);
    closers.push(() => c.close());
    const r: any = await c.callTool({ name: "execute", arguments: { code } });
    const txt: string = r.content[0].text;
    return JSON.parse(txt.slice(txt.indexOf("{")));
  }
  // retains 30 MB: thirty distinct 1 MB strings
  const alloc = 'const a = []; for (let i = 0; i < 30; i++) a.push(("s" + i).repeat(1048576 / 2)); return a.length;';

  it("16 MB fails a 30 MB retained allocation", async () => {
    const out = await run("16", alloc);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("memory limit exceeded");
  }, 60000);

  it("64 MB passes the same allocation", async () => {
    const out = await run("64", alloc);
    expect(out.error).toBeNull();
    expect(out.result).toBe(30);
  }, 60000);
});
