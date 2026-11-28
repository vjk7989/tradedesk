// TM2-35 edge tests (independent): oauth:revoke-all CLI.
// All secrets here are fake, generated per test run.
import { describe, it, expect, afterEach, vi } from "vitest";

// real-process and full-OAuth-flow tests are slow under full-suite load
vi.setConfig({ testTimeout: 60_000 });
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";
import type { OAuthConfig } from "../src/oauth/config.js";
import { TradeOAuthProvider } from "../src/oauth/provider.js";
import { run } from "../src/oauth/revoke-cli.js";
import { LIVE_WINDOW_MS, lockPath } from "../src/datadir-lock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_TS = path.join(ROOT, "src/oauth/revoke-cli.ts");
// Windows: chmod(0o555) on a directory does not make it read-only (NTFS ignores POSIX mode bits), so the
// read-only DATA_DIR tests are POSIX-only and skipped there.
const IS_WIN = process.platform === "win32";

const TOKEN = "s".repeat(32); // fake static MCP token
const PASSWORD = "fake-edge-password";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const IP = "9.8.7.6";
const BAD_IP = "5.6.7.8";
const salt = randomBytes(16);
const PW_HEX = scryptSync(PASSWORD, salt, 64).toString("hex");
const PW_HASH = `scrypt:${salt.toString("hex")}:${PW_HEX}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

const servers: Server[] = [];
const roDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of roDirs.splice(0)) chmodSync(d, 0o700);
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
  const form = (p: string, body: Record<string, string>, ip = IP) =>
    fetch(base + p, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip },
      body: new URLSearchParams(body),
    });
  const register = async (confidential = false) =>
    (await (await fetch(base + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
        client_name: confidential ? "Conf" : "Pub",
      }),
    })).json()) as { client_id: string; client_secret?: string };
  return {
    stop,
    register,
    authorize: async (clientId: string, challenge: string) => {
      const q = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: "S256", state: "st1",
      });
      const html = await (await fetch(`${base}/authorize?${q}`)).text();
      return /name="rid" value="([0-9a-f]+)"/.exec(html)![1];
    },
    login: (rid: string, password: string, ip = IP) => form("/login", { rid, password }, ip),
    token: (clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) =>
      form("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, ...extra }),
    refresh: (clientId: string, rt: string, extra: Record<string, string> = {}) =>
      form("/token", { grant_type: "refresh_token", refresh_token: rt, client_id: clientId, ...extra }),
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
const dirOf = () => mkdtempSync(path.join(tmpdir(), "tm2-35e-"));
const codeOf = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("code")!;
const stateFile = (dir: string) => path.join(dir, "oauth.json");
const readState = (dir: string) => JSON.parse(readFileSync(stateFile(dir), "utf8"));
const rawState = (dir: string) => readFileSync(stateFile(dir));

interface Creds {
  pubId: string;
  conf: { client_id: string; client_secret: string };
  access: string[];
  refresh: string[]; // still-valid refresh tokens
  rotatedRefresh: string[]; // already rotated (reuse-detection markers)
  codes: { clientId: string; code: string; verifier: string; secret?: string }[];
  pendingRids: string[];
  /** every secret value issued in the test (tokens, codes, rids, client secret, password material) */
  secrets: string[];
}

/** Populate every credential-bearing map: clients, access, refresh, rotated, codes, pending, loginFailures. */
async function populate(s: Srv, n = 4): Promise<Creds> {
  const pub = await s.register(false);
  const conf = (await s.register(true)) as { client_id: string; client_secret: string };
  expect(typeof conf.client_secret).toBe("string");
  const c: Creds = { pubId: pub.client_id, conf, access: [], refresh: [], rotatedRefresh: [], codes: [], pendingRids: [], secrets: [] };
  for (let i = 0; i < n; i++) {
    const confidential = i % 2 === 1;
    const id = confidential ? conf.client_id : pub.client_id;
    const extra: Record<string, string> = confidential ? { client_secret: conf.client_secret } : {};
    const { verifier, challenge } = pkce();
    const code = codeOf(await s.login(await s.authorize(id, challenge), PASSWORD));
    const tr = await s.token(id, code, verifier, extra);
    expect(tr.status).toBe(200);
    const t = (await tr.json()) as { access_token: string; refresh_token: string };
    c.access.push(t.access_token);
    c.secrets.push(code, verifier);
    if (i === 0) {
      // rotate once: old RT becomes a rotated marker, new pair is live
      const rr = await s.refresh(id, t.refresh_token, extra);
      expect(rr.status).toBe(200);
      const t2 = (await rr.json()) as { access_token: string; refresh_token: string };
      c.rotatedRefresh.push(t.refresh_token);
      c.access.push(t2.access_token);
      c.refresh.push(t2.refresh_token);
    } else {
      c.refresh.push(t.refresh_token);
    }
  }
  // unredeemed codes
  for (let i = 0; i < 3; i++) {
    const confidential = i === 2;
    const id = confidential ? conf.client_id : pub.client_id;
    const { verifier, challenge } = pkce();
    const code = codeOf(await s.login(await s.authorize(id, challenge), PASSWORD));
    c.codes.push({ clientId: id, code, verifier, secret: confidential ? conf.client_secret : undefined });
  }
  // pending logins
  for (let i = 0; i < 3; i++) c.pendingRids.push(await s.authorize(pub.client_id, pkce().challenge));
  // failed logins from BAD_IP -> rate-limit state (consumes no rid)
  const throwaway = await s.authorize(pub.client_id, pkce().challenge);
  c.pendingRids.push(throwaway);
  for (let i = 0; i < 2; i++) expect((await s.login(throwaway, "wrong-fake", BAD_IP)).status).toBe(401);

  const raw = [
    ...c.access, ...c.refresh, ...c.rotatedRefresh,
    ...c.codes.map((x) => x.code), ...c.pendingRids, conf.client_secret,
  ];
  c.secrets.push(...raw, ...raw.map(sha), PW_HASH, PW_HEX, salt.toString("hex"));
  return c;
}

/** Run the CLI in-process, capturing stdout/stderr. */
function runCaptured(argv: string[], env: NodeJS.ProcessEnv) {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => { out += String(s); return true; }) as any);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => { err += String(s); return true; }) as any);
  let code: number | undefined;
  let thrown: unknown;
  try {
    code = run(argv, env);
  } catch (x) {
    thrown = x;
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  return { code, out, err, thrown };
}

/** Run the CLI as a real process (catches uncaught-exception output too).
 *  Spawns this node binary with `--import tsx` (no shell): node_modules/.bin/tsx is a sh shim on POSIX and a
 *  .cmd shim on Windows, which spawnSync cannot execute without a shell. */
function runProc(argv: string[], dataDir: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI_TS, ...argv], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, OAUTH_PASSWORD_HASH: PW_HASH, ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const envFor = (dir: string): NodeJS.ProcessEnv => ({ DATA_DIR: dir, OAUTH_PASSWORD_HASH: PW_HASH, MCP_TOKEN: TOKEN });

function expectNoSecrets(text: string, secrets: string[]) {
  for (const s of secrets) {
    if (s.length < 8) continue;
    expect(text.includes(s), `output leaked a secret (len ${s.length})`).toBe(false);
  }
}

async function populatedDir(n = 4) {
  const dir = dirOf();
  const s = await boot(dir);
  const c = await populate(s, n);
  await s.stop();
  return { dir, c };
}

const CRED_KEYS = ["access", "refresh", "rotated", "codes", "pending"];
const KEEP_KEYS = ["clients", "loginFailures"];

describe("TM2-35 edge: every credential map is emptied, clients and limiter kept", () => {
  it("populated store: all credential maps non-empty before, all empty after; clients + loginFailures deep-equal", async () => {
    const { dir } = await populatedDir();
    const before = readState(dir);
    for (const k of CRED_KEYS) expect(Object.keys(before[k] ?? {}).length, `before: ${k}`).toBeGreaterThan(0);
    expect(Object.keys(before.clients).length).toBe(2);
    expect(Object.keys(before.loginFailures).length).toBe(1);

    const r = runCaptured(["--force"], envFor(dir));
    expect(r.thrown).toBeUndefined();
    expect(r.code).toBe(0);

    const after = readState(dir);
    // Generic: every persisted key that is not a kept key must be empty (catches future maps).
    for (const k of Object.keys(after)) {
      if (KEEP_KEYS.includes(k)) continue;
      expect(Object.keys(after[k] ?? {}).length, `after: ${k}`).toBe(0);
    }
    for (const k of Object.keys(before)) if (!KEEP_KEYS.includes(k)) expect(k in after ? Object.keys(after[k]).length : 0).toBe(0);
    expect(after.clients).toStrictEqual(before.clients);
    expect(after.loginFailures).toStrictEqual(before.loginFailures);
  });

  it("revokeAll() on a provider instance empties every private credential map", async () => {
    const { dir } = await populatedDir();
    const p = new TradeOAuthProvider({
      issuerUrl: new URL("https://mcp.example.com"), passwordHash: PW_HASH, allowedRedirectHosts: ["claude.ai"], stateFile: stateFile(dir),
    });
    const priv = p as unknown as Record<string, unknown>;
    const maps = Object.keys(priv).filter((k) => priv[k] instanceof Map);
    // enumerate Map-valued fields: must be exactly the known ones (new credential maps would need revokeAll coverage)
    expect(maps.sort()).toEqual(["access", "clients", "codes", "pending", "refresh", "rotated"]);
    const clientsBefore = new Map(priv.clients as Map<string, unknown>);
    const c = p.revokeAll();
    expect(c.access).toBeGreaterThan(0);
    expect(c.refresh).toBeGreaterThan(0);
    expect(c.codes).toBeGreaterThan(0);
    expect(c.pending).toBeGreaterThan(0);
    expect(c.rotated).toBeGreaterThan(0);
    for (const k of maps) if (k !== "clients") expect((priv[k] as Map<string, unknown>).size, k).toBe(0);
    expect(priv.clients).toStrictEqual(clientsBefore);
  });

  it("counts printed match the number of entries in the store", async () => {
    const { dir } = await populatedDir();
    const before = readState(dir);
    const r = runCaptured(["--force"], envFor(dir));
    const n = (k: string) => Object.keys(before[k]).length;
    expect(r.out).toContain(`revoked ${n("access")} access, ${n("refresh")} refresh, ${n("codes")} codes`);
    expect(r.out).toContain("rotate MCP_TOKEN and MCP_TOKEN_READONLY in .env separately");
    expect(r.out).toContain("docker compose start trade-mcp");
    expect(r.out + r.err).not.toContain("docker compose exec");
  });

  it("loginFailures are kept even when OAUTH_PASSWORD_HASH is not set in the CLI env", async () => {
    const { dir } = await populatedDir(2);
    const before = readState(dir);
    const r = runCaptured(["--force"], { DATA_DIR: dir });
    expect(r.code).toBe(0);
    expect(readState(dir).loginFailures).toStrictEqual(before.loginFailures);
    expect(readState(dir).clients).toStrictEqual(before.clients);
  });
});

describe("TM2-35 edge: after revoke + restart, all old credentials are dead, fresh login works", () => {
  it("old access 401, old refresh (live + rotated) rejected, old codes rejected, pending login cannot complete", async () => {
    const { dir, c } = await populatedDir();
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    const s = await boot(dir);
    for (const at of c.access) expect((await s.mcp(at)).status, "old access token").toBe(401);
    for (const [i, rt] of c.refresh.entries()) {
      const extra: Record<string, string> = i % 2 === 1 ? { client_secret: c.conf.client_secret } : {};
      const id = i % 2 === 1 ? c.conf.client_id : c.pubId;
      const r = await s.refresh(id, rt, extra);
      expect(r.status, "old refresh token").toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
    }
    for (const rt of c.rotatedRefresh) expect((await s.refresh(c.pubId, rt)).status).toBe(400);
    for (const x of c.codes) {
      const r = await s.token(x.clientId, x.code, x.verifier, x.secret ? { client_secret: x.secret } : {});
      expect(r.status, "old code").toBe(400);
    }
    for (const rid of c.pendingRids) {
      const r = await s.login(rid, PASSWORD);
      expect(r.status, "old pending login").toBe(400);
      expect(r.headers.get("location")).toBeNull();
    }
    // static token unaffected
    expect((await s.mcp(TOKEN)).status).toBe(200);
  });

  it("fresh full OAuth login on both existing clients (public + confidential with original secret) works after restart", async () => {
    const { dir, c } = await populatedDir(2);
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    const s = await boot(dir);
    for (const [id, extra] of [
      [c.pubId, {}],
      [c.conf.client_id, { client_secret: c.conf.client_secret }],
    ] as const) {
      const { verifier, challenge } = pkce();
      const lr = await s.login(await s.authorize(id, challenge), PASSWORD);
      expect(lr.status).toBe(302);
      const tr = await s.token(id, codeOf(lr), verifier, extra);
      expect(tr.status).toBe(200);
      const t = (await tr.json()) as { access_token: string; refresh_token: string };
      expect((await s.mcp(t.access_token)).status).toBe(200);
      expect((await s.refresh(id, t.refresh_token, extra)).status).toBe(200);
    }
  });

  it("rate-limit still enforced after revoke + restart (failures count carries over)", async () => {
    const { dir, c } = await populatedDir(2);
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    const s = await boot(dir);
    const rid = await s.authorize(c.pubId, pkce().challenge);
    // populate() recorded 2 failures from BAD_IP; 3 more reach the limit of 5
    for (let i = 0; i < 3; i++) expect((await s.login(rid, "wrong-fake", BAD_IP)).status).toBe(401);
    expect((await s.login(rid, PASSWORD, BAD_IP)).status).toBe(429);
  });
});

describe("TM2-35 edge: output secrecy on every path", () => {
  it("success path (in-process and real process): no token, code, rid, client secret, hash or password hash in output", async () => {
    const { dir, c } = await populatedDir(6);
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).toBe(0);
    expectNoSecrets(r.out + r.err, c.secrets);

    const { dir: dir2, c: c2 } = await populatedDir(3);
    const p = runProc(["--force"], dir2);
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/revoked \d+ access, \d+ refresh, \d+ codes/);
    expectNoSecrets(p.out + p.err, c2.secrets);
  });

  it("--force missing: no secrets in output", async () => {
    const { dir, c } = await populatedDir(3);
    const r = runCaptured([], envFor(dir));
    expect(r.code).not.toBe(0);
    expectNoSecrets(r.out + r.err, c.secrets);
    const p = runProc([], dir);
    expect(p.code).not.toBe(0);
    expectNoSecrets(p.out + p.err, c.secrets);
  });

  it("missing store: no secrets (password hash) in output", () => {
    const dir = dirOf();
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).toBe(0);
    expectNoSecrets(r.out + r.err, [PW_HASH, PW_HEX, TOKEN]);
  });

  it("corrupt store holding real hashes: no secrets in output (in-process and real process)", async () => {
    const { dir, c } = await populatedDir(3);
    writeFileSync(stateFile(dir), rawState(dir).toString("utf8") + "}garbage");
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).not.toBe(0);
    expectNoSecrets(r.out + r.err, c.secrets);
    const p = runProc(["--force"], dir);
    expect(p.code).not.toBe(0);
    expectNoSecrets(p.out + p.err, c.secrets);
  });

  it("empty store: no secrets in output", () => {
    const dir = dirOf();
    writeFileSync(stateFile(dir), "{}");
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).toBe(0);
    expectNoSecrets(r.out + r.err, [PW_HASH, PW_HEX, TOKEN]);
  });

  // POSIX-only: chmod 0o555 does not make a directory read-only on Windows.
  it.skipIf(IS_WIN)("write failure (read-only DATA_DIR) in a real process: crash output carries no secrets", async () => {
    const { dir, c } = await populatedDir(3);
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    const p = runProc(["--force"], dir);
    expect(p.code).not.toBe(0);
    expectNoSecrets(p.out + p.err, c.secrets);
  });
});

describe("TM2-35 edge: CLI argument and store paths", () => {
  it("without --force: non-zero, store byte-identical, explains single-process rule", async () => {
    const { dir } = await populatedDir(2);
    const before = rawState(dir);
    for (const argv of [[], ["-f"], ["--FORCE"], ["force"], ["--force=yes"], ["--forced"]]) {
      const r = runCaptured(argv, envFor(dir));
      expect(r.code, JSON.stringify(argv)).not.toBe(0);
      expect(rawState(dir).equals(before), JSON.stringify(argv)).toBe(true);
    }
    const r = runCaptured([], envFor(dir));
    expect(r.err).toMatch(/--force/);
    expect(r.err).toMatch(/stop trade-mcp/i);
  });

  it("corrupt store (truncated JSON / empty file / binary): non-zero, byte-identical, no .tmp left", async () => {
    const { dir } = await populatedDir(2);
    const good = rawState(dir);
    for (const bad of [good.subarray(0, good.length - 5), Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x00, 0x7b])]) {
      writeFileSync(stateFile(dir), bad);
      const r = runCaptured(["--force"], envFor(dir));
      expect(r.code).not.toBe(0);
      expect(rawState(dir).equals(bad)).toBe(true);
      expect(existsSync(stateFile(dir) + ".tmp")).toBe(false);
    }
  });

  it("valid JSON that is not an object (null / [] / \"x\" / 42): non-zero and byte-identical", () => {
    // Regression (fixed in round 1): the CLI must not rewrite a JSON store that is not an object.
    const dir = dirOf();
    for (const txt of ["null", "[]", "\"x\"", "42"]) {
      writeFileSync(stateFile(dir), txt);
      const r = runCaptured(["--force"], envFor(dir));
      expect(rawState(dir).toString("utf8"), txt).toBe(txt);
      expect(r.code, txt).not.toBe(0);
    }
  });

  it("missing store: exit 0, creates no file (and does not create DATA_DIR)", () => {
    const parent = dirOf();
    const dir = path.join(parent, "nope");
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).toBe(0);
    expect(existsSync(dir)).toBe(false);
    const dir2 = dirOf();
    expect(runCaptured(["--force"], envFor(dir2)).code).toBe(0);
    expect(readdirSync(dir2)).toEqual([]);
  });

  it("empty store {}: zero counts", () => {
    const dir = dirOf();
    writeFileSync(stateFile(dir), "{}");
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).toBe(0);
    expect(r.out).toContain("revoked 0 access, 0 refresh, 0 codes");
    expect(r.out).toMatch(/cleared 0 pending logins, 0 rotation markers/);
  });

  it("unknown args are rejected: non-zero and store byte-identical", async () => {
    const { dir } = await populatedDir(2);
    const before = rawState(dir);
    for (const argv of [["--force", "--bogus"], ["--bogus", "--force"], ["--force", "extra"], ["--force", "--data-dir=/tmp/x"]]) {
      const r = runCaptured(argv, envFor(dir));
      expect(rawState(dir).equals(before), `store changed for ${JSON.stringify(argv)}`).toBe(true);
      expect(r.code, JSON.stringify(argv)).not.toBe(0);
    }
  });

  it("--force given twice: behaves as --force once (exit 0, revoked)", async () => {
    const { dir } = await populatedDir(2);
    const before = readState(dir);
    const r = runCaptured(["--force", "--force"], envFor(dir));
    expect(r.code).toBe(0);
    const after = readState(dir);
    for (const k of CRED_KEYS) expect(Object.keys(after[k]).length).toBe(0);
    expect(after.clients).toStrictEqual(before.clients);
  });

  it("running twice is idempotent: second run reports zeros and keeps clients", async () => {
    const { dir } = await populatedDir(2);
    const before = readState(dir);
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).toBe(0);
    expect(r.out).toContain("revoked 0 access, 0 refresh, 0 codes");
    expect(readState(dir).clients).toStrictEqual(before.clients);
  });
});

describe("TM2-35 edge: atomicity on write failure", () => {
  // POSIX-only: chmod 0o555 does not make a directory read-only on Windows.
  it.skipIf(IS_WIN)("read-only DATA_DIR: original store byte-identical, no partial/tmp file, non-zero exit (real process)", async () => {
    const { dir } = await populatedDir(2);
    const before = rawState(dir);
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    const p = runProc(["--force"], dir);
    expect(p.code).not.toBe(0);
    expect(rawState(dir).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith("oauth.json"))).toEqual(["oauth.json"]);
  });

  // POSIX-only: chmod 0o555 does not make a directory read-only on Windows.
  it.skipIf(IS_WIN)("read-only DATA_DIR in-process: run() fails (throws or non-zero), store intact", async () => {
    const { dir } = await populatedDir(2);
    const before = rawState(dir);
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.thrown !== undefined || (r.code ?? 0) !== 0).toBe(true);
    expect(rawState(dir).equals(before)).toBe(true);
  });

  it("tmp write blocked (oauth.json.tmp is a directory): store byte-identical", async () => {
    const { dir } = await populatedDir(2);
    const before = rawState(dir);
    mkdirSync(stateFile(dir) + ".tmp");
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.thrown !== undefined || (r.code ?? 0) !== 0).toBe(true);
    expect(rawState(dir).equals(before)).toBe(true);
  });
});

// TM2-61: the runbook inserts a wait after stop (TM2-46 lock heartbeat: lock younger than 15 s counts as live).
const RUNBOOK_CMD_WITH_WAIT =
  "docker compose stop trade-mcp && sleep 20 && docker compose run --rm --no-deps trade-mcp node dist/src/oauth/revoke-cli.js --force && docker compose start trade-mcp";

describe("TM2-35 edge: why stop -> run -> start is required (revoking against a live server is unsupported)", () => {
  // Documented-unsupported behaviour: a live trade-mcp keeps the OAuth store in memory and rewrites oauth.json from
  // memory on ANY persisting action, so a revoke done while it runs is undone. These tests PIN that behaviour
  // (so the runbook warning stays justified) and check the CLI warns about it.

  it("why stop->run->start is required: a live server issuing a token after the CLI ran re-persists the revoked tokens", async () => {
    const dir = dirOf();
    const live = await boot(dir);
    const c = await populate(live, 3);
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    expect(Object.keys(readState(dir).access).length).toBe(0);

    const { verifier, challenge } = pkce();
    const code = codeOf(await live.login(await live.authorize(c.pubId, challenge), PASSWORD));
    expect((await live.token(c.pubId, code, verifier)).status).toBe(200);
    const accessKeysOnDisk = Object.keys(readState(dir).access);
    await live.stop();

    const s = await boot(dir);
    const resurrected = c.access.filter((at) => accessKeysOnDisk.includes(sha(at)));
    expect(resurrected.length).toBe(c.access.length); // all revoked tokens written back
    for (const at of c.access) expect((await s.mcp(at)).status).toBe(200);
  });

  it("why stop->run->start is required: even an unauthenticated /authorize view on the live server undoes the revoke", async () => {
    const dir = dirOf();
    const live = await boot(dir);
    const c = await populate(live, 2);
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    await live.authorize(c.pubId, pkce().challenge);
    await live.stop();
    const s = await boot(dir);
    for (const at of c.access) expect((await s.mcp(at)).status).toBe(200);
  });

  it("control: stop -> run -> start (no live writer in between) keeps every token revoked", async () => {
    const dir = dirOf();
    const live = await boot(dir);
    const c = await populate(live, 2);
    await live.stop();
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    const s = await boot(dir);
    await s.authorize(c.pubId, pkce().challenge); // a persisting action on the new process is harmless
    for (const at of c.access) expect((await s.mcp(at)).status).toBe(401);
  });

  it("refusal text warns that revoking while running is undone, gives stop/run/start, never exec", () => {
    const dir = dirOf();
    const r = runCaptured([], envFor(dir));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--force confirms trade-mcp is STOPPED/);
    expect(r.err).toMatch(/while it runs is undone/);
    expect(r.err).toContain(RUNBOOK_CMD_WITH_WAIT);
    expect(r.out + r.err).not.toContain("docker compose exec");
  });

  it("--force usage text (unknown arg) also warns that revoking while running is undone", () => {
    const r = runCaptured(["--force", "--x"], envFor(dirOf()));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--force confirms trade-mcp is STOPPED/);
    expect(r.err).toMatch(/undone/);
  });

  it("no CLI path ever prints `docker compose exec`", async () => {
    const { dir } = await populatedDir(1);
    const corrupt = dirOf();
    writeFileSync(stateFile(corrupt), "{bad");
    const shape = dirOf();
    writeFileSync(stateFile(shape), "[]");
    const outs = [
      runCaptured([], envFor(dir)),
      runCaptured(["--bogus"], envFor(dir)),
      runCaptured(["--force"], envFor(dirOf())),
      runCaptured(["--force"], envFor(corrupt)),
      runCaptured(["--force"], envFor(shape)),
      runCaptured(["--force"], envFor(dir)),
    ];
    for (const r of outs) expect(r.out + r.err).not.toContain("docker compose exec");
  });
});

describe("TM2-35 edge: exit codes 0/1/2/3", () => {
  it("0 ok, 0 nothing to revoke, 1 corrupt, 1 wrong shape, 2 usage (in-process)", async () => {
    const { dir } = await populatedDir(1);
    expect(runCaptured(["--force"], envFor(dir)).code).toBe(0);
    expect(runCaptured(["--force"], envFor(dirOf())).code).toBe(0);
    const corrupt = dirOf();
    writeFileSync(stateFile(corrupt), "{bad");
    expect(runCaptured(["--force"], envFor(corrupt)).code).toBe(1);
    expect(runCaptured([], envFor(dir)).code).toBe(2);
  });

  it("unknown args exit 2 with the store byte-identical", async () => {
    const { dir } = await populatedDir(2);
    const before = rawState(dir);
    for (const argv of [["--force", "--bogus"], ["--bogus", "--force"], ["--force", "extra"], ["--force", "--data-dir=/tmp/x"], ["-f"], ["--force="]]) {
      const r = runCaptured(argv, envFor(dir));
      expect(r.code, JSON.stringify(argv)).toBe(2);
      expect(rawState(dir).equals(before), JSON.stringify(argv)).toBe(true);
    }
  });

  it("null / [] / \"x\" / 42 exit 1 with the store byte-identical", () => {
    const dir = dirOf();
    for (const txt of ["null", "[]", "\"x\"", "42"]) {
      writeFileSync(stateFile(dir), txt);
      const r = runCaptured(["--force"], envFor(dir));
      expect(r.code, txt).toBe(1);
      expect(rawState(dir).toString("utf8"), txt).toBe(txt);
    }
  });

  // POSIX-only: chmod 0o555 does not make a directory read-only on Windows.
  it.skipIf(IS_WIN)("read-only DATA_DIR exits 3 (real process) with a one-line message, no stack trace, store intact", async () => {
    const { dir, c } = await populatedDir(2);
    const before = rawState(dir);
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    const p = runProc(["--force"], dir);
    expect(p.code).toBe(3);
    expect(p.out).toBe("");
    const lines = p.err.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    expect(p.err).not.toMatch(/\n\s+at |Error:|EACCES|node:/);
    expect(rawState(dir).equals(before)).toBe(true);
    expectNoSecrets(p.out + p.err, c.secrets);
  });

  it("real process exit codes match in-process: 2 without --force, 2 unknown arg, 1 wrong shape, 0 success", async () => {
    const { dir } = await populatedDir(1);
    expect(runProc([], dir).code).toBe(2);
    expect(runProc(["--force", "--nope"], dir).code).toBe(2);
    const shape = dirOf();
    writeFileSync(stateFile(shape), "null");
    expect(runProc(["--force"], shape).code).toBe(1);
    expect(runProc(["--force"], dir).code).toBe(0);
  });
});

// TM2-66: the CLI hint must be the runbook's one-liner, byte for byte, and its sleep must outlast the lock live window.
const RUNBOOK_RE =
  /docker compose stop trade-mcp && sleep (\d+) && docker compose run --rm --no-deps trade-mcp node dist\/src\/oauth\/revoke-cli\.js --force && docker compose start trade-mcp/;
function runbookOneLiner(): string {
  const m = RUNBOOK_RE.exec(readFileSync(path.join(ROOT, "..", "docs", "vps-runbook.md"), "utf8"));
  expect(m, "docs/vps-runbook.md has no revoke one-liner").not.toBeNull();
  return m![0];
}
/** A lock written just now counts as live (mtime inside LIVE_WINDOW_MS), whatever host/pid it names. */
function liveLockDir(): string {
  const dir = dirOf();
  writeFileSync(lockPath(dir), JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), hostname: "other-host.invalid" }));
  return dir;
}

describe("TM2-66: CLI revoke hint == docs/vps-runbook.md one-liner (drift guard)", () => {
  it("no --force (exit 2): stderr contains the runbook one-liner byte for byte, store unchanged", async () => {
    const want = runbookOneLiner();
    const { dir } = await populatedDir(1);
    const before = readFileSync(stateFile(dir));
    const r = runCaptured([], envFor(dir));
    expect(r.code).toBe(2);
    expect(r.err.includes(want), r.err).toBe(true);
    expect(r.err).toContain("\n  " + want);
    expect(readFileSync(stateFile(dir)).equals(before)).toBe(true);
  });

  it("live lock + --force (exit 4): stderr contains the runbook one-liner byte for byte, store and lock unchanged", async () => {
    const want = runbookOneLiner();
    const { dir: src } = await populatedDir(1);
    const dir = liveLockDir();
    writeFileSync(stateFile(dir), readFileSync(stateFile(src)));
    const store = readFileSync(stateFile(dir));
    const lock = readFileSync(lockPath(dir));
    const r = runCaptured(["--force"], envFor(dir));
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/trade-mcp is running/);
    expect(r.err.includes(want), r.err).toBe(true);
    expect(r.err).toContain(`(${want})`);
    expect(readFileSync(stateFile(dir)).equals(store)).toBe(true);
    expect(readFileSync(lockPath(dir)).equals(lock)).toBe(true);
    expect(r.out + r.err).not.toContain("docker compose exec");
  });

  it("the sleep in both CLI hints is > LIVE_WINDOW_MS/1000", () => {
    const outs = [runCaptured([], envFor(dirOf())).err, runCaptured(["--force"], envFor(liveLockDir())).err];
    for (const text of outs) {
      const m = RUNBOOK_RE.exec(text);
      expect(m, text).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThan(LIVE_WINDOW_MS / 1000);
    }
  });
});

describe("TM2-35 edge: docs/vps-runbook.md", () => {
  it("contains the stop -> run --rm --no-deps -> start command and never instructs exec", () => {
    const md = readFileSync(path.join(ROOT, "..", "docs", "vps-runbook.md"), "utf8");
    expect(md).toContain(RUNBOOK_CMD_WITH_WAIT);
    // order + wait >= 16 s (heartbeat window is 15 s), so removing the wait fails
    const m = RUNBOOK_RE.exec(md);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(16);
    // any mention of `docker compose exec` near revoke-cli must be a prohibition, never a command to run
    const lines = md.split("\n");
    for (const l of lines) {
      if (/revoke-cli|oauth:revoke-all/.test(l)) expect(l, l).not.toMatch(/docker compose exec/);
      if (/docker compose exec/.test(l) && /revoke/i.test(l)) expect(l).toMatch(/do not/i);
    }
    const start = md.indexOf("Emergency: revoke all OAuth tokens");
    expect(start).toBeGreaterThan(-1);
    const section = md.slice(start, md.indexOf("\n## ", start));
    for (const l of section.split("\n")) if (/docker compose exec/.test(l)) expect(l).toMatch(/do not use/i);
    const fence = /```[^\n]*\n([\s\S]*?)```/.exec(section)![1];
    expect(fence).not.toMatch(/\bexec\b/);
  });
});
