import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
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
const mkHash = (pw = PASSWORD) => {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
};
const PW_HASH = mkHash();
const LABEL = "tradedesk:login-ratelimit:v1";
const b64url = (b: Buffer) => b.toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ipKey = (ip: string, pwHash = PW_HASH) =>
  createHmac("sha256", createHmac("sha256", pwHash).update(LABEL).digest()).update(ip).digest("hex");
const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const MIN = 60_000;

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
});

const oauthCfg = (dir: string, passwordHash = PW_HASH): OAuthConfig => ({
  issuerUrl: new URL("https://mcp.example.com"),
  passwordHash,
  allowedRedirectHosts: ["claude.ai"],
  stateFile: path.join(dir, "oauth.json"),
});

/** Starting a server on an existing dir = a process restart. */
async function boot(dir: string, passwordHash = PW_HASH) {
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const cfg = { mode: "paper", mcpToken: TOKEN, risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
  const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: cfg.killSwitchFile, stateFile: path.join(dir, "s.json") });
  const srv = createHttpServer({ cfg, client: {} as any, risk: engine, auditFile: path.join(dir, "a.jsonl") }, oauthCfg(dir, passwordHash));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const stop = () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  const form = (p: string, body: Record<string, string>, xff = IP) =>
    fetch(base + p, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": xff },
      body: new URLSearchParams(body),
    });
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
    login: (rid: string, password: string, xff = IP) => form("/login", { rid, password }, xff),
    token: (clientId: string, code: string, verifier: string) =>
      form("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
  };
}

const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const dirOf = () => mkdtempSync(path.join(tmpdir(), "tm16e-"));
const codeOf = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("code")!;
const stateFile = (dir: string) => path.join(dir, "oauth.json");
const readState = (dir: string) => JSON.parse(readFileSync(stateFile(dir), "utf8"));
const fakeDate = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};

/** Spies on every persist and captures the file content right after each write. */
function captureWrites(dir: string) {
  const proto = TradeOAuthProvider.prototype as any;
  const orig = proto.persist as (this: unknown) => void;
  const writes: string[] = [];
  const spy = vi.spyOn(proto, "persist").mockImplementation(function (this: unknown) {
    orig.call(this);
    writes.push(readFileSync(stateFile(dir), "utf8"));
  });
  return { writes, spy };
}

const IPV4 = "203.0.113.7";
const IPV6 = "2001:db8::1";
const IPV6_FULL = "2001:0db8:0000:0000:0000:0000:0000:0001";
const MAPPED = "::ffff:198.51.100.9";
const XFF_CHAIN_CLIENT = "192.0.2.44"; // spoofable left hop
const XFF_CHAIN_PROXY = "198.51.100.200"; // the hop trust-proxy=1 picks

describe("TM-16 edge: raw IPs never persisted", () => {
  it("no raw IPv4 / IPv6 / IPv4-mapped / X-Forwarded-For value (or its plain sha256) in oauth.json at any write", async () => {
    const dir = dirOf();
    const { writes } = captureWrites(dir);
    const s = await boot(dir);
    const id = await s.register();
    const rid = await s.authorize(id, pkce().challenge);
    const xffs = [IPV4, IPV6, IPV6_FULL, MAPPED, `${XFF_CHAIN_CLIENT}, ${XFF_CHAIN_PROXY}`];
    for (const x of xffs) expect((await s.login(rid, "bad", x)).status).toBe(401);
    // a successful login resets one IP: also a write
    expect((await s.login(rid, PASSWORD, IPV4)).status).toBe(302);
    expect(writes.length).toBeGreaterThanOrEqual(xffs.length + 3);
    const needles = [IPV4, IPV6, IPV6_FULL, MAPPED, "198.51.100.9", XFF_CHAIN_CLIENT, XFF_CHAIN_PROXY, `${XFF_CHAIN_CLIENT}, ${XFF_CHAIN_PROXY}`];
    for (const [i, raw] of writes.entries()) {
      for (const n of needles) {
        expect(raw, `write #${i} contains ${n}`).not.toContain(n);
        expect(raw, `write #${i} contains sha256(${n})`).not.toContain(sha(n));
      }
      expect(raw).not.toContain("::ffff:");
    }
    const keys = Object.keys(JSON.parse(writes.at(-1)!).loginFailures);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(keys).toContain(ipKey(IPV6));
    expect(keys).toContain(ipKey(MAPPED));
    expect(keys).toContain(ipKey(XFF_CHAIN_PROXY));
    expect(keys).not.toContain(ipKey(IPV4)); // reset by the successful login
  });

  it("LoginLimiter alone: snapshot keys never equal or contain the raw ip", () => {
    const l = new LoginLimiter(Buffer.from("k"));
    for (const ip of [IPV4, IPV6, MAPPED, "", "unknown"]) l.fail(ip);
    const json = JSON.stringify(l.snapshot());
    for (const ip of [IPV4, IPV6, MAPPED, "unknown"]) expect(json).not.toContain(ip);
    expect(Object.keys(l.snapshot())).toHaveLength(5); // empty-string ip still gets its own key
  });
});

describe("TM-16 edge: key derivation", () => {
  it("a different OAUTH_PASSWORD_HASH (same password, new salt) gives different persisted keys", async () => {
    const other = mkHash();
    const keysFor = async (h: string) => {
      const dir = dirOf();
      const s = await boot(dir, h);
      await s.login(await s.authorize(await s.register(), pkce().challenge), "bad", IPV4);
      return Object.keys(readState(dir).loginFailures);
    };
    const a = await keysFor(PW_HASH);
    const b = await keysFor(other);
    expect(a).toEqual([ipKey(IPV4, PW_HASH)]);
    expect(b).toEqual([ipKey(IPV4, other)]);
    expect(a).not.toEqual(b);
  });

  it("same hash: key is byte-identical across restarts and the counter accumulates on it", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const id = await s.register();
    const rid = await s.authorize(id, pkce().challenge);
    await s.login(rid, "bad", IPV6);
    const k1 = Object.keys(readState(dir).loginFailures);
    for (let r = 0; r < 2; r++) {
      await s.stop(); s = await boot(dir);
      await s.login(rid, "bad", IPV6);
    }
    const d = readState(dir).loginFailures;
    expect(Object.keys(d)).toEqual(k1);
    expect(d[k1[0]]).toHaveLength(3);
  });

  it("LoginLimiter: Buffer and string secrets of the same bytes agree; empty secret still is not plain sha256", () => {
    const k = (s: Buffer | string) => { const l = new LoginLimiter(s); l.fail(IPV4); return Object.keys(l.snapshot())[0]; };
    expect(k("abc")).toBe(k(Buffer.from("abc")));
    expect(k("")).not.toBe(sha(IPV4));
    expect(k("a")).not.toBe(k("b"));
  });
});

describe("TM-16 edge: old-format (plain sha256) entries", () => {
  it("are ignored: 5 recent old-key failures do not block, server boots, login works", async () => {
    const dir = dirOf();
    const now = Date.now();
    writeFileSync(stateFile(dir), JSON.stringify({
      clients: {}, access: {}, refresh: {},
      loginFailures: { [sha(IP)]: [now, now, now, now, now], [sha(IPV6)]: [now, now, now, now, now, now] },
    }));
    const s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    expect((await s.login(rid, "bad", IP)).status).toBe(401); // not 429
    expect((await s.login(rid, PASSWORD, IPV6)).status).toBe(302);
    const d = readState(dir).loginFailures;
    expect(d[ipKey(IP)]).toHaveLength(1);
  });

  it("garbage loginFailures shapes do not crash the boot", async () => {
    for (const lf of [null, [], "x", 5, { k: "notarray" }, { k: [null, "a", {}] }, { [sha(IP)]: [Number.NaN] }]) {
      const dir = dirOf();
      writeFileSync(stateFile(dir), JSON.stringify({ clients: {}, access: {}, refresh: {}, loginFailures: lf }));
      const s = await boot(dir);
      const rid = await s.authorize(await s.register(), pkce().challenge);
      expect((await s.login(rid, "bad")).status).toBe(401);
      await s.stop();
    }
  });
});

describe("TM-16 edge: no store write on bad codes", () => {
  const client = (id: string) => ({ client_id: id, redirect_uris: [REDIRECT] }) as any;

  it("1000 unknown codes (incl. empty, huge, unicode) via the provider: zero persists, file untouched", async () => {
    const dir = dirOf();
    const prov = new TradeOAuthProvider(oauthCfg(dir));
    await prov.clientsStore.registerClient!({ client_id: "c1", redirect_uris: [REDIRECT] } as any);
    const before = readFileSync(stateFile(dir), "utf8");
    const mtime = statSync(stateFile(dir)).mtimeMs;
    const spy = vi.spyOn(TradeOAuthProvider.prototype as any, "persist");
    const odd = ["", "x".repeat(100_000), "ü✓\u0000", "__proto__"];
    for (let i = 0; i < 1000; i++) {
      const code = i < odd.length ? odd[i] : randomBytes(16).toString("hex");
      await expect(prov.exchangeAuthorizationCode(client("c1"), code, "v", REDIRECT)).rejects.toThrow(/invalid authorization code/);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(readFileSync(stateFile(dir), "utf8")).toBe(before);
    expect(statSync(stateFile(dir)).mtimeMs).toBe(mtime);
  });

  it("40 unknown codes over HTTP /token (under the SDK token rate limit): all 400, zero persists", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const id = await s.register();
    const spy = vi.spyOn(TradeOAuthProvider.prototype as any, "persist");
    for (let i = 0; i < 40; i++) expect((await s.token(id, randomBytes(16).toString("hex"), "v".repeat(43))).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  // Fix-plan round 1 item 2: expected to FAIL until TM1 pushes the fix (expired known codes still delete+persist).
  it("1000 expired-but-known codes: zero persists, all rejected", async () => {
    fakeDate(T0);
    const dir = dirOf();
    const raws = Array.from({ length: 1000 }, () => randomBytes(32).toString("hex"));
    const codes: Record<string, unknown> = {};
    for (const c of raws) codes[sha(c)] = { clientId: "c1", redirectUri: REDIRECT, codeChallenge: "ch", scopes: [], expiresAt: T0 + 10 * MIN };
    writeFileSync(stateFile(dir), JSON.stringify({
      clients: { c1: { client_id: "c1", redirect_uris: [REDIRECT] } }, access: {}, refresh: {}, codes,
    }));
    const prov = new TradeOAuthProvider(oauthCfg(dir));
    vi.setSystemTime(T0 + 10 * MIN); // boundary: expiresAt <= now is expired
    const spy = vi.spyOn(TradeOAuthProvider.prototype as any, "persist");
    for (const c of raws) {
      await expect(prov.exchangeAuthorizationCode(client("c1"), c, "v", REDIRECT)).rejects.toThrow(/invalid authorization code/);
    }
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("a code 1 ms before expiry is still exchangeable (expiry boundary, other side)", async () => {
    fakeDate(T0);
    const dir = dirOf();
    const raw = randomBytes(32).toString("hex");
    writeFileSync(stateFile(dir), JSON.stringify({
      clients: { c1: { client_id: "c1", redirect_uris: [REDIRECT] } }, access: {}, refresh: {},
      codes: { [sha(raw)]: { clientId: "c1", redirectUri: REDIRECT, codeChallenge: "ch", scopes: [], expiresAt: T0 + 10 * MIN } },
    }));
    const prov = new TradeOAuthProvider(oauthCfg(dir));
    vi.setSystemTime(T0 + 10 * MIN - 1);
    const t = await prov.exchangeAuthorizationCode(client("c1"), raw, "v", REDIRECT);
    expect(t.access_token).toBeTruthy();
    expect(readState(dir).codes[sha(raw)]).toBeUndefined();
  });
});

describe("TM-16 edge: regressions", () => {
  it("a real successful exchange still persists: code removed and tokens stored; replay is 400 with no write", async () => {
    const dir = dirOf();
    const s = await boot(dir);
    const id = await s.register();
    const { verifier, challenge } = pkce();
    const code = codeOf(await s.login(await s.authorize(id, challenge), PASSWORD));
    expect(readState(dir).codes[sha(code)]).toBeTruthy();
    const { writes, spy } = captureWrites(dir);
    const tr = await s.token(id, code, verifier);
    expect(tr.status).toBe(200);
    const t = (await tr.json()) as { access_token: string; refresh_token: string };
    expect(spy).toHaveBeenCalled();
    const d = readState(dir);
    expect(d.codes[sha(code)]).toBeUndefined();
    expect(d.access[sha(t.access_token)]).toBeTruthy();
    expect(d.refresh[sha(t.refresh_token)]).toBeTruthy();
    for (const w of writes) expect(w).not.toContain(code);
    spy.mockClear();
    expect((await s.token(id, code, verifier)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rate limit: 5 failures then restart -> 429 even with the right password; other IP unaffected", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    for (let i = 0; i < 5; i++) expect((await s.login(rid, "bad", MAPPED)).status).toBe(401);
    await s.stop(); s = await boot(dir);
    expect((await s.login(rid, PASSWORD, MAPPED)).status).toBe(429);
    expect((await s.login(rid, PASSWORD, IPV4)).status).toBe(302);
  });

  it("rate limit boundary: 4 failures then restart -> 5th still 401, 6th 429", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    for (let i = 0; i < 4; i++) expect((await s.login(rid, "bad", IPV6)).status).toBe(401);
    await s.stop(); s = await boot(dir);
    expect((await s.login(rid, "bad", IPV6)).status).toBe(401);
    expect((await s.login(rid, "bad", IPV6)).status).toBe(429);
  });

  it("5 failures then restart with a different password hash -> counters reset once (keys no longer match)", async () => {
    const dir = dirOf();
    let s = await boot(dir);
    const rid = await s.authorize(await s.register(), pkce().challenge);
    for (let i = 0; i < 5; i++) await s.login(rid, "bad", IPV4);
    await s.stop(); s = await boot(dir, mkHash());
    expect((await s.login(rid, "bad", IPV4)).status).toBe(401);
  });
});
