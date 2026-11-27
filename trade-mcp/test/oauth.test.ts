import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";
import { loadOAuthConfig, type OAuthConfig } from "../src/oauth/config.js";

const TOKEN = "t".repeat(32);
const PASSWORD = "correct horse";
const ISSUER = "https://mcp.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function hash(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

async function start(oauth: OAuthConfig | undefined, dir: string) {
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const cfg = { mode: "paper", mcpToken: TOKEN, risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
  const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: cfg.killSwitchFile, stateFile: path.join(dir, "s.json") });
  const srv: Server = createHttpServer({ cfg, client: {} as any, risk: engine, auditFile: path.join(dir, "a.jsonl") }, oauth);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}
const stop = (srv: Server) => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });

const listTools = (base: string, token: string) =>
  fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

const b64url = (b: Buffer) => b.toString("base64url");

describe("oauth enabled", () => {
  let dir: string, srv: Server, base: string;
  const cfgFor = (d: string): OAuthConfig => ({
    issuerUrl: new URL(ISSUER),
    passwordHash: hash(PASSWORD),
    allowedRedirectHosts: ["chatgpt.com", "claude.ai", "claude.com"],
    stateFile: path.join(d, "oauth.json"),
  });
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "oauth-"));
    ({ srv, base } = await start(cfgFor(dir), dir));
  });
  afterAll(() => stop(srv));

  const register = (redirect_uris: string[]) =>
    fetch(base + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris, token_endpoint_auth_method: "none", client_name: "Test" }),
    });

  async function authorize(clientId: string, challenge: string) {
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", state: "st1",
    });
    const r = await fetch(`${base}/authorize?${q}`);
    const html = await r.text();
    return { status: r.status, rid: /name="rid" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "" };
  }
  const login = (rid: string, password: string, ip = "1.1.1.1") =>
    fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip },
      body: new URLSearchParams({ rid, password }),
    });
  const token = (params: Record<string, string>) =>
    fetch(base + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });

  async function fullFlow() {
    const reg = await (await register([REDIRECT])).json();
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const { rid } = await authorize(reg.client_id, challenge);
    const lr = await login(rid, PASSWORD);
    const loc = new URL(lr.headers.get("location")!);
    const code = loc.searchParams.get("code")!;
    const tr = await token({
      grant_type: "authorization_code", code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: REDIRECT,
    });
    return { reg, lr, loc, tr, code, verifier };
  }

  it("serves metadata", async () => {
    const as = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
    expect(as.issuer).toBe(ISSUER + "/");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(ISSUER + "/register");
    const pr = await fetch(base + "/.well-known/oauth-protected-resource/mcp");
    expect(pr.status).toBe(200);
    expect((await pr.json()).resource).toBe(ISSUER + "/mcp");
  });

  it("401 carries WWW-Authenticate with resource_metadata", async () => {
    const r = await listTools(base, "nope");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("full code + PKCE flow, then /mcp works with the access token", async () => {
    const { loc, lr, tr } = await fullFlow();
    expect(lr.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st1");
    expect(tr.status).toBe(200);
    const t = await tr.json();
    expect(t.expires_in).toBe(3600);
    const r = await listTools(base, t.access_token);
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain("execute");
  });

  it("auth code is single use and PKCE verifier is checked", async () => {
    const { reg, code, verifier } = await fullFlow();
    const again = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT });
    expect(again.status).toBe(400);
    const reg2 = await (await register([REDIRECT])).json();
    const v = b64url(randomBytes(32));
    const { rid } = await authorize(reg2.client_id, b64url(createHash("sha256").update(v).digest()));
    const c2 = new URL((await login(rid, PASSWORD)).headers.get("location")!).searchParams.get("code")!;
    const bad = await token({ grant_type: "authorization_code", code: c2, code_verifier: b64url(randomBytes(32)), client_id: reg2.client_id, redirect_uri: REDIRECT });
    expect(bad.status).toBe(400);
  });

  it("rejects plain PKCE", async () => {
    const reg = await (await register([REDIRECT])).json();
    const q = new URLSearchParams({
      response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT,
      code_challenge: "abc", code_challenge_method: "plain",
    });
    const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
    expect(await r.text()).not.toContain('name="rid"');
  });

  it("wrong password gives 401 and no redirect; 5 failures then 429", async () => {
    const reg = await (await register([REDIRECT])).json();
    const { rid } = await authorize(reg.client_id, b64url(createHash("sha256").update("v").digest()));
    for (let i = 0; i < 5; i++) {
      const r = await login(rid, "wrong", "9.9.9.9");
      expect(r.status).toBe(401);
      expect(r.headers.get("location")).toBeNull();
    }
    expect((await login(rid, "wrong", "9.9.9.9")).status).toBe(429);
    expect((await login(rid, PASSWORD, "9.9.9.9")).status).toBe(429);
  });

  it("registration rejects disallowed redirect hosts and schemes", async () => {
    expect((await register(["https://evil.example.org/cb"])).status).toBe(400);
    expect((await register(["http://claude.ai/cb"])).status).toBe(400);
    expect((await register(["https://claude.ai.evil.com/cb"])).status).toBe(400);
    expect((await register(["http://localhost:3000/cb"])).status).toBe(201);
    expect((await register(["https://chatgpt.com/connector/oauth/x"])).status).toBe(201);
  });

  it("refresh token rotates", async () => {
    const { reg, tr } = await fullFlow();
    const t = await tr.json();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id });
    expect(r1.status).toBe(200);
    const t2 = await r1.json();
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    const r2 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id });
    expect(r2.status).toBe(400);
    // replay of a rotated refresh token revokes the whole family
    expect((await listTools(base, t2.access_token)).status).toBe(401);
  });

  it("rotated access token works when the old refresh token is not replayed", async () => {
    const { reg, tr } = await fullFlow();
    const t = await tr.json();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id });
    expect(r1.status).toBe(200);
    const t2 = await r1.json();
    expect((await listTools(base, t2.access_token)).status).toBe(200);
  });

  it("static MCP_TOKEN keeps working", async () => {
    expect((await listTools(base, TOKEN)).status).toBe(200);
  });

  it("persists hashed tokens with restrictive perms", async () => {
    const { tr } = await fullFlow();
    const t = await tr.json();
    const raw = readFileSync(path.join(dir, "oauth.json"), "utf8");
    expect(raw).not.toContain(t.access_token);
    expect(raw).not.toContain(t.refresh_token);
    expect(raw).toContain(createHash("sha256").update(t.access_token).digest("hex"));
    if (process.platform !== "win32") expect(statSync(path.join(dir, "oauth.json")).mode & 0o777).toBe(0o600);
  });
});

describe("oauth disabled", () => {
  it("OAuth endpoints 404 and static token works", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oauth-off-"));
    const { srv, base } = await start(undefined, dir);
    try {
      for (const p of ["/authorize", "/token", "/register", "/revoke", "/login", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
        expect((await fetch(base + p)).status).toBe(404);
      }
      const r = await listTools(base, "x");
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBeNull();
      expect((await listTools(base, TOKEN)).status).toBe(200);
    } finally {
      await stop(srv);
    }
  });
});

describe("loadOAuthConfig", () => {
  it("is off unless OAUTH_ENABLED=1 and validates inputs", () => {
    expect(loadOAuthConfig({})).toBeUndefined();
    expect(() => loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: "http://x.com", OAUTH_PASSWORD_HASH: hash("a") })).toThrow(/https/);
    expect(() => loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: ISSUER, OAUTH_PASSWORD_HASH: "plain" })).toThrow(/OAUTH_PASSWORD_HASH/);
    const c = loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: ISSUER, OAUTH_PASSWORD_HASH: hash("a"), DATA_DIR: "/d" })!;
    expect(c.allowedRedirectHosts).toEqual(["chatgpt.com", "claude.ai", "claude.com"]);
  });
});
