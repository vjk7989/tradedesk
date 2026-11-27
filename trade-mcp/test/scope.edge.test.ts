import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpServer } from "../src/http.js";
import { createMcpServer } from "../src/server.js";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import { RiskEngine } from "../src/risk/engine.js";
import { loadConfig, ConfigError, type Config } from "../src/config.js";
import type { OAuthConfig } from "../src/oauth/config.js";

const FULL = "F1u2L3l4".repeat(4); // 32 chars
const RO = "R0r3ad0n".repeat(4); // 32 chars
const API_KEY = "oa_secret_" + "k".repeat(30);
const bodies: string[] = []; // every /mcp response body, scanned for the readonly token at the end

const RISK = {
  allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
  maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 100, maxNotionalPerDay: 10000000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
};

interface Calls { placeOrder: number; modifyOrder: number; cancelOrder: number; closePosition: number }

function fakeClient(calls: Calls, delayMs = 0) {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    analyzerStatus: async () => ({ status: "success", data: { analyze_mode: true } }),
    quotes: async () => { await wait(); return { status: "success", data: { ltp: 100 } }; },
    depth: async () => ({ status: "success", data: {} }),
    search: async () => ({ status: "success", data: [] }),
    funds: async () => ({ status: "success", data: { cash: 1 } }),
    positions: async () => ({ status: "success", data: [] }),
    holdings: async () => ({ status: "success", data: [] }),
    orders: async () => ({ status: "success", data: [] }),
    trades: async () => ({ status: "success", data: [] }),
    placeOrder: async () => { calls.placeOrder++; return { status: "success", orderid: "O1" }; },
    modifyOrder: async () => { calls.modifyOrder++; return { status: "success", orderid: "O1" }; },
    cancelOrder: async () => { calls.cancelOrder++; return { status: "success", orderid: "O1" }; },
    closePosition: async () => { calls.closePosition++; return { status: "success" }; },
  };
}

const zero = (): Calls => ({ placeOrder: 0, modifyOrder: 0, cancelOrder: 0, closePosition: 0 });

async function start(tokens: { mcpToken: string; mcpTokenReadonly?: string }, opts: { delayMs?: number; client?: any; oauth?: OAuthConfig } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-edge-"));
  const cfg = {
    mode: "paper", ...tokens, openalgoApiKey: API_KEY, openalgoUrl: "http://127.0.0.1:1",
    risk: RISK, killSwitchFile: path.join(dir, "KILL"),
  } as unknown as Config;
  const engine = new RiskEngine(RISK, { mode: "paper", killSwitchFile: cfg.killSwitchFile, stateFile: path.join(dir, "s.json") });
  const calls = zero();
  const client = opts.client ?? fakeClient(calls, opts.delayMs);
  const deps = { cfg, client, risk: engine, auditFile: path.join(dir, "a.jsonl") };
  const srv: Server = createHttpServer(deps, opts.oauth);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return { srv, port, base: `http://127.0.0.1:${port}`, calls, deps };
}
const stop = (srv: Server) => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });

async function post(base: string, token: string | null, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, text };
}
const rpc = (method: string, params: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });

async function tool(base: string, token: string, name: string, args: unknown) {
  const r = await post(base, token, rpc("tools/call", { name, arguments: args }));
  expect(r.status).toBe(200);
  return JSON.parse(r.text).result.content[0].text as string;
}
async function exec(base: string, token: string, code: string) {
  const t = await tool(base, token, "execute", { code });
  return JSON.parse(t.split("\n").slice(1).join("\n")) as { ok: boolean; result: any; error: string | null; logs: unknown };
}

/** Raw HTTP so the Authorization header goes out byte-for-byte (fetch would normalise whitespace). */
function rawPost(port: number, authValue: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    s.on("data", (d) => (buf += d.toString("utf8")));
    s.on("error", reject);
    s.on("end", () => {
      const text = buf.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      bodies.push(text);
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), text });
    });
    s.write(
      "POST /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\n" +
        "Accept: application/json, text/event-stream\r\n" +
        `Authorization: ${authValue}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });
}

/** Returns "full" | "readonly" | 401 | other status, decided by what the sandbox actually sees. */
async function scopeVia(base: string, token: string): Promise<"full" | "readonly" | number> {
  const r = await post(base, token, rpc("tools/call", { name: "execute", arguments: { code: "return typeof trade" } }));
  if (r.status !== 200) return r.status;
  const t = JSON.parse(r.text).result.content[0].text as string;
  return JSON.parse(t.split("\n").slice(1).join("\n")).result === "object" ? "full" : "readonly";
}

const ORDER = "{symbol:'RELIANCE',exchange:'NSE',side:'BUY',quantity:1,product:'MIS',priceType:'MARKET',orderId:'O1'}";
const TRADE_DECL = /declare namespace trade|function (place|modify|cancel|closePosition)\(|\btrade\.(place|modify|cancel|closePosition)\b|^trade:/m;

describe("readonly sandbox: no route to any order function", () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => { s = await start({ mcpToken: FULL, mcpTokenReadonly: RO }); });
  afterAll(async () => {
    // the whole point: nothing in this block may ever reach the broker's order endpoints
    expect(s.calls).toEqual(zero());
    await stop(s.srv);
  });

  const attacks: [string, string][] = [
    ["trade.place", `return await trade.place(${ORDER})`],
    ["trade.modify", `return await trade.modify(${ORDER})`],
    ["trade.cancel", `return await trade.cancel({orderId:'O1'})`],
    ["trade.closePosition", `return await trade.closePosition({})`],
    ["globalThis.trade.place", `return await globalThis.trade.place(${ORDER})`],
    ["this.trade.place", `return await this.trade.place(${ORDER})`],
    ["eval('trade')", `return await eval('trade').cancel({orderId:'O1'})`],
    ["Function('return trade')()", `return await Function('return trade')().closePosition({})`],
    ["constructor of a host fn", `return await risk.status.constructor('return trade')().place(${ORDER})`],
    ["risk.__proto__.trade", `return await risk.__proto__.trade.place(${ORDER})`],
    ["market.constructor.trade", `return await market.constructor.trade.place(${ORDER})`],
    ["indirect eval", `const e = eval; return await e('globalThis')['tr'+'ade'].place(${ORDER})`],
    ["with(globalThis)", `return await (new Function('with(globalThis){return trade}'))().place(${ORDER})`],
    ["dynamic import", `const m = await import('trade'); return await m.place(${ORDER})`],
  ];
  it.each(attacks)("%s fails and places nothing", async (_n, code) => {
    const before = { ...s.calls };
    const r = await exec(s.base, RO, code);
    expect(r.ok).toBe(false);
    expect(s.calls).toEqual(before);
  });

  it("typeof probes all report undefined", async () => {
    const r = await exec(s.base, RO, `return [
      typeof trade, typeof globalThis.trade, typeof globalThis['trade'],
      typeof eval('typeof trade') === 'string' ? eval('typeof trade') : 'x',
      typeof Function('return this')().trade,
      'trade' in globalThis,
      Object.prototype.hasOwnProperty.call(globalThis, 'trade'),
    ]`);
    expect(r.ok).toBe(true);
    expect(r.result).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", false, false]);
  });

  it("Object.getOwnPropertyNames(globalThis) has no trade", async () => {
    const r = await exec(s.base, RO, "return Object.getOwnPropertyNames(globalThis)");
    expect(r.ok).toBe(true);
    expect(r.result).not.toContain("trade");
    expect(r.result).toEqual(expect.arrayContaining(["market", "account", "backtest", "risk"]));
  });

  it("graph walk from globalThis (own props, prototypes, constructors) finds no order function", async () => {
    const r = await exec(s.base, RO, `
      const bad = new Set(['trade','place','modify','cancel','closePosition']);
      const seen = new Set(); const hits = []; const q = [[globalThis, 'globalThis', 0]];
      while (q.length) {
        const [o, p, d] = q.shift();
        if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o) || d > 4) continue;
        seen.add(o);
        let keys = [];
        try { keys = Reflect.ownKeys(o); } catch {}
        for (const k of keys) {
          const ks = String(k);
          if (bad.has(ks)) hits.push(p + '.' + ks);
          let v; try { v = o[k]; } catch { continue; }
          q.push([v, p + '.' + ks, d + 1]);
        }
        try { q.push([Object.getPrototypeOf(o), p + '.__proto__', d + 1]); } catch {}
      }
      return { hits, visited: seen.size };`);
    expect(r.ok).toBe(true);
    expect(r.result.hits).toEqual([]);
    expect(r.result.visited).toBeGreaterThan(20); // the walk really ran
  });

  it("non-trade functions called with order-shaped args never reach an order endpoint", async () => {
    const r = await exec(s.base, RO, `
      const o = ${ORDER}; const out = [];
      for (const f of [account.funds, account.positions, account.holdings, account.orders, account.trades,
                       market.quote, market.depth, market.search, risk.status, backtest.run]) {
        try { await f(o); out.push('ok'); } catch (e) { out.push('err'); }
        try { await f.call({ place: 1 }, { ...o, action: 'place', method: 'placeOrder' }); } catch {}
      }
      return out.length;`);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(10);
  });

  it("defining a fake global trade in one run does not leak into the next", async () => {
    await exec(s.base, RO, "globalThis.trade = { place: () => 'x' }; return 1");
    expect((await exec(s.base, RO, "return typeof trade")).result).toBe("undefined");
  });

  it("tools/list still has only search and execute", async () => {
    const r = await post(s.base, RO, rpc("tools/list", {}));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).result.tools.map((t: any) => t.name).sort()).toEqual(["execute", "search"]);
  });
});

describe("readonly: search omits trade.*", () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => { s = await start({ mcpToken: FULL, mcpTokenReadonly: RO }); });
  afterAll(() => stop(s.srv));

  it.each(["", "   ", "trade", "place", "modify", "cancel", "closePosition", "order", "kill switch", "TRADE PLACE"])(
    "search(%j) has no trade declarations",
    async (q) => {
      const out = await tool(s.base, RO, "search", { query: q });
      expect(out).not.toMatch(TRADE_DECL);
      expect(out).not.toMatch(/Square off|Place an order/);
    },
  );
  it("search('') still lists the other namespaces", async () => {
    const out = await tool(s.base, RO, "search", { query: "" });
    for (const ns of ["market:", "account:", "backtest:", "risk:"]) expect(out).toContain(ns);
  });
  it("full token search('') and search('place') do list trade", async () => {
    expect(await tool(s.base, FULL, "search", { query: "" })).toMatch(/^trade: place, modify, cancel, closePosition/m);
    expect(await tool(s.base, FULL, "search", { query: "place" })).toContain("declare namespace trade");
  });
  it("searchApi unit: readonly never returns a trade entry for any token in the docs", () => {
    for (const q of ["", "trade", "place", "modify", "cancel", "closeposition", "a", "e", "order"]) {
      expect(searchApi(q, "readonly")).not.toMatch(TRADE_DECL);
    }
    expect(searchApi("place")).toContain("declare namespace trade"); // default stays full
  });
});

describe("createBindings unit", () => {
  const mk = (scope?: "full" | "readonly") => {
    const dir = mkdtempSync(path.join(tmpdir(), "scope-b-"));
    const engine = new RiskEngine(RISK, { mode: "paper", killSwitchFile: path.join(dir, "KILL"), stateFile: path.join(dir, "s.json") });
    const cfg = { mode: "paper", mcpToken: FULL, risk: RISK, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
    return createBindings({ cfg, client: fakeClient(zero()) as any, risk: engine, auditFile: path.join(dir, "a.jsonl"), scope }, { id: "r" });
  };
  it("readonly object has no trade key, own or inherited", () => {
    const b = mk("readonly") as Record<string, unknown>;
    expect("trade" in b).toBe(false);
    expect(Object.keys(b).sort()).toEqual(["account", "backtest", "market", "risk"]);
  });
  it("full and undefined scope keep trade", () => {
    expect(Object.keys(mk("full"))).toContain("trade");
    expect(Object.keys(mk(undefined))).toContain("trade");
  });
});

describe("readonly: allowed namespaces work, token is redacted", () => {
  let s: Awaited<ReturnType<typeof start>>;
  const calls = zero();
  beforeAll(async () => {
    const base = fakeClient(calls);
    // upstream that echoes the readonly token in data and in errors
    s = await start({ mcpToken: FULL, mcpTokenReadonly: RO }, {
      client: { ...base, holdings: async () => ({ echo: "tok=" + RO }), funds: async () => { throw new Error("bad auth " + RO); } },
    });
  });
  afterAll(async () => { expect(calls).toEqual(zero()); await stop(s.srv); });

  it("market / account / risk / backtest reachable", async () => {
    expect((await exec(s.base, RO, "return (await market.quote({symbol:'X',exchange:'NSE'})).data.ltp")).result).toBe(100);
    expect((await exec(s.base, RO, "return (await account.orders()).status")).result).toBe("success");
    expect((await exec(s.base, RO, "return (await risk.status()).mode")).result).toBe("paper");
    const bt = await exec(s.base, RO, "return await backtest.run({code:'x',symbols:['A'],start:'2024-01-01',end:'2024-02-01'})");
    expect(bt.ok).toBe(false);
    expect(bt.error).toContain("backtest service not configured"); // reachable, just not configured
  });
  it("readonly token is redacted from results, errors and logs", async () => {
    const a = await tool(s.base, RO, "execute", { code: "return await account.holdings()" });
    const b = await tool(s.base, RO, "execute", { code: "return await account.funds()" });
    const c = await tool(s.base, RO, "execute", { code: `console.log(${JSON.stringify(RO)}); return ${JSON.stringify(RO)}` });
    const d = await tool(s.base, RO, "search", { query: RO });
    for (const t of [a, b, c, d]) expect(t).not.toContain(RO);
    expect(a + b + c).toContain("[redacted]");
  });
  it("redacted under the full token too", async () => {
    const t = await tool(s.base, FULL, "execute", { code: "return await account.holdings()" });
    expect(t).not.toContain(RO);
  });
});

describe("token variations never yield full scope wrongly", () => {
  const body = JSON.stringify(rpc("tools/call", { name: "execute", arguments: { code: "return typeof trade" } }));
  const scopeOfRaw = async (port: number, auth: string) => {
    const r = await rawPost(port, auth, body);
    if (r.status !== 200) return r.status;
    const t = JSON.parse(r.text).result.content[0].text as string;
    return JSON.parse(t.split("\n").slice(1).join("\n")).result === "object" ? "full" : "readonly";
  };

  it("readonly token with trailing / leading whitespace in the header: readonly or 401", async () => {
    const s = await start({ mcpToken: FULL, mcpTokenReadonly: RO });
    try {
      for (const auth of [`Bearer ${RO} `, `Bearer ${RO}\t`, `Bearer  ${RO}`, `Bearer ${RO}x`, `Bearer ${RO.slice(0, -1)}`, `bearer ${RO}`, RO]) {
        const sc = await scopeOfRaw(s.port, auth);
        expect(sc === "readonly" || sc === 401, `${JSON.stringify(auth)} -> ${sc}`).toBe(true);
      }
      expect(s.calls).toEqual(zero());
    } finally { await stop(s.srv); }
  });

  it("readonly is a prefix of MCP_TOKEN", async () => {
    const s = await start({ mcpToken: RO + "EXTRA", mcpTokenReadonly: RO });
    try {
      expect(await scopeVia(s.base, RO)).toBe("readonly");
      expect(await scopeVia(s.base, RO + "EXTRA")).toBe("full");
      expect(await scopeVia(s.base, RO + "EXTR")).toBe(401);
      expect(await scopeVia(s.base, RO.slice(0, -1))).toBe(401);
    } finally { await stop(s.srv); }
  });

  it("MCP_TOKEN is a prefix of readonly", async () => {
    const s = await start({ mcpToken: FULL, mcpTokenReadonly: FULL + "SUFFIX" });
    try {
      expect(await scopeVia(s.base, FULL + "SUFFIX")).toBe("readonly");
      expect(await scopeVia(s.base, FULL)).toBe("full");
      expect(await scopeVia(s.base, FULL + "SUFFI")).toBe(401);
      expect(await scopeVia(s.base, FULL + "SUFFIXX")).toBe(401);
    } finally { await stop(s.srv); }
  });

  it("readonly configured with surrounding spaces is never full", async () => {
    const s = await start({ mcpToken: FULL, mcpTokenReadonly: ` ${RO} ` });
    try {
      for (const t of [RO, ` ${RO} `]) {
        const sc = await scopeVia(s.base, t);
        expect(sc === "readonly" || sc === 401).toBe(true);
      }
    } finally { await stop(s.srv); }
  });

  it("missing / empty / wrong auth is 401 and does not echo the readonly token", async () => {
    const s = await start({ mcpToken: FULL, mcpTokenReadonly: RO });
    try {
      for (const tok of [null, "", " ", "z".repeat(32), RO.toLowerCase(), RO.toUpperCase()]) {
        const r = await post(s.base, tok, rpc("tools/list", {}));
        expect(r.status, String(tok)).toBe(401);
        expect(r.text).not.toContain(RO);
      }
    } finally { await stop(s.srv); }
  });
});

describe("readonly unset: behaviour unchanged", () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => { s = await start({ mcpToken: FULL }); });
  afterAll(() => stop(s.srv));
  it("full token is full, any other token 401", async () => {
    expect(await scopeVia(s.base, FULL)).toBe("full");
    expect(await scopeVia(s.base, RO)).toBe(401);
    expect((await post(s.base, "", rpc("tools/list", {}))).status).toBe(401);
  });
  it("search lists trade", async () => {
    expect(await tool(s.base, FULL, "search", { query: "" })).toContain("trade:");
  });
  it("trade.cancel reaches the client under full scope (positive control for the counters)", async () => {
    const r = await exec(s.base, FULL, "return await trade.cancel({orderId:'O1'})");
    expect(r.ok).toBe(true);
    expect(s.calls.cancelOrder).toBe(1);
  });
});

describe("stdio is full", () => {
  it("createMcpServer without scope exposes trade even when a readonly token is configured", async () => {
    const s = await start({ mcpToken: FULL, mcpTokenReadonly: RO });
    try {
      const server = createMcpServer(s.deps as any);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const c = new Client({ name: "t", version: "1" });
      await c.connect(b);
      const r: any = await c.callTool({ name: "execute", arguments: { code: "return typeof trade" } });
      expect(JSON.parse(r.content[0].text.split("\n").slice(1).join("\n")).result).toBe("object");
      await c.close();
    } finally { await stop(s.srv); }
  });
});

describe("concurrency: per-request scope", () => {
  it("interleaved readonly and full requests each see their own scope", async () => {
    const s = await start({ mcpToken: FULL, mcpTokenReadonly: RO }, { delayMs: 30 });
    try {
      // each run awaits a slow host call before reporting, so requests overlap inside the server
      const code = "await market.quote({symbol:'X',exchange:'NSE'}); return typeof trade";
      const jobs = Array.from({ length: 16 }, (_, i) => (i % 2 ? RO : FULL)).map(async (tok) => ({
        tok, r: await exec(s.base, tok, code),
      }));
      const out = await Promise.all(jobs);
      for (const { tok, r } of out) {
        expect(r.ok).toBe(true);
        expect(r.result).toBe(tok === FULL ? "object" : "undefined");
      }
      const [ro, full] = await Promise.all([tool(s.base, RO, "search", { query: "place" }), tool(s.base, FULL, "search", { query: "place" })]);
      expect(ro).not.toMatch(TRADE_DECL);
      expect(full).toContain("declare namespace trade");
      expect(s.calls).toEqual(zero());
      // the shared deps object was not mutated by a request
      expect((s.deps as any).scope).toBeUndefined();
    } finally { await stop(s.srv); }
  });
});

describe("config: MCP_TOKEN_READONLY", () => {
  const env = { OPENALGO_URL: "http://x", OPENALGO_API_KEY: "k", MCP_TOKEN: FULL };
  const errOf = (e: Record<string, string>) => { try { loadConfig({ ...env, ...e }); } catch (x) { return x; } return undefined; };

  it("24 trimmed chars accepted, 23 rejected (both sides of the limit)", () => {
    expect(loadConfig({ ...env, MCP_TOKEN_READONLY: "a".repeat(24) }).mcpTokenReadonly).toBeDefined();
    expect(errOf({ MCP_TOKEN_READONLY: "a".repeat(23) })).toBeInstanceOf(ConfigError);
  });
  it("padding with whitespace does not satisfy the length limit", () => {
    expect(errOf({ MCP_TOKEN_READONLY: "  " + "a".repeat(23) + "  " })).toBeInstanceOf(ConfigError);
  });
  it("empty / whitespace-only means unset", () => {
    expect(loadConfig({ ...env, MCP_TOKEN_READONLY: "" }).mcpTokenReadonly).toBeUndefined();
    expect(loadConfig({ ...env, MCP_TOKEN_READONLY: "   " }).mcpTokenReadonly).toBeUndefined();
  });
  it("equal to MCP_TOKEN but with different surrounding whitespace is a ConfigError", () => {
    for (const v of [` ${FULL}`, `${FULL} `, `\t${FULL}\n`]) {
      const x = errOf({ MCP_TOKEN_READONLY: v });
      expect(x, JSON.stringify(v)).toBeInstanceOf(ConfigError);
      expect(String((x as Error).message)).not.toContain(FULL);
    }
    expect(errOf({ MCP_TOKEN: ` ${FULL} `, MCP_TOKEN_READONLY: FULL })).toBeInstanceOf(ConfigError);
  });
  it("errors never contain either token", () => {
    for (const e of [
      { MCP_TOKEN_READONLY: FULL },
      { MCP_TOKEN_READONLY: "s3cretShort" },
    ]) {
      const x = errOf(e);
      expect(x).toBeInstanceOf(ConfigError);
      expect(String((x as Error).message) + String((x as Error).stack)).not.toContain(FULL);
      expect(String((x as Error).message)).not.toContain("s3cretShort");
    }
  });
});

describe("OAuth access token is full scope", () => {
  const ISSUER = "https://mcp.example.com";
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  const PASSWORD = "correct horse";
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scope-oauth-"));
    const salt = randomBytes(16);
    s = await start({ mcpToken: FULL, mcpTokenReadonly: RO }, {
      oauth: {
        issuerUrl: new URL(ISSUER),
        passwordHash: `scrypt:${salt.toString("hex")}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`,
        allowedRedirectHosts: ["claude.ai"],
        stateFile: path.join(dir, "oauth.json"),
      } as OAuthConfig,
    });
  });
  afterAll(() => stop(s.srv));

  it("access token -> trade present; readonly token still readonly with OAuth enabled", async () => {
    const b64 = (b: Buffer) => b.toString("base64url");
    const reg = await (await fetch(s.base + "/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "T" }),
    })).json();
    const verifier = b64(randomBytes(32));
    const q = new URLSearchParams({
      response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT,
      code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state: "s",
    });
    const rid = /name="rid" value="([0-9a-f]+)"/.exec(await (await fetch(`${s.base}/authorize?${q}`)).text())![1];
    const lr = await fetch(s.base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "2.2.2.2" },
      body: new URLSearchParams({ rid, password: PASSWORD }),
    });
    const code = new URL(lr.headers.get("location")!).searchParams.get("code")!;
    const tr = await (await fetch(s.base + "/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT }),
    })).json();
    expect(await scopeVia(s.base, tr.access_token)).toBe("full");
    expect(await scopeVia(s.base, RO)).toBe("readonly");
    expect(await scopeVia(s.base, "not-a-token")).toBe(401);
  });
});

describe("readonly token never in any response body", () => {
  it("scanned every /mcp body collected above", () => {
    expect(bodies.length).toBeGreaterThan(50);
    for (const b of bodies) expect(b).not.toContain(RO);
  });
});
