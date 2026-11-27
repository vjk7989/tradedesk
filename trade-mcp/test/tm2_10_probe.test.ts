import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { probeAuditWritable } from "../src/risk/audit-probe.js";
import { createHttpServer } from "../src/http.js";
import { createBindings } from "../src/sdk/bindings.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const dir = mkdtempSync(path.join(tmpdir(), "tm210-"));
const realFetch = globalThis.fetch;
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
});

describe("probeAuditWritable", () => {
  it("ok on writable path and creates missing dirs", () => {
    const f = path.join(dir, "a", "b", "audit.jsonl");
    expect(() => probeAuditWritable(f)).not.toThrow();
    expect(existsSync(f)).toBe(true);
    expect(() => probeAuditWritable(f)).not.toThrow();
  });
  it("throws when path is a directory", () => {
    const d = path.join(dir, "isdir");
    mkdirSync(d);
    expect(() => probeAuditWritable(d)).toThrow("audit path is a directory");
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("throws on read-only dir", () => {
    const d = path.join(dir, "ro");
    mkdirSync(d);
    chmodSync(d, 0o500);
    try { expect(() => probeAuditWritable(path.join(d, "a.jsonl"))).toThrow(); } finally { chmodSync(d, 0o700); }
  });
});

describe("order path", () => {
  it("refuses with the same message when the shared probe fails", async () => {
    const d = path.join(dir, "orderdir");
    mkdirSync(d);
    const OPEN = new Date("2026-01-07T04:30:00Z");
    const risk = {
      allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
    };
    const engine = new RiskEngine(risk, { mode: "paper", killSwitchFile: path.join(dir, "KILL"), stateFile: path.join(dir, "st.json"), now: () => OPEN });
    const client: any = {
      quotes: vi.fn(async () => ({ status: "success", data: { ltp: 200 } })),
      analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
      pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
      placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    };
    const cfg = { mode: "paper", risk, killSwitchFile: path.join(dir, "KILL") } as unknown as Config;
    const b: any = createBindings({ client, risk: engine, cfg, auditFile: d }, { id: "r1" });
    await expect(b.trade.place({ symbol: "SBIN", exchange: "NSE", side: "BUY", quantity: 10, product: "MIS", priceType: "LIMIT", price: 100 }))
      .rejects.toThrow("audit log unavailable — order refused");
    expect(client.placeOrder).not.toHaveBeenCalled();
  });
});

async function start(bt: (url: string, init?: RequestInit) => Promise<Response>) {
  const cfg = { mode: "paper", mcpToken: "t".repeat(24), btUrl: "http://bt.invalid:9/" } as unknown as Config;
  const srv = createHttpServer(
    { cfg, client: { analyzerStatus: async () => ({ status: "success" }) } as any, risk: {} as any, auditFile: path.join(dir, "rz", "a.jsonl") },
    undefined,
  );
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const f = vi.fn(bt);
  vi.stubGlobal("fetch", (u: any, i?: any) => (String(u).startsWith("http://127.0.0.1") ? realFetch(u, i) : f(String(u), i)));
  const r = await realFetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/readyz`);
  return { status: r.status, body: await r.json() as any, f };
}

describe("/readyz bt check", () => {
  it("2xx is ok and passes redirect manual", async () => {
    const { status, body, f } = await start(async () => new Response("ok", { status: 200 }));
    expect(status).toBe(200);
    expect(body.checks.bt).toBe("ok");
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
  });
  it.each([301, 302, 307])("%i is fail and 503", async (code) => {
    const { status, body, f } = await start(async () => new Response(null, { status: code, headers: { location: "http://elsewhere.invalid/" } }));
    expect(status).toBe(503);
    expect(body.checks.bt).toBe("fail");
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
  });
  it("opaqueredirect response is fail", async () => {
    const { body } = await start(async () => ({ ok: false, status: 0, type: "opaqueredirect" }) as unknown as Response);
    expect(body.checks.bt).toBe("fail");
  });
  it("hung fetch is aborted after 3s and reports fail", async () => {
    let signal: AbortSignal | undefined;
    const { status, body } = await start((_u, init) => new Promise<Response>((_, rej) => {
      signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => rej(signal!.reason));
    }));
    expect(signal?.aborted).toBe(true);
    expect(status).toBe(503);
    expect(body.checks.bt).toBe("fail");
  }, 10000);
});
