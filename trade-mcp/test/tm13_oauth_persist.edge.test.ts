import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const PW_HEX = scryptSync(PASSWORD, salt, 64).toString("hex");
const PW_HASH = `scrypt:${salt.toString("hex")}:${PW_HEX}`;
const b64url = (b: Buffer) => b.toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// TM-16 (owner AC change): limiter keys are HMAC-SHA256(HMAC(passwordHash, label), ip).
const ipKey = (ip: string) =>
  createHmac("sha256", createHmac("sha256", PW_HASH).update("tradedesk:login-ratelimit:v1").digest()).update(ip).digest("hex");
const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const MIN = 60_000;

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
});

/** Starting a server on an existing dir = a process restart. `oauthOn=false` boots with OAuth disabled. */
async function boot(dir: string, oauthOn = true) {
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const cfg = { mode: "paper", mcpToken: TOKEN, risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
  const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: cfg.killSwitchFile, stateFile: path.join(dir, "s.json") });
  const oauth: OAuthConfig | undefined = oauthOn
    ? {
        issuerUrl: new URL("https://mcp.example.com"),
        passwordHash: PW_HASH,
        allowedRedirectHosts: ["claude.ai"],
        stateFile: path.join(dir, "oauth.json"),
      }
    : undefined;
  const srv = createHttpServer({ cfg, client: {} as any, risk: engine, auditFile: path.join(dir, "a.jsonl") }, oauth);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const stop = () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  const form = (p: string, body: Record<string, string>, ip = IP) =>
    fetch(base + p, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip },
      body: new URLSearchParams(body),
    });
  return {
    base,
    stop,
    registerRaw: () =>
      fetch(base + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "T" }),
      }),
    register: async () =>
      (await (await fetch(base + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "T" }),
      })).json()).client_id as string,
    authorizeRaw: (clientId: string, challenge: string) => {
      const q = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: "S256", state: "st1",
      });
      return fetch(`${base}/authorize?${q}`, { redirect: "manual" });
    },
    authorize: async (clientId: string, challenge: string) => {
      const q = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: "S256", state: "st1",
      });
      const html = await (await fetch(`${base}/authorize?${q}`)).text();
      return /name="rid" value="([0-9a-f]+)"/.exec(html)![1];
    },
    login: (rid: string, password: string, ip = IP) => form("/login", { rid, password }, ip),
    token: (clientId: string, code: string, verifier: string) =>
      form("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
    refresh: (clientId: string, rt: string) => form("/token", { grant_type: "refresh_token", refresh_token: rt, client_id: clientId }),
    mcp: (bearer: string) =>
      fetch(base + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
  };
}
type Srv = Awaited<ReturnType<typeof boot>>;

const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const dirOf = () => mkdtempSync(path.join(tmpdir(), "tm13e-"));
const codeOf = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("code")!;
const stateFile = (dir: string) => path.join(dir, "oauth.json");
const readState = (dir: string) => JSON.parse(readFileSync(stateFile(dir), "utf8"));
const fakeDate = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};

/** Full flow on one server; returns the tokens. */
async function fullFlow(s: Srv) {
  const id = await s.register();
  const { verifier, challenge } = pkce();
  const lr = await s.login(await s.authorize(id, challenge), PASSWORD);
  const tr = await s.token(id, codeOf(lr), verifier);
  expect(tr.status).toBe(200);
  return { id, t: (await tr.json()) as { access_token: string; refresh_token: string } };
}

describe("TM-13 edge: restart at every step", () => {
  it("restart after register, authorize, login, token and refresh: flow keeps working", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    await s.stop(); s = await boot(dir); // after register
    const { verifier, challenge } = pkce();
    const rid = await s.authorize(id, challenge);
    await s.stop(); s = await boot(dir); // after authorize
    const lr = await s.login(rid, PASSWORD);
    expect(lr.status).toBe(302);
    expect(new URL(lr.headers.get("location")!).searchParams.get("state")).toBe("st1");
    const code = codeOf(lr);
    await s.stop(); s = await boot(dir); // after login
    const tr = await s.token(id, code, verifier);
    expect(tr.status).toBe(200);
    const t = (await tr.json()) as { access_token: string; refresh_token: string };
    await s.stop(); s = await boot(dir); // after token
    expect((await s.mcp(t.access_token)).status).toBe(200);
    const rr = await s.refresh(id, t.refresh_token);
    expect(rr.status).toBe(200);
    const t2 = (await rr.json()) as { access_token: string; refresh_token: string };
    await s.stop(); s = await boot(dir); // after refresh
    expect((await s.mcp(t2.access_token)).status).toBe(200);
    expect((await s.refresh(id, t2.refresh_token)).status).toBe(200);
  });

  it("rid is single-use across restart: a consumed rid cannot log in again after restart", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const rid = await s.authorize(id, pkce().challenge);
    expect((await s.login(rid, PASSWORD)).status).toBe(302);
    await s.stop(); s = await boot(dir);
    expect((await s.login(rid, PASSWORD)).status).toBe(400);
  });

  it("PKCE still enforced after restart: wrong verifier refused", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const { challenge } = pkce();
    const code = codeOf(await s.login(await s.authorize(id, challenge), PASSWORD));
    await s.stop(); s = await boot(dir);
    expect((await s.token(id, code, pkce().verifier)).status).toBe(400);
  });

  it("persisted code is bound to its client after restart", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const other = await s.register();
    const { verifier, challenge } = pkce();
    const code = codeOf(await s.login(await s.authorize(id, challenge), PASSWORD));
    await s.stop(); s = await boot(dir);
    expect((await s.token(other, code, verifier)).status).toBe(400);
  });
});

describe("TM-13 edge: code single use and races", () => {
  it("two concurrent /token with the same code on one server: exactly one succeeds", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const id = await s.register();
    const { verifier, challenge } = pkce();
    const code = codeOf(await s.login(await s.authorize(id, challenge), PASSWORD));
    const rs = await Promise.all([s.token(id, code, verifier), s.token(id, code, verifier)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it("/token in flight while the process restarts, then /token on the new process: at most one succeeds", async () => {
    const dir = dirOf();
    const a = await boot(dir);
    const id = await a.register();
    const { verifier, challenge } = pkce();
    const code = codeOf(await a.login(await a.authorize(id, challenge), PASSWORD));
    const first = a.token(id, code, verifier).then((r) => r.status, () => 0);
    await a.stop();
    const b = await boot(dir);
    const st1 = await first;
    const st2 = (await b.token(id, code, verifier)).status;
    expect([st1, st2].filter((x) => x === 200).length).toBeLessThanOrEqual(1);
    if (st1 === 200) expect(st2).toBe(400);
  });

  // documented limit: single process per DATA_DIR (owner ruling 2026-11-27)
  it.skip("old and new process overlap on one DATA_DIR: concurrent /token with the same code, exactly one succeeds", async () => {
    // old process still serving while the new one has loaded oauth.json (e.g. restart with overlap)
    const dir = dirOf();
    const a = await boot(dir);
    const id = await a.register();
    const { verifier, challenge } = pkce();
    const code = codeOf(await a.login(await a.authorize(id, challenge), PASSWORD));
    const b = await boot(dir);
    const rs = await Promise.all([a.token(id, code, verifier), b.token(id, code, verifier)]);
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
  });
});

describe("TM-13 edge: expiry on load (fake Date)", () => {
  it("pending login: 1 ms before 10 min still completes after restart", async () => {
    fakeDate(T0);
    const dir = dirOf();
    let s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    await s.stop();
    vi.setSystemTime(T0 + 10 * MIN - 1);
    s = await boot(dir);
    expect((await s.login(rid, PASSWORD)).status).toBe(302);
  });

  it("pending login: at 10 min it is dropped on load and not written back", async () => {
    fakeDate(T0);
    const dir = dirOf();
    let s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    expect(readState(dir).pending[sha(rid)]).toBeTruthy();
    await s.stop();
    vi.setSystemTime(T0 + 10 * MIN);
    s = await boot(dir);
    expect((await s.login(rid, PASSWORD)).status).toBe(400);
    await s.register(); // forces a persist
    expect(readState(dir).pending[sha(rid)]).toBeUndefined();
  });

  it("code: 1 ms before 10 min exchanges after restart; at 10 min it is dropped and refused", async () => {
    fakeDate(T0);
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const p1 = pkce();
    const p2 = pkce();
    const c1 = codeOf(await s.login(await s.authorize(id, p1.challenge), PASSWORD));
    const c2 = codeOf(await s.login(await s.authorize(id, p2.challenge), PASSWORD));
    await s.stop();
    vi.setSystemTime(T0 + 10 * MIN - 1);
    s = await boot(dir);
    expect((await s.token(id, c1, p1.verifier)).status).toBe(200);
    await s.stop();
    vi.setSystemTime(T0 + 10 * MIN);
    s = await boot(dir);
    expect((await s.token(id, c2, p2.verifier)).status).toBe(400);
    await s.register(); // forces a persist; pruned entry must not be written back
    expect(readState(dir).codes[sha(c2)]).toBeUndefined();
  });
});

describe("TM-13 edge: rate limit across restart", () => {
  it("failures accumulate across restarts: 3, restart, 2, restart, then 429", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    let rid = await s.authorize(id, pkce().challenge);
    for (let i = 0; i < 3; i++) expect((await s.login(rid, "bad")).status).toBe(401);
    await s.stop(); s = await boot(dir);
    rid = await s.authorize(id, pkce().challenge);
    for (let i = 0; i < 2; i++) expect((await s.login(rid, "bad")).status).toBe(401);
    await s.stop(); s = await boot(dir);
    rid = await s.authorize(id, pkce().challenge);
    expect((await s.login(rid, PASSWORD)).status).toBe(429);
  });

  it("4 failures then restart: 5th attempt is still allowed (boundary below the limit)", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const rid = await s.authorize(id, pkce().challenge);
    for (let i = 0; i < 4; i++) await s.login(rid, "bad");
    await s.stop(); s = await boot(dir);
    expect((await s.login(rid, "bad")).status).toBe(401);
    expect((await s.login(rid, PASSWORD)).status).toBe(429);
  });

  it("block holds 1 ms before 15 min across restart and lifts at 15 min", async () => {
    fakeDate(T0);
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const rid = await s.authorize(id, pkce().challenge);
    for (let i = 0; i < 5; i++) await s.login(rid, "bad");
    await s.stop();
    vi.setSystemTime(T0 + 15 * MIN - 1);
    s = await boot(dir);
    const rid2 = await s.authorize(id, pkce().challenge);
    expect((await s.login(rid2, PASSWORD)).status).toBe(429);
    await s.stop();
    vi.setSystemTime(T0 + 15 * MIN);
    s = await boot(dir);
    expect((await s.login(rid2, PASSWORD)).status).toBe(302);
  });

  it("limit is per IP after restart: another IP is not blocked", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const rid = await s.authorize(id, pkce().challenge);
    for (let i = 0; i < 5; i++) await s.login(rid, "bad");
    await s.stop(); s = await boot(dir);
    expect((await s.login(rid, PASSWORD, "1.1.1.1")).status).toBe(302);
  });

  it("expired counters are dropped on load and not written back", async () => {
    fakeDate(T0);
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const rid = await s.authorize(id, pkce().challenge);
    await s.login(rid, "bad", "5.5.5.5");
    expect(readState(dir).loginFailures[ipKey("5.5.5.5")]).toHaveLength(1);
    await s.stop();
    vi.setSystemTime(T0 + 16 * MIN);
    s = await boot(dir);
    await s.register(); // forces a persist
    expect(readState(dir).loginFailures[ipKey("5.5.5.5")]).toBeUndefined();
  });
});

describe("TM-13 edge: oauth.json content and file", () => {
  it("after the full flow incl. refresh, the file holds no raw code, rid, IP, verifier, password, password hash, salt or tokens", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const id = await s.register();
    const { verifier, challenge } = pkce();
    const rid = await s.authorize(id, challenge);
    await s.login(rid, "bad-" + PASSWORD);
    const snaps: string[] = [readFileSync(stateFile(dir), "utf8")];
    const code = codeOf(await s.login(rid, PASSWORD));
    snaps.push(readFileSync(stateFile(dir), "utf8"));
    const t = (await (await s.token(id, code, verifier)).json()) as { access_token: string; refresh_token: string };
    snaps.push(readFileSync(stateFile(dir), "utf8"));
    const t2 = (await (await s.refresh(id, t.refresh_token)).json()) as { access_token: string; refresh_token: string };
    snaps.push(readFileSync(stateFile(dir), "utf8"));
    const secrets = [code, rid, IP, verifier, PASSWORD, PW_HASH, PW_HEX, salt.toString("hex"),
      t.access_token, t.refresh_token, t2.access_token, t2.refresh_token];
    for (const raw of snaps) for (const sec of secrets) expect(raw).not.toContain(sec);
  });

  it.skipIf(process.platform === "win32")("file mode is 0600 after every kind of write; no .tmp left behind", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const mode = () => statSync(stateFile(dir)).mode & 0o777;
    const id = await s.register();
    expect(mode()).toBe(0o600);
    const rid = await s.authorize(id, pkce().challenge);
    expect(mode()).toBe(0o600);
    await s.login(rid, "bad");
    expect(mode()).toBe(0o600);
    await s.login(rid, PASSWORD);
    expect(mode()).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("no .tmp file left behind after writes (all platforms)", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const id = await s.register();
    await s.login(await s.authorize(id, pkce().challenge), PASSWORD);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("TM-13 edge: corrupt or hostile oauth.json", () => {
  async function startsCleanAndWorks(dir: string) {
    const s = await boot(dir);
    expect((await s.mcp(TOKEN)).status).toBe(200);
    await fullFlow(s); // OAuth still usable from scratch
    return s;
  }

  it("partial (truncated) file: starts empty, static token works, old client unknown", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    await s.authorize(id, pkce().challenge);
    await s.stop();
    const raw = readFileSync(stateFile(dir), "utf8");
    writeFileSync(stateFile(dir), raw.slice(0, Math.floor(raw.length / 2)));
    s = await startsCleanAndWorks(dir);
    expect((await s.authorizeRaw(id, pkce().challenge)).status).toBe(400);
  });

  it.each([
    ["empty file", ""],
    ["literal null", "null"],
    ["array", "[]"],
    ["number", "42"],
    ["wrong field types", JSON.stringify({ clients: 5, access: "x", codes: "abc", pending: [1, 2], loginFailures: "x" })],
  ])("%s: server starts, static token works, OAuth usable", async (_n, content) => {
    const dir = dirOf();
    writeFileSync(stateFile(dir), content);
    await startsCleanAndWorks(dir);
  });

  it.each([
    ["null pending entry", { pending: { k: null } }],
    ["null code entry", { codes: { k: null } }],
    ["null rotated entry", { rotated: { k: null } }],
  ])("%s: server starts and /authorize + full flow still work (no stuck 500)", async (_n, obj) => {
    const dir = dirOf();
    writeFileSync(stateFile(dir), JSON.stringify(obj));
    await startsCleanAndWorks(dir);
  });

  it("prototype keys do not pollute Object.prototype and the server works", async () => {
    const dir = dirOf();
    writeFileSync(
      stateFile(dir),
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},' +
        '"clients":{"__proto__":{"client_id":"x","polluted3":"yes"}},' +
        '"pending":{"__proto__":{"expiresAt":1}},"codes":{"constructor":{"expiresAt":1}},' +
        '"loginFailures":{"__proto__":[1,2,3],"toString":[1]}}',
    );
    const s = await startsCleanAndWorks(dir);
    const o = {} as Record<string, unknown>;
    expect(o.polluted).toBeUndefined();
    expect(o.polluted2).toBeUndefined();
    expect(o.polluted3).toBeUndefined();
    expect((await s.login("__proto__", PASSWORD)).status).toBe(400);
    expect((await s.login("constructor", PASSWORD)).status).toBe(400);
  });

  it("oversized file with huge arrays/maps: starts, static token works, OAuth usable", async () => {
    const dir = dirOf();
    const now = Date.now();
    const loginFailures: Record<string, number[]> = { [sha("10.0.0.1")]: Array.from({ length: 1_000_000 }, () => now) };
    const codes: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) codes[sha("c" + i)] = { clientId: "x", redirectUri: REDIRECT, codeChallenge: "c", scopes: [], expiresAt: now + MIN };
    writeFileSync(stateFile(dir), JSON.stringify({ clients: {}, access: {}, refresh: {}, codes, loginFailures }));
    await startsCleanAndWorks(dir);
  }, 30_000);
});

describe("TM-13 edge: family revocation and disabled OAuth", () => {
  it("refresh reuse revokes the family, and the revocation survives restart", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const { id, t } = await fullFlow(s);
    const t2 = (await (await s.refresh(id, t.refresh_token)).json()) as { access_token: string; refresh_token: string };
    await s.stop(); s = await boot(dir);
    expect((await s.refresh(id, t.refresh_token)).status).toBe(400); // replay after restart -> revoke
    await s.stop(); s = await boot(dir);
    expect((await s.mcp(t2.access_token)).status).toBe(401);
    expect((await s.refresh(id, t2.refresh_token)).status).toBe(400);
  });

  it("revoked refresh token stays revoked across restart", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const { id, t } = await fullFlow(s);
    const rv = await fetch(s.base + "/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.refresh_token, client_id: id }),
    });
    expect(rv.status).toBe(200);
    await s.stop(); s = await boot(dir);
    expect((await s.refresh(id, t.refresh_token)).status).toBe(400);
  });

  it("OAuth disabled: OAuth paths 404, static token works, no oauth.json written", async () => {
    vi.stubEnv("OAUTH_ENABLED", "");
    const dir = dirOf();
    const s = await boot(dir, false);
    expect((await s.registerRaw()).status).toBe(404);
    expect((await s.authorizeRaw("x", pkce().challenge)).status).toBe(404);
    expect((await s.login("x", PASSWORD)).status).toBe(404);
    expect((await s.token("x", "y", "z")).status).toBe(404);
    expect((await s.mcp(TOKEN)).status).toBe(200);
    expect(existsSync(stateFile(dir))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.startsWith("oauth"))).toEqual([]);
  });
});
