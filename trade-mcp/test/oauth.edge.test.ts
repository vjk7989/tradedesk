import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";
import { loadOAuthConfig, type OAuthConfig } from "../src/oauth/config.js";
import { redirectAllowed } from "../src/oauth/provider.js";
import { verifyPassword, loginPage } from "../src/oauth/login.js";

const TOKEN = "t".repeat(32);
const PASSWORD = "correct horse";
const ISSUER = "https://mcp.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const HOSTS = ["chatgpt.com", "claude.ai", "claude.com"];

function hash(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
}
const PW_HASH = hash(PASSWORD);
const b64url = (b: Buffer) => b.toString("base64url");
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
// unique per-request client IP so the SDK's own per-IP limiters (register: 20/h) never interfere
const rndIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;

function cfgFor(dir: string, over: Partial<OAuthConfig> = {}): OAuthConfig {
  return { issuerUrl: new URL(ISSUER), passwordHash: PW_HASH, allowedRedirectHosts: HOSTS, stateFile: path.join(dir, "oauth.json"), ...over };
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

function client(base: string) {
  const listTools = (token: string) =>
    fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const register = (redirect_uris: string[], client_name = "Test") =>
    fetch(base + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": rndIp() },
      body: JSON.stringify({ redirect_uris, token_endpoint_auth_method: "none", client_name }),
    });
  const authorizeRaw = (params: Record<string, string>) =>
    fetch(`${base}/authorize?${new URLSearchParams(params)}`, { redirect: "manual", headers: { "X-Forwarded-For": rndIp() } });
  async function authorize(clientId: string, challenge: string, extra: Record<string, string> = {}) {
    const r = await authorizeRaw({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256", state: "st1", ...extra,
    });
    const html = await r.text();
    return { status: r.status, html, location: r.headers.get("location"), rid: /name="rid" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "" };
  }
  const loginRaw = (body: string, ip = "1.1.1.1") =>
    fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip },
      body,
    });
  const login = (rid: string, password: string, ip = "1.1.1.1") => loginRaw(new URLSearchParams({ rid, password }).toString(), ip);
  const token = (params: Record<string, string>) =>
    fetch(base + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": rndIp() },
      body: new URLSearchParams(params),
    });
  const revoke = (params: Record<string, string>) =>
    fetch(base + "/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": rndIp() },
      body: new URLSearchParams(params),
    });
  async function getCode(redirect = REDIRECT, ip = rndIp()) {
    const reg = await (await register([redirect])).json();
    const p = pkce();
    const { rid } = await authorize(reg.client_id, p.challenge, { redirect_uri: redirect });
    const lr = await login(rid, PASSWORD, ip);
    const code = new URL(lr.headers.get("location")!).searchParams.get("code")!;
    return { reg, code, ...p };
  }
  async function fullFlow() {
    const c = await getCode();
    const tr = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.reg.client_id, redirect_uri: REDIRECT });
    expect(tr.status).toBe(200);
    return { ...c, t: await tr.json() };
  }
  return { listTools, register, authorizeRaw, authorize, loginRaw, login, token, revoke, getCode, fullFlow };
}

afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------- unit: redirect host tricks
describe("redirectAllowed: host tricks", () => {
  const ok = (u: string) => expect(redirectAllowed(u, HOSTS), u).toBe(true);
  const no = (u: string) => expect(redirectAllowed(u, HOSTS), u).toBe(false);
  it("accepts exact and subdomain hosts, localhost/127.0.0.1 http, ports and uppercase", () => {
    ok("https://chatgpt.com/cb");
    ok("https://www.chatgpt.com/cb");
    ok("https://CHATGPT.COM/cb"); // URL lowercases host
    ok("https://chatgpt.com:443/cb");
    ok("http://localhost:3000/cb");
    ok("http://127.0.0.1:9/cb");
  });
  it("rejects suffix/prefix/userinfo/path lookalikes", () => {
    no("https://chatgpt.com.evil.com/cb");
    no("https://evilchatgpt.com/cb");
    no("https://chatgpt.com@evil.com/cb");
    no("https://user:pw@chatgpt.com/cb"); // userinfo itself rejected
    no("https://evil.com/chatgpt.com");
    no("https://evil.com/?x=https://chatgpt.com");
    no("https://evil.com#chatgpt.com");
    no("http://localhost.evil.com/cb");
    no("http://127.0.0.1.evil.com/cb");
    no("http://localhost@evil.com/cb");
  });
  it("rejects trailing dot, IDN/punycode lookalikes", () => {
    no("https://chatgpt.com./cb");
    no("https://chаtgpt.com/cb"); // Cyrillic a
    no("https://xn--chtgpt-2fg.com/cb");
    expect(redirectAllowed("https://chatgpt。com/cb", HOSTS)).toBe(true); // WHATWG URL normalises U+3002 to "." = the genuine host
  });
  it("rejects dangerous or non-https schemes", () => {
    no("javascript:alert(1)//chatgpt.com");
    no("data:text/html,<script>alert(1)</script>");
    no("http://chatgpt.com/cb");
    no("ftp://chatgpt.com/cb");
    no("file:///etc/passwd");
    no("chatgpt.com/cb");
    no("");
    no("http://[::1]:3000/cb"); // not in the AC allowlist
    no("http://0.0.0.0/cb");
  });
  it("empty allowlist rejects all https", () => {
    expect(redirectAllowed("https://chatgpt.com/cb", [])).toBe(false);
  });
});

// ---------------------------------------------------------------- unit: password + HTML escaping
describe("verifyPassword + loginPage", () => {
  it("empty, trailing-space, case and unicode", () => {
    const h = hash(PASSWORD);
    expect(verifyPassword("", h)).toBe(false);
    expect(verifyPassword(PASSWORD + " ", h)).toBe(false);
    expect(verifyPassword(" " + PASSWORD, h)).toBe(false);
    expect(verifyPassword(PASSWORD.toUpperCase(), h)).toBe(false);
    expect(verifyPassword(PASSWORD, h)).toBe(true);
    const u = "pässwörd🔑密码";
    const hu = hash(u);
    expect(verifyPassword(u, hu)).toBe(true);
    expect(verifyPassword("passwörd🔑密码", hu)).toBe(false);
  });
  it("very long password does not throw", () => {
    expect(verifyPassword("x".repeat(1024 * 1024), hash(PASSWORD))).toBe(false);
  });
  it("escapes rid, clientName and error", () => {
    const html = loginPage({ rid: `"><script>alert(1)</script>`, clientName: `<img src=x onerror=alert(1)>'"&`, error: "<b>e</b>" });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>e</b>");
    expect(html).toContain("&#60;img");
    expect(html).toContain("&#34;&#62;&#60;script");
  });
});

// ---------------------------------------------------------------- config
describe("loadOAuthConfig edges", () => {
  const H = hash("a");
  it("only exactly '1' enables", () => {
    for (const v of ["0", "true", "yes", " 1", "1 ", ""]) {
      expect(loadOAuthConfig({ OAUTH_ENABLED: v, OAUTH_ISSUER_URL: "garbage", OAUTH_PASSWORD_HASH: "x" }), v).toBeUndefined();
    }
  });
  it("issuer must be a parseable https URL", () => {
    for (const iss of ["", "mcp.example.com", "http://mcp.example.com", "ftp://x", "javascript:alert(1)"]) {
      expect(() => loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: iss, OAUTH_PASSWORD_HASH: H }), iss).toThrow(/OAUTH_ISSUER_URL/);
    }
  });
  it("password hash format boundaries", () => {
    const [, s, k] = H.split(":");
    const bad = [
      "", `scrypt:${s.slice(1)}:${k}`, `scrypt:${s}0:${k}`, `scrypt:${s}:${k.slice(1)}`, `scrypt:${s}:${k}0`,
      `scrypt:${s.toUpperCase()}:${k}`, `SCRYPT:${s}:${k}`, `scrypt:${s}:${k}\n`, `bcrypt:${s}:${k}`, `scrypt:${"g".repeat(32)}:${k}`,
    ];
    for (const b of bad) expect(() => loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: ISSUER, OAUTH_PASSWORD_HASH: b }), b).toThrow(/OAUTH_PASSWORD_HASH/);
    expect(loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: ISSUER, OAUTH_PASSWORD_HASH: H })).toBeDefined();
  });
  it("allowed hosts override is trimmed/lowercased; empty falls back to defaults; stateFile in DATA_DIR", () => {
    const c = loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: ISSUER, OAUTH_PASSWORD_HASH: H, OAUTH_ALLOWED_REDIRECT_HOSTS: " A.com , ,b.COM", DATA_DIR: "C:\\data dir" })!;
    expect(c.allowedRedirectHosts).toEqual(["a.com", "b.com"]);
    expect(c.stateFile).toBe(path.join("C:\\data dir", "oauth.json"));
    const d = loadOAuthConfig({ OAUTH_ENABLED: "1", OAUTH_ISSUER_URL: ISSUER, OAUTH_PASSWORD_HASH: H, OAUTH_ALLOWED_REDIRECT_HOSTS: "" })!;
    expect(d.allowedRedirectHosts).toEqual(HOSTS);
  });
});

// ---------------------------------------------------------------- HTTP
describe("oauth edge (http)", () => {
  let dir: string, srv: Server, base: string, c: ReturnType<typeof client>;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "oauth-edge-"));
    ({ srv, base } = await start(cfgFor(dir), dir));
    c = client(base);
  });
  afterAll(() => stop(srv));

  describe("registration", () => {
    it.each([
      "https://chatgpt.com.evil.com/cb", "https://evilchatgpt.com/cb", "https://chatgpt.com@evil.com/cb",
      "https://evil.com/chatgpt.com", "https://chatgpt.com./cb", "https://xn--chtgpt-2fg.com/cb",
      "javascript:alert(1)", "data:text/html,x", "http://chatgpt.com/cb", "http://localhost.evil.com/cb",
    ])("rejects %s", async (u) => {
      expect((await c.register([u])).status).toBe(400);
    });
    it.each(["https://CHATGPT.COM/cb", "https://chatgpt.com:8443/cb", "https://a.b.claude.com/cb", "http://127.0.0.1:1234/cb"])(
      "accepts %s", async (u) => { expect((await c.register([u])).status).toBe(201); },
    );
    it("rejects empty list and a mix of good+bad", async () => {
      expect((await c.register([])).status).toBe(400);
      expect((await c.register([REDIRECT, "https://evil.com/cb"])).status).toBe(400);
    });
  });

  describe("/authorize", () => {
    it.each([
      ["extra path", REDIRECT + "/x"],
      ["query", REDIRECT + "?a=1"],
      ["fragment", REDIRECT + "#f"],
      ["other allowed host", "https://chatgpt.com/cb"],
      ["trailing slash", REDIRECT + "/"],
    ])("rejects redirect_uri differing from registered (%s) without redirecting", async (_n, uri) => {
      const reg = await (await c.register([REDIRECT])).json();
      const r = await c.authorize(reg.client_id, pkce().challenge, { redirect_uri: uri });
      expect(r.rid).toBe("");
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.location ?? "").not.toContain("evil");
      if (r.location) expect(r.location.startsWith(uri)).toBe(false);
    });
    it("rejects PKCE plain and missing challenge", async () => {
      const reg = await (await c.register([REDIRECT])).json();
      const plain = await c.authorize(reg.client_id, "a".repeat(43), { code_challenge_method: "plain" });
      expect(plain.rid).toBe("");
      const r = await c.authorizeRaw({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge_method: "S256" });
      expect(await r.text()).not.toContain('name="rid"');
      const r2 = await c.authorizeRaw({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "abc" });
      expect(await r2.text()).not.toContain('name="rid"');
    });
    it("unknown client_id -> no login form", async () => {
      const r = await c.authorize("nope", pkce().challenge);
      expect(r.rid).toBe("");
      expect(r.status).toBe(400);
    });
    it("escapes hostile client_name in the login HTML", async () => {
      const evil = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;
      const reg = await (await c.register([REDIRECT], evil)).json();
      const r = await c.authorize(reg.client_id, pkce().challenge, { state: `"><script>alert(3)</script>` });
      expect(r.rid).not.toBe("");
      expect(r.html).not.toContain("<script>alert");
      expect(r.html).not.toContain("<img src=x");
    });
  });

  describe("/login", () => {
    it("CSRF: missing, random, or already-used rid -> 400 and no redirect", async () => {
      for (const body of ["password=" + encodeURIComponent(PASSWORD), `rid=${"0".repeat(48)}&password=x`, "rid[]=a&password=x"]) {
        const r = await c.loginRaw(body, rndIp());
        expect(r.status).toBe(400);
        expect(r.headers.get("location")).toBeNull();
      }
      const reg = await (await c.register([REDIRECT])).json();
      const { rid } = await c.authorize(reg.client_id, pkce().challenge);
      expect((await c.login(rid, PASSWORD, rndIp())).status).toBe(302);
      const again = await c.login(rid, PASSWORD, rndIp());
      expect(again.status).toBe(400);
      expect(again.headers.get("location")).toBeNull();
    });
    it("empty / trailing-space / unicode passwords rejected with 401", async () => {
      const reg = await (await c.register([REDIRECT])).json();
      const { rid } = await c.authorize(reg.client_id, pkce().challenge);
      for (const pw of ["", PASSWORD + " ", "çorrect hørse"]) {
        const r = await c.login(rid, pw, rndIp());
        expect(r.status, JSON.stringify(pw)).toBe(401);
        expect(r.headers.get("location")).toBeNull();
      }
    });
    it("1MB body is rejected and yields no code", async () => {
      const reg = await (await c.register([REDIRECT])).json();
      const { rid } = await c.authorize(reg.client_id, pkce().challenge);
      const r = await c.loginRaw(`rid=${rid}&password=${"a".repeat(1024 * 1024)}`, rndIp());
      expect(r.status).toBe(413);
      expect(r.headers.get("location")).toBeNull();
      // rid still usable afterwards
      expect((await c.login(rid, PASSWORD, rndIp())).status).toBe(302);
    });
    it("state is only echoed as a query param on the registered redirect (no open redirect)", async () => {
      const reg = await (await c.register([REDIRECT])).json();
      const { rid } = await c.authorize(reg.client_id, pkce().challenge, { state: "https://evil.com/x#&code=fake" });
      const r = await c.login(rid, PASSWORD, rndIp());
      const loc = new URL(r.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get("state")).toBe("https://evil.com/x#&code=fake");
      expect(loc.searchParams.getAll("code")).toHaveLength(1);
      expect(loc.hash).toBe("");
    });
  });

  describe("rate limit", () => {
    async function freshRid() {
      const reg = await (await c.register([REDIRECT])).json();
      return (await c.authorize(reg.client_id, pkce().challenge)).rid;
    }
    it("exactly 5 failures allowed, 6th -> 429 with Retry-After", async () => {
      const rid = await freshRid();
      const ip = rndIp();
      for (let i = 0; i < 5; i++) expect((await c.login(rid, "bad", ip)).status).toBe(401);
      const r = await c.login(rid, "bad", ip);
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("900");
    });
    it("4 failures then correct password still succeeds (boundary below limit)", async () => {
      const ip = rndIp();
      const rid = await freshRid();
      for (let i = 0; i < 4; i++) expect((await c.login(rid, "bad", ip)).status).toBe(401);
      expect((await c.login(rid, PASSWORD, ip)).status).toBe(302);
    });
    it("REPORT: successful login resets the counter (5 more failures then allowed)", async () => {
      const ip = rndIp();
      let rid = await freshRid();
      for (let i = 0; i < 4; i++) await c.login(rid, "bad", ip);
      await c.login(rid, PASSWORD, ip);
      rid = await freshRid();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await c.login(rid, "bad", ip)).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401]); // documents current reset behaviour
    });
    it("trust proxy 1: rightmost XFF entry is the key; spoofed leftmost entries do not reset it", async () => {
      const real = rndIp();
      const rid = await freshRid();
      for (let i = 0; i < 5; i++) expect((await c.login(rid, "bad", `${rndIp()}, ${rndIp()}, ${real}`)).status).toBe(401);
      expect((await c.login(rid, PASSWORD, `${rndIp()}, ${real}`)).status).toBe(429);
      expect((await c.login(rid, PASSWORD, real)).status).toBe(429);
    });
    it("window expires after 15 min (fake Date)", async () => {
      const ip = rndIp();
      const rid = await freshRid();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now());
      for (let i = 0; i < 5; i++) await c.login(rid, "bad", ip);
      expect((await c.login(rid, "bad", ip)).status).toBe(429);
      vi.setSystemTime(Date.now() + 9 * 60 * 1000); // pending rid TTL is 10min; keep it alive
      expect((await c.login(rid, "bad", ip)).status).toBe(429);
      const rid2 = await freshRid();
      vi.setSystemTime(Date.now() + 6 * 60 * 1000 + 1000);
      expect((await c.login(rid2, PASSWORD, ip)).status).toBe(302);
    });
  });

  describe("authorization code", () => {
    it("reuse refused (and second attempt does not issue a token)", async () => {
      const g = await c.getCode();
      const p = { grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, client_id: g.reg.client_id, redirect_uri: REDIRECT };
      expect((await c.token(p)).status).toBe(200);
      const r = await c.token(p);
      expect(r.status).toBe(400);
      expect((await r.json()).access_token).toBeUndefined();
    });
    it("wrong verifier refused", async () => {
      const g = await c.getCode();
      expect((await c.token({ grant_type: "authorization_code", code: g.code, code_verifier: pkce().verifier, client_id: g.reg.client_id, redirect_uri: REDIRECT })).status).toBe(400);
    });
    it("missing verifier refused", async () => {
      const g = await c.getCode();
      expect((await c.token({ grant_type: "authorization_code", code: g.code, client_id: g.reg.client_id, redirect_uri: REDIRECT })).status).toBe(400);
    });
    it("wrong client refused", async () => {
      const g = await c.getCode();
      const other = await (await c.register([REDIRECT])).json();
      expect((await c.token({ grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, client_id: other.client_id, redirect_uri: REDIRECT })).status).toBe(400);
    });
    it("wrong redirect_uri refused", async () => {
      const g = await c.getCode();
      expect((await c.token({ grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, client_id: g.reg.client_id, redirect_uri: REDIRECT + "/x" })).status).toBe(400);
    });
    it("omitted redirect_uri at /token when it was sent at /authorize is refused (RFC 6749 4.1.3)", async () => {
      const g = await c.getCode();
      expect((await c.token({ grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, client_id: g.reg.client_id })).status).toBe(400);
    });
    it("expired after 10 min; valid just before (fake Date)", async () => {
      const g1 = await c.getCode();
      const g2 = await c.getCode();
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      vi.setSystemTime(t0 + 9 * 60 * 1000 + 50 * 1000);
      expect((await c.token({ grant_type: "authorization_code", code: g1.code, code_verifier: g1.verifier, client_id: g1.reg.client_id, redirect_uri: REDIRECT })).status).toBe(200);
      vi.setSystemTime(t0 + 10 * 60 * 1000 + 1000);
      expect((await c.token({ grant_type: "authorization_code", code: g2.code, code_verifier: g2.verifier, client_id: g2.reg.client_id, redirect_uri: REDIRECT })).status).toBe(400);
    });
    it("garbage / empty code refused", async () => {
      const reg = await (await c.register([REDIRECT])).json();
      for (const code of ["", "x", "0".repeat(64)]) {
        expect((await c.token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: reg.client_id, redirect_uri: REDIRECT })).status).toBe(400);
      }
    });
  });

  describe("tokens", () => {
    it("access token is 32 random bytes (64 hex) and unique", async () => {
      const a = await c.fullFlow();
      const b = await c.fullFlow();
      expect(a.t.access_token).toMatch(/^[0-9a-f]{64}$/);
      expect(a.t.access_token).not.toBe(b.t.access_token);
      expect(a.t.refresh_token).not.toBe(a.t.access_token);
    });
    it("access token expires after 1h; valid just before (fake Date)", async () => {
      const { t } = await c.fullFlow();
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      vi.setSystemTime(t0 + 3590 * 1000);
      expect((await c.listTools(t.access_token)).status).toBe(200);
      vi.setSystemTime(t0 + 3601 * 1000);
      expect((await c.listTools(t.access_token)).status).toBe(401);
    });
    it("refresh token expires after 30d (fake Date)", async () => {
      const { t, reg } = await c.fullFlow();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 30 * 24 * 3600 * 1000 + 1000);
      expect((await c.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id })).status).toBe(400);
    });
    it("revoked access token rejected at /mcp; revoked refresh token refused", async () => {
      const { t, reg } = await c.fullFlow();
      expect((await c.revoke({ token: t.access_token, client_id: reg.client_id })).status).toBe(200);
      expect((await c.listTools(t.access_token)).status).toBe(401);
      expect((await c.revoke({ token: t.refresh_token, client_id: reg.client_id })).status).toBe(200);
      expect((await c.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id })).status).toBe(400);
    });
    it("client B cannot revoke client A's token", async () => {
      const a = await c.fullFlow();
      const b = await (await c.register([REDIRECT])).json();
      await c.revoke({ token: a.t.access_token, client_id: b.client_id });
      expect((await c.listTools(a.t.access_token)).status).toBe(200);
    });
    it("access token used as refresh refused; refresh token used as access refused", async () => {
      const { t, reg } = await c.fullFlow();
      expect((await c.token({ grant_type: "refresh_token", refresh_token: t.access_token, client_id: reg.client_id })).status).toBe(400);
      expect((await c.listTools(t.refresh_token)).status).toBe(401);
    });
    it("client A's refresh token used by client B refused, and A can still use it", async () => {
      const a = await c.fullFlow();
      const b = await (await c.register([REDIRECT])).json();
      expect((await c.token({ grant_type: "refresh_token", refresh_token: a.t.refresh_token, client_id: b.client_id })).status).toBe(400);
      expect((await c.token({ grant_type: "refresh_token", refresh_token: a.t.refresh_token, client_id: a.reg.client_id })).status).toBe(200);
    });
    it("old refresh refused after rotation", async () => {
      const { t, reg } = await c.fullFlow();
      const r1 = await c.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id });
      expect(r1.status).toBe(200);
      expect((await c.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id })).status).toBe(400);
    });
    it("OAuth 2.1 sec 4.3.1: refresh reuse after rotation revokes the whole token family", async () => {
      const { t, reg } = await c.fullFlow();
      const t2 = await (await c.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id })).json();
      await c.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id }); // replay
      expect((await c.token({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: reg.client_id })).status).toBe(400);
      expect((await c.listTools(t2.access_token)).status).toBe(401);
    });
    it("malformed Authorization headers rejected with WWW-Authenticate", async () => {
      for (const h of ["", "Bearer", "Bearer ", "bearer " + TOKEN.slice(1), "Basic " + TOKEN.slice(1)]) {
        const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: h }, body: "{}" });
        expect(r.status, h).toBe(401);
        expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
      }
    });
    it("static MCP_TOKEN path unaffected", async () => {
      expect((await c.listTools(TOKEN)).status).toBe(200);
      expect((await c.listTools(TOKEN + "x")).status).toBe(401);
    });
  });

  describe("metadata", () => {
    it("all advertised URLs are https under the issuer", async () => {
      const as = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
      for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) {
        expect(as[k], k).toMatch(new RegExp(`^${ISSUER}/`));
      }
      expect(JSON.stringify(as)).not.toContain("http://");
      expect(as.code_challenge_methods_supported).toEqual(["S256"]);
      for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const r = await fetch(base + p);
        if (r.status === 404 && p.endsWith("resource")) continue; // only /mcp variant required by SDK
        const j = await r.json();
        expect(JSON.stringify(j), p).not.toContain("http://");
        expect(j.authorization_servers?.[0]).toMatch(new RegExp(`^${ISSUER}`));
      }
    });
  });

  describe("oauth.json", () => {
    it("contains no plaintext tokens/password/password hash; perms 0600 (skipped on Windows)", async () => {
      const { t } = await c.fullFlow();
      const raw = readFileSync(path.join(dir, "oauth.json"), "utf8");
      expect(raw).not.toContain(t.access_token);
      expect(raw).not.toContain(t.refresh_token);
      expect(raw).not.toContain(PASSWORD);
      expect(raw).not.toContain(PW_HASH.split(":")[2]);
      if (process.platform !== "win32") expect(statSync(path.join(dir, "oauth.json")).mode & 0o777).toBe(0o600);
    });
    it("persisted tokens survive a restart", async () => {
      const { t } = await c.fullFlow();
      const s2 = await start(cfgFor(dir), dir);
      try {
        expect((await client(s2.base).listTools(t.access_token)).status).toBe(200);
      } finally { await stop(s2.srv); }
    });
  });
});

describe("corrupt oauth.json", () => {
  it.each(["{not json", "null", "[]", '{"access":"x"}', ""])("server starts safely with %j and grants nothing", async (content) => {
    const dir = mkdtempSync(path.join(tmpdir(), "oauth-corrupt-"));
    writeFileSync(path.join(dir, "oauth.json"), content);
    const { srv, base } = await start(cfgFor(dir), dir);
    try {
      const c = client(base);
      expect((await c.listTools("x")).status).toBe(401);
      expect((await c.listTools(TOKEN)).status).toBe(200);
      expect((await fetch(base + "/.well-known/oauth-authorization-server")).status).toBe(200);
    } finally { await stop(srv); }
  });
  it("a hashed key planted in the file is not accepted as a bearer token", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oauth-plant-"));
    const tok = "a".repeat(64);
    const h = createHash("sha256").update(tok).digest("hex");
    writeFileSync(path.join(dir, "oauth.json"), JSON.stringify({ clients: {}, refresh: {}, access: { [h]: { clientId: "c", scopes: [], expiresAt: 1 } } }));
    const { srv, base } = await start(cfgFor(dir), dir);
    try {
      expect((await client(base).listTools(tok)).status).toBe(401); // expired
      expect((await client(base).listTools(h)).status).toBe(401); // hash is not the token
    } finally { await stop(srv); }
  });
});
