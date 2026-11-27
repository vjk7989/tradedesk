import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpServer } from "../src/http.js";
import { createMcpServer } from "../src/server.js";
import { RiskEngine } from "../src/risk/engine.js";
import { loadConfig, ConfigError, type Config } from "../src/config.js";

const FULL = "f".repeat(32);
const RO = "r".repeat(32);
let srv: Server;
let base: string;
let deps: Parameters<typeof createMcpServer>[0];

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-"));
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const cfg = { mode: "paper", mcpToken: FULL, mcpTokenReadonly: RO, risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
  const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: cfg.killSwitchFile, stateFile: path.join(dir, "s.json") });
  const client = { quotes: async () => ({ ltp: 1 }), funds: async () => ({ cash: 1 }) } as any;
  deps = { cfg, client, risk: engine, auditFile: path.join(dir, "a.jsonl") };
  srv = createHttpServer(deps, undefined);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }));

const connect = async (token: string) => {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return c;
};
const run = async (c: Client, code: string) => {
  const r: any = await c.callTool({ name: "execute", arguments: { code } });
  return JSON.parse(r.content[0].text.split("\n").slice(1).join("\n"));
};
const search = async (c: Client, query: string) => {
  const r: any = await c.callTool({ name: "search", arguments: { query } });
  return r.content[0].text as string;
};

describe("readonly scope", () => {
  it("lists tools and hides trade", async () => {
    const c = await connect(RO);
    expect((await c.listTools()).tools.map((x) => x.name).sort()).toEqual(["execute", "search"]);
    expect((await run(c, "return typeof trade")).result).toBe("undefined");
    const r = await run(c, "return await trade.place({})");
    expect(r.ok).toBe(false);
    await c.close();
  });
  it("market, account, backtest, risk namespaces exist", async () => {
    const c = await connect(RO);
    expect((await run(c, "return [typeof market, typeof account, typeof backtest, typeof risk].join()")).result).toBe("object,object,object,object");
    expect((await run(c, "return (await market.quote({symbol:'X',exchange:'NSE'})).ltp")).result).toBe(1);
    expect((await run(c, "return typeof (await risk.status())")).result).toBe("object");
    await c.close();
  });
  it("search has no trade entries", async () => {
    const c = await connect(RO);
    expect(await search(c, "")).not.toContain("trade:");
    expect(await search(c, "place order")).not.toContain("trade.");
    expect(await search(c, "trade")).not.toContain("namespace trade");
    await c.close();
  });
});

describe("full scope", () => {
  it("static token has trade", async () => {
    const c = await connect(FULL);
    expect((await run(c, "return typeof trade")).result).toBe("object");
    expect(await search(c, "")).toContain("trade:");
    await c.close();
  });
  it("stdio-style (no scope) is full", async () => {
    const server = createMcpServer(deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(b);
    expect((await run(c, "return typeof trade")).result).toBe("object");
    await c.close();
  });
  it("wrong token still 401", async () => {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { Authorization: "Bearer " + "z".repeat(32) }, body: "{}" });
    expect(r.status).toBe(401);
  });
});

describe("config", () => {
  const env = { OPENALGO_URL: "http://x", OPENALGO_API_KEY: "k", MCP_TOKEN: FULL };
  it("optional, unset by default", () => {
    expect(loadConfig(env).mcpTokenReadonly).toBeUndefined();
    expect(loadConfig({ ...env, MCP_TOKEN_READONLY: RO }).mcpTokenReadonly).toBe(RO);
  });
  it("equal to MCP_TOKEN rejected without leaking secret", () => {
    expect(() => loadConfig({ ...env, MCP_TOKEN_READONLY: FULL })).toThrow(ConfigError);
    try { loadConfig({ ...env, MCP_TOKEN_READONLY: FULL }); } catch (e) { expect(String(e)).not.toContain(FULL); }
  });
  it("short rejected", () => {
    expect(() => loadConfig({ ...env, MCP_TOKEN_READONLY: "short" })).toThrow(/at least 24/);
  });
});
