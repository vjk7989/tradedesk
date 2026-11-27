import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TradeOAuthProvider } from "../src/oauth/provider.js";
import { LoginLimiter } from "../src/oauth/login.js";
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
    login: (rid: string, password: string, ip = IP) =>
      fetch(base + "/login", {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip },
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


describe("TM-16 oauth follow-ups", () => {
  it("raw IPv4/IPv6 never appear in oauth.json after failed logins", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    for (const ip of ["203.0.113.7", "2001:db8::1"]) await s.login(rid, "bad", ip);
    const raw = readFileSync(path.join(dir, "oauth.json"), "utf8");
    expect(raw).toContain("loginFailures");
    expect(raw).not.toContain("203.0.113.7");
    expect(raw).not.toContain("2001:db8::1");
    expect(raw).not.toContain(sha("203.0.113.7"));
    expect(raw).not.toContain(sha("2001:db8::1"));
  });

  it("different secrets give different keys; same secret is stable", () => {
    const keys = (secret: string) => {
      const l = new LoginLimiter(secret);
      l.fail("203.0.113.7");
      return Object.keys(l.snapshot());
    };
    expect(keys("a")).not.toEqual(keys("b"));
    expect(keys("a")).toEqual(keys("a"));
  });

  it("5 failures, restart, 6th attempt is 429 (key stable across restart)", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    for (let i = 0; i < 5; i++) expect((await s.login(rid, "bad", "2001:db8::1")).status).toBe(401);
    await s.stop();
    s = await boot(dir);
    expect((await s.login(rid, "bad", "2001:db8::1")).status).toBe(429);
  });

  it("1000 unknown-code exchanges: zero persists, all rejected; HTTP /token still 400", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const id = await s.register();
    const prov = new TradeOAuthProvider({
      issuerUrl: new URL("https://mcp.example.com"), passwordHash: PW_HASH,
      allowedRedirectHosts: ["claude.ai"], stateFile: path.join(dir, "oauth.json"),
    });
    const client = { client_id: id, redirect_uris: [REDIRECT] } as any;
    const spy = vi.spyOn(TradeOAuthProvider.prototype as any, "persist");
    try {
      for (let i = 0; i < 1000; i++) {
        await expect(prov.exchangeAuthorizationCode(client, randomBytes(16).toString("hex"), "v", REDIRECT)).rejects.toThrow();
      }
      for (let i = 0; i < 3; i++) expect((await s.token(id, randomBytes(16).toString("hex"), "v".repeat(43))).status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
