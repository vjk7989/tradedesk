import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";
import type { OAuthConfig } from "../src/oauth/config.js";

const TOKEN = "t".repeat(32);
const PASSWORD = "correct horse";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const IP = "9.8.7.6";
const salt = randomBytes(16);
const PW_HASH = `scrypt:${salt.toString("hex")}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
const b64url = (b: Buffer) => b.toString("base64url");

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
});

/** Starting a server on an existing dir = a process restart. */
async function boot(dir: string) {
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const cfg = { mode: "paper", mcpToken: TOKEN, risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
  const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: cfg.killSwitchFile, stateFile: path.join(dir, "s.json") });
  const oauth: OAuthConfig = {
    issuerUrl: new URL("https://mcp.example.com"),
    passwordHash: PW_HASH,
    allowedRedirectHosts: ["claude.ai"],
    stateFile: path.join(dir, "oauth.json"),
  };
  const srv = createHttpServer({ cfg, client: {} as any, risk: engine, auditFile: path.join(dir, "a.jsonl") }, oauth);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const stop = () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  return {
    base,
    stop,
    register: async () =>
      (await (await fetch(base + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "T" }),
      })).json()).client_id as string,
    authorize: async (clientId: string, challenge: string) => {
      const q = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: "S256", state: "st1",
      });
      const html = await (await fetch(`${base}/authorize?${q}`)).text();
      return /name="rid" value="([0-9a-f]+)"/.exec(html)![1];
    },
    login: (rid: string, password: string) =>
      fetch(base + "/login", {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": IP },
        body: new URLSearchParams({ rid, password }),
      }),
    token: (clientId: string, code: string, verifier: string) =>
      fetch(base + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT,
        }),
      }),
  };
}
type Srv = Awaited<ReturnType<typeof boot>>;

const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const dirOf = () => mkdtempSync(path.join(tmpdir(), "tm13-"));
const codeOf = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("code")!;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// TM-16 (owner AC change): limiter keys are HMAC-SHA256(HMAC(passwordHash, label), ip).
const ipKey = (ip: string) =>
  createHmac("sha256", createHmac("sha256", PW_HASH).update("tradedesk:login-ratelimit:v1").digest()).update(ip).digest("hex");

async function failN(s: Srv, n: number) {
  const rid = await s.authorize(await s.register(), pkce().challenge);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await s.login(rid, "bad")).status);
  return { rid, out };
}

describe("TM-13 oauth persistence", () => {
  it("restart between authorize and login: login completes", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const { verifier, challenge } = pkce();
    const rid = await s.authorize(id, challenge);
    await s.stop();
    s = await boot(dir);
    const lr = await s.login(rid, PASSWORD);
    expect(lr.status).toBe(302);
    expect((await s.token(id, codeOf(lr), verifier)).status).toBe(200);
  });

  it("restart between login and token: exchange works exactly once, also across restarts", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const { verifier, challenge } = pkce();
    const lr = await s.login(await s.authorize(id, challenge), PASSWORD);
    const code = codeOf(lr);
    await s.stop();
    s = await boot(dir);
    expect((await s.token(id, code, verifier)).status).toBe(200);
    expect((await s.token(id, code, verifier)).status).toBe(400);
    await s.stop();
    s = await boot(dir);
    expect((await s.token(id, code, verifier)).status).toBe(400);
  });

  it("5 failures, restart, 6th attempt is 429; window expiry still works", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const dir = dirOf();
    let s = await boot(dir);
    const { rid, out } = await failN(s, 5);
    expect(out).toEqual([401, 401, 401, 401, 401]);
    await s.stop();
    s = await boot(dir);
    expect((await s.login(rid, PASSWORD)).status).toBe(429); // even the right password
    await s.stop();
    vi.setSystemTime(new Date("2026-01-01T00:16:00Z")); // window over
    s = await boot(dir);
    const id = await s.register();
    const rid2 = await s.authorize(id, pkce().challenge);
    expect((await s.login(rid2, PASSWORD)).status).toBe(302);
  });

  it("oauth.json holds no raw code, rid, IP, password hash or verifier", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const id = await s.register();
    const { challenge, verifier } = pkce();
    const rid = await s.authorize(id, challenge);
    await s.login(rid, "bad");
    const raw1 = readFileSync(path.join(dir, "oauth.json"), "utf8");
    expect(JSON.parse(raw1).pending[sha(rid)]).toBeTruthy();
    const code = codeOf(await s.login(rid, PASSWORD));
    const raw = readFileSync(path.join(dir, "oauth.json"), "utf8");
    expect(JSON.parse(raw).codes[sha(code)]).toBeTruthy();
    for (const secret of [code, rid, IP, PW_HASH, PW_HASH.split(":")[2], PASSWORD, verifier]) {
      expect(raw1).not.toContain(secret);
      expect(raw).not.toContain(secret);
    }
    await s.login(await s.authorize(id, challenge), "bad");
    const d2 = JSON.parse(readFileSync(path.join(dir, "oauth.json"), "utf8"));
    expect(Object.keys(d2.loginFailures)).toEqual([ipKey(IP)]);
  });

  it("corrupt file starts empty and the static MCP_TOKEN still works", async () => {
    const dir = dirOf();
    writeFileSync(path.join(dir, "oauth.json"), "{not json");
    const s = await boot(dir);
    const r = await fetch(s.base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(r.status).toBe(200);
    expect((await s.login("deadbeef", PASSWORD)).status).toBe(400);
  });
});
