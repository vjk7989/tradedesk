import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import type { Config } from "../src/config.js";

const TOKEN = "tok_SECRETMCP_" + "z".repeat(20);
const API_KEY = "oa_SECRETKEY_" + "k".repeat(20);
const BT_TOKEN = "bt_SECRETTOK_" + "b".repeat(20);
const BT_URL = "http://bt-secret-host.invalid:9999/";
const SECRETS = [TOKEN, API_KEY, BT_TOKEN, "bt-secret-host", "SECRETKEY", "boom"];

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
});

const dir = mkdtempSync(path.join(tmpdir(), "readyz-"));
const goodAudit = () => path.join(dir, "ok", "a.jsonl");
const flat = path.join(dir, "flatfile");
writeFileSync(flat, "x");
const dirAudit = path.join(dir, "adir");
mkdirSync(dirAudit);

interface Opts { oa?: () => Promise<any>; bt?: boolean; audit?: string }
async function start(o: Opts = {}) {
  const cfg = {
    mode: "paper", mcpToken: TOKEN, openalgoApiKey: API_KEY, btToken: BT_TOKEN,
    btUrl: o.bt === false ? undefined : BT_URL,
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
const get = async (base: string, p = "/readyz") => {
  const r = await realFetch(base + p);
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text), headers: r.headers };
};

describe("GET /readyz matrix", () => {
  const oaCases = { ok: async () => ({ status: "success" }), fail: async () => { throw new Error("boom " + API_KEY); } };
  const btCases = ["ok", "fail", "not_configured"] as const;
  const auditCases = { ok: undefined, fail: path.join(flat, "child", "a.jsonl") };
  for (const oa of ["ok", "fail"] as const)
    for (const bt of btCases)
      for (const au of ["ok", "fail"] as const)
        it(`openalgo=${oa} bt=${bt} audit=${au}`, async () => {
          stubBt(async () => new Response("", { status: bt === "ok" ? 200 : 500 }));
          const { base } = await start({ oa: oaCases[oa], bt: bt !== "not_configured", audit: auditCases[au] });
          const r = await get(base);
          const expectOk = oa === "ok" && bt !== "fail" && au === "ok";
          expect(r.status).toBe(expectOk ? 200 : 503);
          expect(r.body).toEqual({ ok: expectOk, checks: { openalgo: oa, bt, auditWritable: au } });
        });

  it("non-success openalgo status and bt rejection are fail", async () => {
    stubBt(async () => { throw new Error("conn refused " + BT_URL); });
    const { base } = await start({ oa: async () => ({ status: "error" }) });
    const r = await get(base);
    expect(r.status).toBe(503);
    expect(r.body.checks).toMatchObject({ openalgo: "fail", bt: "fail" });
  });

  it("audit path that is a directory fails", async () => {
    stubBt(async () => new Response("ok"));
    const { base } = await start({ audit: dirAudit });
    const r = await get(base);
    expect(r.status).toBe(503);
    expect(r.body.checks.auditWritable).toBe("fail");
  });

  it("strips trailing slash from btUrl", async () => {
    const f = stubBt(async () => new Response("ok"));
    const { base } = await start();
    await get(base);
    expect(f.mock.calls[0][0]).toBe("http://bt-secret-host.invalid:9999/healthz");
  });
});

describe("timeouts", () => {
  it("never-resolving upstreams fail at ~3s (real timers)", async () => {
    stubBt((_u, init) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    const { base } = await start({ oa: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await get(base);
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(r.status).toBe(503);
    expect(r.body.checks).toEqual({ openalgo: "fail", bt: "fail", auditWritable: "ok" });
  }, 10000);
});

describe("no secrets", () => {
  it("leaks nothing in body or headers", async () => {
    stubBt(async () => { throw new Error(`fail ${BT_URL} ${BT_TOKEN}`); });
    const { base } = await start({ oa: async () => { throw new Error(`boom ${API_KEY} ${TOKEN}`); }, audit: path.join(flat, "x") });
    const r = await get(base);
    expect(r.status).toBe(503);
    const all = r.text + JSON.stringify([...r.headers]);
    for (const s of SECRETS) expect(all).not.toContain(s);
    expect(Object.keys(r.body).sort()).toEqual(["checks", "ok"]);
  });
});

describe("cache", () => {
  it("serves cached result for 5s, recomputes after (incl. cached 503)", async () => {
    const f = stubBt(async () => new Response("ok"));
    const { base, analyzerStatus } = await start({ oa: async () => { throw new Error("x"); } });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    expect((await get(base)).status).toBe(503);
    now.mockReturnValue(1_004_999);
    expect((await get(base)).status).toBe(503);
    expect(analyzerStatus).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_005_000);
    await get(base);
    expect(analyzerStatus).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("concurrent requests share one in-flight computation", async () => {
    stubBt(async () => new Response("ok"));
    let release!: () => void;
    const { base, analyzerStatus } = await start({
      oa: () => new Promise((r) => { release = () => r({ status: "success" }); }),
    });
    const ps = [get(base), get(base), get(base)];
    await vi.waitFor(() => expect(analyzerStatus).toHaveBeenCalled());
    release();
    const rs = await Promise.all(ps);
    expect(analyzerStatus).toHaveBeenCalledTimes(1);
    rs.forEach((r) => expect(r.status).toBe(200));
  });
});

describe("routing", () => {
  it("needs no auth", async () => {
    stubBt(async () => new Response("ok"));
    const { base } = await start();
    const r = await realFetch(base + "/readyz");
    expect(r.status).toBe(200);
  });

  it("non-GET gets 405 with Allow: GET", async () => {
    const { base } = await start();
    const r = await realFetch(base + "/readyz", { method: "POST" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
  });

  it("/healthz unchanged", async () => {
    const { base } = await start();
    const r = await get(base, "/healthz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: "paper" });
  });
});
