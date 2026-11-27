import { describe, it, expect, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import type { Config } from "../src/config.js";

const TOKEN = "tok_SECRETMCP_" + "z".repeat(20);
const API_KEY = "oa_SECRETKEY_" + "k".repeat(20);
const OA_URL = "http://openalgo-secret-host.invalid:5000";
const BT_TOKEN = "bt_SECRETTOK_" + "b".repeat(20);
const BT_URL = "http://bt-secret-host.invalid:9999";
const SECRETS = [TOKEN, API_KEY, BT_TOKEN, OA_URL, BT_URL, "openalgo-secret-host", "bt-secret-host", "SECRET", "stack", "Error", "at "];

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
});

const dir = mkdtempSync(path.join(tmpdir(), "readyz-e-"));
const goodAudit = () => path.join(dir, "ok", "a.jsonl");
const flat = path.join(dir, "flatfile");
writeFileSync(flat, "x");

interface Opts { oa?: () => any; btUrl?: string | undefined; audit?: string }
async function start(o: Opts = {}) {
  const cfg = {
    mode: "paper", mcpToken: TOKEN, openalgoApiKey: API_KEY, openalgoUrl: OA_URL, btToken: BT_TOKEN,
    btUrl: "btUrl" in o ? o.btUrl : BT_URL,
  } as unknown as Config;
  const analyzerStatus = vi.fn(o.oa ?? (async () => ({ status: "success" })));
  const srv = createHttpServer(
    { cfg, client: { analyzerStatus } as any, risk: {} as any, auditFile: o.audit ?? goodAudit() },
    undefined,
  );
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, analyzerStatus };
}
const realFetch = globalThis.fetch;
function stubBt(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", (u: any, i?: any) => (String(u).startsWith("http://127.0.0.1") ? realFetch(u, i) : f(String(u), i)));
  return f;
}
const okBt = () => stubBt(async () => new Response("ok"));
const get = async (base: string, p = "/readyz", init?: RequestInit) => {
  const r = await realFetch(base + p, init);
  const text = await r.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: r.status, text, body, headers: r.headers };
};

describe("TM2-5 edge: status matrix", () => {
  const oaCases = {
    ok: async () => ({ status: "success" }),
    fail: async () => ({ status: "error", message: "bad key" }),
  };
  for (const oa of ["ok", "fail"] as const)
    for (const bt of ["ok", "fail", "not_configured"] as const)
      for (const au of ["ok", "fail"] as const)
        it(`openalgo=${oa} bt=${bt} audit=${au} -> ${oa === "ok" && bt !== "fail" && au === "ok" ? 200 : 503}`, async () => {
          stubBt(async () => new Response(null, { status: bt === "ok" ? 204 : 503 }));
          const { base } = await start({
            oa: oaCases[oa],
            btUrl: bt === "not_configured" ? undefined : BT_URL,
            audit: au === "ok" ? undefined : path.join(flat, "sub", "a.jsonl"),
          });
          const r = await get(base);
          const ok = oa === "ok" && bt !== "fail" && au === "ok";
          expect(r.status).toBe(ok ? 200 : 503);
          expect(r.body).toEqual({ ok, checks: { openalgo: oa, bt, auditWritable: au } });
          expect(r.headers.get("content-type")).toContain("application/json");
        });

  it("empty-string btUrl counts as not_configured and makes no bt call", async () => {
    const f = okBt();
    const { base } = await start({ btUrl: "" });
    const r = await get(base);
    expect(r.status).toBe(200);
    expect(r.body.checks.bt).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", async () => undefined],
    ["null", async () => null],
    ["string", async () => "success"],
    ["status missing", async () => ({ data: {} })],
    ["sync throw", () => { throw new Error("sync " + API_KEY); }],
  ])("openalgo returns %s -> fail, server does not crash", async (_n, oa) => {
    okBt();
    const { base } = await start({ oa });
    const r = await get(base);
    expect(r.status).toBe(503);
    expect(r.body.checks.openalgo).toBe("fail");
  });

  it("bt redirect / 3xx without follow target is not ok", async () => {
    stubBt(async () => new Response("", { status: 302, headers: { location: "http://elsewhere.invalid/" } }));
    const { base } = await start();
    const r = await get(base);
    expect(r.body.checks.bt).toBe("fail");
  });
});

describe("TM2-5 edge: timeouts (fake timers)", () => {
  it("openalgo hanging forever -> fail once 3 s elapse", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    okBt();
    const { base, analyzerStatus } = await start({ oa: () => new Promise(() => {}) });
    const p = get(base);
    await vi.waitFor(() => expect(analyzerStatus).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.status).toBe(503);
    expect(r.body.checks.openalgo).toBe("fail");
  });

  it("openalgo answering at 2999 ms -> ok (boundary below)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    okBt();
    const { base, analyzerStatus } = await start({
      oa: () => new Promise((r) => setTimeout(() => r({ status: "success" }), 2999)),
    });
    const p = get(base);
    await vi.waitFor(() => expect(analyzerStatus).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.body.checks.openalgo).toBe("ok");
  });

  it("openalgo answering at 3001 ms -> fail (boundary above)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    okBt();
    const { base, analyzerStatus } = await start({
      oa: () => new Promise((r) => setTimeout(() => r({ status: "success" }), 3001)),
    });
    const p = get(base);
    await vi.waitFor(() => expect(analyzerStatus).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3001);
    const r = await p;
    expect(r.status).toBe(503);
    expect(r.body.checks.openalgo).toBe("fail");
  });

  it("bt fetch gets an abort signal that fires at ~3 s (real timers; AbortSignal.timeout is not fakeable)", async () => {
    let signal: AbortSignal | undefined;
    stubBt((_u, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted " + BT_URL))));
    });
    const { base } = await start({ btUrl: BT_URL });
    const t0 = Date.now();
    const r = await get(base);
    const dt = Date.now() - t0;
    expect(signal).toBeDefined();
    expect(dt).toBeGreaterThanOrEqual(2900);
    expect(dt).toBeLessThan(3800);
    expect(r.status).toBe(503);
    expect(r.body.checks).toEqual({ openalgo: "ok", bt: "fail", auditWritable: "ok" });
  }, 10000);
});

describe("TM2-5 edge: no secrets in body", () => {
  it("upstream error payloads with key/URL/stack never reach the body or headers", async () => {
    const e = new Error(`upstream ${OA_URL}/api/v1/analyzer?apikey=${API_KEY}`);
    stubBt(async () => new Response(`bt down at ${BT_URL} token=${BT_TOKEN}\n${e.stack}`, { status: 500 }));
    const { base } = await start({
      oa: async () => ({ status: "error", message: `Invalid apikey ${API_KEY} for ${OA_URL}`, stack: e.stack }),
      audit: path.join(flat, "sub", `${API_KEY}.jsonl`),
    });
    const r = await get(base);
    expect(r.status).toBe(503);
    const all = r.text + JSON.stringify([...r.headers]);
    for (const s of SECRETS) expect(all).not.toContain(s);
  });

  it("thrown upstream errors with secrets leave only enum strings", async () => {
    stubBt(async () => { throw new TypeError(`fetch failed ${BT_URL} ${BT_TOKEN}`); });
    const { base } = await start({ oa: async () => { throw new Error(`${API_KEY} ${OA_URL}`); } });
    const r = await get(base);
    for (const s of SECRETS) expect(r.text).not.toContain(s);
    for (const v of Object.values(r.body.checks)) expect(["ok", "fail", "not_configured"]).toContain(v);
  });

  it("a success body echoing secrets is not reflected either", async () => {
    stubBt(async () => new Response(JSON.stringify({ ok: true, url: BT_URL, token: BT_TOKEN })));
    const { base } = await start({ oa: async () => ({ status: "success", data: { apikey: API_KEY, host: OA_URL } }) });
    const r = await get(base);
    expect(r.status).toBe(200);
    for (const s of SECRETS) expect(r.text).not.toContain(s);
  });
});

describe("TM2-5 edge: cache", () => {
  it("50 concurrent requests on a cold cache -> one upstream call per check", async () => {
    let release!: () => void;
    const f = stubBt(() => new Promise((r) => { release = () => r(new Response("ok")); }));
    const { base, analyzerStatus } = await start();
    const ps = Array.from({ length: 50 }, () => get(base));
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    release();
    const rs = await Promise.all(ps);
    expect(analyzerStatus).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(1);
    rs.forEach((r) => expect(r.status).toBe(200));
  });

  it("expiry at the 5 s boundary: 4999 ms cached, 5000 ms recomputed, and a fail recovers to 200", async () => {
    const f = okBt();
    let up = false;
    const { base, analyzerStatus } = await start({ oa: async () => ({ status: up ? "success" : "error" }) });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(2_000_000);
    expect((await get(base)).status).toBe(503);
    up = true;
    now.mockReturnValue(2_004_999);
    expect((await get(base)).status).toBe(503); // still cached
    expect(analyzerStatus).toHaveBeenCalledTimes(1);
    now.mockReturnValue(2_005_000);
    expect((await get(base)).status).toBe(200);
    expect(analyzerStatus).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("50 concurrent requests right after expiry -> one more upstream call", async () => {
    const f = okBt();
    const { base, analyzerStatus } = await start();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(3_000_000);
    await get(base);
    now.mockReturnValue(3_005_000);
    await Promise.all(Array.from({ length: 50 }, () => get(base)));
    expect(analyzerStatus).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("clock stepping backwards does not pin a stale result", async () => {
    okBt();
    let up = false;
    const { base } = await start({ oa: async () => ({ status: up ? "success" : "error" }) });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(10_000_000);
    expect((await get(base)).status).toBe(503);
    up = true;
    now.mockReturnValue(10_000_000 - 60 * 60 * 1000); // NTP step back 1 h
    expect((await get(base)).status).toBe(200);
  });

  it("/healthz does not touch upstreams or the cache", async () => {
    const f = okBt();
    const { base, analyzerStatus } = await start();
    for (let i = 0; i < 5; i++) expect((await get(base, "/healthz")).status).toBe(200);
    expect(analyzerStatus).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("TM2-5 edge: audit writability", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("audit dir without write permission -> fail", async () => {
    okBt();
    const ro = path.join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      const { base } = await start({ audit: path.join(ro, "a.jsonl") });
      const r = await get(base);
      expect(r.status).toBe(503);
      expect(r.body.checks.auditWritable).toBe("fail");
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("existing read-only audit file -> fail", async () => {
    okBt();
    const f = path.join(dir, "ro-file.jsonl");
    writeFileSync(f, "");
    chmodSync(f, 0o400);
    const { base } = await start({ audit: f });
    const r = await get(base);
    expect(r.body.checks.auditWritable).toBe("fail");
  });

  it("missing parent directory is created and counts as ok", async () => {
    okBt();
    const { base } = await start({ audit: path.join(dir, "new", "deep", "a.jsonl") });
    expect((await get(base)).body.checks.auditWritable).toBe("ok");
  });
});

describe("TM2-5 edge: routing and auth", () => {
  it.each([
    ["no auth", {}],
    ["wrong bearer", { Authorization: "Bearer nope" }],
    ["valid bearer", { Authorization: `Bearer ${TOKEN}` }],
    ["garbage auth", { Authorization: "Basic xxx" }],
  ])("%s -> same 200 result", async (_n, headers) => {
    okBt();
    const { base } = await start();
    const r = await get(base, "/readyz", { headers: headers as Record<string, string> });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, checks: { openalgo: "ok", bt: "ok", auditWritable: "ok" } });
  });

  it("query params do not change the result or bypass the cache", async () => {
    const f = okBt();
    const { base, analyzerStatus } = await start();
    const a = await get(base, "/readyz");
    const b = await get(base, "/readyz?nocache=1&token=x");
    const c = await get(base, "/readyz?");
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
    expect(analyzerStatus).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("%s /readyz -> 405 Allow GET, no upstream call", async (method) => {
    const f = okBt();
    const { base, analyzerStatus } = await start();
    const r = await get(base, "/readyz", { method, body: method === "DELETE" ? undefined : "{}" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
    expect(analyzerStatus).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it("HEAD /readyz is not a 2xx readiness answer without a check (report: 405)", async () => {
    okBt();
    const { base } = await start();
    const r = await realFetch(base + "/readyz", { method: "HEAD" });
    expect(r.status).toBe(405);
  });

  it("/readyz/ and /READYZ are not aliases (404)", async () => {
    okBt();
    const { base } = await start();
    expect((await get(base, "/readyz/")).status).toBe(404);
    expect((await get(base, "/READYZ")).status).toBe(404);
  });

  it("/healthz unchanged: GET body, POST 404, no auth needed", async () => {
    const { base } = await start({ oa: async () => { throw new Error("down"); } });
    const r = await get(base, "/healthz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: "paper" });
    expect((await get(base, "/healthz", { method: "POST" })).status).toBe(404);
  });
});

describe("TM2-5 edge: deploy/Caddyfile", () => {
  it("does not route /readyz to the public site", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const caddy = readFileSync(path.join(here, "..", "..", "deploy", "Caddyfile"), "utf8");
    expect(caddy).not.toMatch(/readyz/i);
    const allowed = /@allowed\s+path\s+([^\n]+)/.exec(caddy)![1].trim().split(/\s+/);
    const matches = (pat: string, p: string) =>
      pat.endsWith("*") ? p.startsWith(pat.slice(0, -1)) : pat === p;
    expect(allowed.some((pat) => matches(pat, "/readyz"))).toBe(false);
    expect(allowed).toContain("/healthz");
  });
});
