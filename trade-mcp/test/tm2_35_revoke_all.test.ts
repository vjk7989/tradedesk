import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";
import type { OAuthConfig } from "../src/oauth/config.js";
import { run } from "../src/oauth/revoke-cli.js";

const TOKEN = "t".repeat(32);
const PASSWORD = "fake-password-for-tests";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const salt = randomBytes(16);
const PW_HASH = `scrypt:${salt.toString("hex")}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
const b64url = (b: Buffer) => b.toString("base64url");

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
});

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
  const post = (p: string, body: Record<string, string>) =>
    fetch(base + p, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "9.8.7.6" },
      body: new URLSearchParams(body),
    });
  const mcp = (bearer: string) =>
    fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const stop = () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  async function fullLogin(clientId: string, opts?: { failOnly?: boolean }) {
    const verifier = b64url(randomBytes(32));
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state: "s",
    });
    const rid = /name="rid" value="([0-9a-f]+)"/.exec(await (await fetch(`${base}/authorize?${q}`)).text())![1];
    if (opts?.failOnly) {
      await post("/login", { rid, password: "wrong" });
      return { rid, code: "", verifier };
    }
    const lr = await post("/login", { rid, password: PASSWORD });
    const code = new URL(lr.headers.get("location")!).searchParams.get("code")!;
    return { rid, code, verifier };
  }
  async function exchange(clientId: string, code: string, verifier: string) {
    const r = await post("/token", {
      grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT,
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  const register = async () =>
    (await (await fetch(base + "/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "T" }),
    })).json()).client_id as string;
  const refresh = (clientId: string, rt: string) => post("/token", { grant_type: "refresh_token", refresh_token: rt, client_id: clientId });
  return { stop, mcp, fullLogin, exchange, register, refresh, post };
}

function capture(argv: string[], env: NodeJS.ProcessEnv) {
  let o = "";
  const w1 = process.stdout.write.bind(process.stdout);
  const w2 = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (s: any) => ((o += String(s)), true);
  (process.stderr as any).write = (s: any) => ((o += String(s)), true);
  let code: number;
  try { code = run(argv, env); } finally { process.stdout.write = w1; process.stderr.write = w2; }
  return { code, out: o };
}

describe("TM2-35 oauth:revoke-all", () => {
  it("revokes tokens/codes, keeps clients and rate-limit state, prints counts only, fresh login works", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tm2-35-"));
    let s = await boot(dir);
    const id = await s.register();
    const secrets: string[] = [];
    const a = await s.fullLogin(id);
    const t = await s.exchange(id, a.code, a.verifier);
    expect(t.status).toBe(200);
    secrets.push(a.code, a.rid, t.body.access_token, t.body.refresh_token);
    const b = await s.fullLogin(id); // outstanding code
    secrets.push(b.code, b.rid);
    // a failed login to create rate-limit state
    await s.fullLogin(id, { failOnly: true });
    await s.stop();

    const before = JSON.parse(readFileSync(path.join(dir, "oauth.json"), "utf8"));
    expect(Object.keys(before.loginFailures).length).toBe(1);

    const res = capture(["--force"], { DATA_DIR: dir });
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/revoked 1 access, 1 refresh, 1 codes/);
    expect(res.out).toContain("rotate MCP_TOKEN and MCP_TOKEN_READONLY in .env separately");
    expect(res.out).not.toContain("docker compose exec");
    for (const sec of [...secrets, ...Object.keys(before.access), ...Object.keys(before.refresh), ...Object.keys(before.codes), PW_HASH, TOKEN]) {
      expect(res.out).not.toContain(sec);
    }

    const after = JSON.parse(readFileSync(path.join(dir, "oauth.json"), "utf8"));
    expect(after.access).toEqual({});
    expect(after.refresh).toEqual({});
    expect(after.codes).toEqual({});
    expect(after.pending).toEqual({});
    expect(after.clients).toEqual(before.clients);
    expect(after.loginFailures).toEqual(before.loginFailures);
    expect(existsSync(path.join(dir, "oauth.json.tmp"))).toBe(false);

    s = await boot(dir);
    expect((await s.mcp(t.body.access_token)).status).toBe(401);
    expect((await s.refresh(id, t.body.refresh_token)).status).toBe(400);
    expect((await s.exchange(id, b.code, b.verifier)).status).toBe(400);
    expect((await s.mcp(TOKEN)).status).toBe(200); // static token untouched
    const d = await s.fullLogin(id); // same client, fresh login
    const t2 = await s.exchange(id, d.code, d.verifier);
    expect(t2.status).toBe(200);
    expect((await s.mcp(t2.body.access_token)).status).toBe(200);
  });

  it("refuses without --force and changes nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tm2-35-"));
    const f = path.join(dir, "oauth.json");
    writeFileSync(f, JSON.stringify({ clients: {}, access: {}, refresh: {} }));
    const r = capture([], { DATA_DIR: dir });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--force/);
    expect(r.out).toMatch(/stop trade-mcp/);
    expect(r.out).toContain("docker compose stop trade-mcp && sleep 20 && docker compose run --rm --no-deps trade-mcp node dist/src/oauth/revoke-cli.js --force && docker compose start trade-mcp");
    expect(r.out).not.toMatch(/docker compose exec/);
    expect(readFileSync(f, "utf8")).toBe(JSON.stringify({ clients: {}, access: {}, refresh: {} }));
  });

  it("missing store: nothing to revoke, no file created; corrupt store: refuses and leaves it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tm2-35-"));
    expect(capture(["--force"], { DATA_DIR: dir }).code).toBe(0);
    expect(existsSync(path.join(dir, "oauth.json"))).toBe(false);
    writeFileSync(path.join(dir, "oauth.json"), "{not json");
    const r = capture(["--force"], { DATA_DIR: dir });
    expect(r.code).toBe(1);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe("{not json");
  });
});
