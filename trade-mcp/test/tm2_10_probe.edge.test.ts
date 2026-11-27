import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { probeAuditWritable } from "../src/risk/audit-probe.js";
import { createHttpServer } from "../src/http.js";
import { createBindings } from "../src/sdk/bindings.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const root = mkdtempSync(path.join(tmpdir(), "tm210e-"));
let n = 0;
const fresh = () => { const d = path.join(root, `c${n++}`); mkdirSync(d); return d; };
const posixNonRoot = process.platform !== "win32" && process.getuid?.() !== 0;

const realFetch = globalThis.fetch;
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
});

// ---------------------------------------------------------------- probe
describe("probeAuditWritable edges", () => {
  it.skipIf(process.platform === "win32")("symlink pointing at a directory is refused", () => {
    const d = fresh();
    const target = path.join(d, "realdir");
    mkdirSync(target);
    const link = path.join(d, "audit.jsonl");
    symlinkSync(target, link, "dir");
    expect(() => probeAuditWritable(link)).toThrow("audit path is a directory");
  });

  it.skipIf(process.platform === "win32")("symlink pointing at a regular file is accepted and the target is untouched", () => {
    const d = fresh();
    const target = path.join(d, "real.jsonl");
    writeFileSync(target, "line1\n");
    const link = path.join(d, "audit.jsonl");
    symlinkSync(target, link);
    expect(() => probeAuditWritable(link)).not.toThrow();
    expect(readFileSync(target, "utf8")).toBe("line1\n");
  });

  it("parent path is a regular file (mkdir fails) -> throws", () => {
    const d = fresh();
    const blocker = path.join(d, "blocker");
    writeFileSync(blocker, "x");
    expect(() => probeAuditWritable(path.join(blocker, "audit.jsonl"))).toThrow();
    expect(readFileSync(blocker, "utf8")).toBe("x");
  });

  it("grandparent is a regular file -> throws", () => {
    const d = fresh();
    const blocker = path.join(d, "blocker");
    writeFileSync(blocker, "x");
    expect(() => probeAuditWritable(path.join(blocker, "sub", "audit.jsonl"))).toThrow();
  });

  it.skipIf(!posixNonRoot)("existing read-only file (0400) -> throws", () => {
    const d = fresh();
    const f = path.join(d, "audit.jsonl");
    writeFileSync(f, "keep\n");
    chmodSync(f, 0o400);
    try {
      expect(() => probeAuditWritable(f)).toThrow();
      expect(readFileSync(f, "utf8")).toBe("keep\n");
    } finally {
      chmodSync(f, 0o600);
    }
  });

  it.each([
    ["unicode", path.join("ünïcødé-日本語", "審計.jsonl")],
    ["spaces", path.join("dir with spaces", "audit log.jsonl")],
    ["emoji+spaces", path.join("a b 🚀", "c d", "x y.jsonl")],
  ])("%s path is created and accepted", (_name, rel) => {
    const f = path.join(fresh(), rel);
    expect(() => probeAuditWritable(f)).not.toThrow();
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).isFile()).toBe(true);
    expect(statSync(f).size).toBe(0);
  });

  it("never truncates an existing file and never appends to it", () => {
    const d = fresh();
    const f = path.join(d, "audit.jsonl");
    const content = '{"a":1}\n{"b":2}\n'.repeat(1000);
    writeFileSync(f, content);
    for (let i = 0; i < 5; i++) probeAuditWritable(f);
    expect(readFileSync(f, "utf8")).toBe(content);
  });

  it("does not change the mtime of an existing file", () => {
    const d = fresh();
    const f = path.join(d, "audit.jsonl");
    writeFileSync(f, "x\n");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(f, old, old);
    const before = statSync(f).mtimeMs;
    probeAuditWritable(f);
    expect(Math.abs(statSync(f).mtimeMs - before)).toBeLessThan(1000);
  });

  it("concurrent probes on a fresh path all succeed and leave one empty file", async () => {
    const d = fresh();
    const f = path.join(d, "deep", "er", "audit.jsonl");
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => Promise.resolve().then(() => probeAuditWritable(f))),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(readdirSync(path.dirname(f))).toEqual(["audit.jsonl"]);
    expect(statSync(f).size).toBe(0);
  });

  it("concurrent probes while another writer appends do not lose data", async () => {
    const d = fresh();
    const f = path.join(d, "audit.jsonl");
    writeFileSync(f, "");
    const lines: string[] = [];
    await Promise.all(Array.from({ length: 30 }, (_, i) => Promise.resolve().then(() => {
      probeAuditWritable(f);
      const l = `line${i}\n`;
      lines.push(l);
      writeFileSync(f, l, { flag: "a" });
    })));
    expect(readFileSync(f, "utf8")).toBe(lines.join(""));
  });
});

// ---------------------------------------------------------------- order path
const OPEN = new Date("2026-01-07T04:30:00Z"); // Wed 10:00 IST
const RISK = {
  allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
  maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
};
const ORDER = { symbol: "SBIN", exchange: "NSE", side: "BUY", quantity: 10, product: "MIS", priceType: "LIMIT", price: 100 };

function setup(auditFile: string, mode: "paper" | "live" = "paper") {
  const d = fresh();
  const engine = new RiskEngine(RISK as any, { mode, killSwitchFile: path.join(d, "KILL"), stateFile: path.join(d, "st.json"), now: () => OPEN });
  const client: any = {
    quotes: vi.fn(async () => ({ status: "success", data: { ltp: 100 } })),
    analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
    pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
    placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    modifyOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    cancelOrder: vi.fn(async () => ({ status: "success" })),
    closePosition: vi.fn(async () => ({ status: "success" })),
  };
  const cfg = { mode, risk: RISK, killSwitchFile: path.join(d, "KILL") } as unknown as Config;
  const b: any = createBindings({ client, risk: engine, cfg, auditFile }, { id: "r1" });
  return { b, client, engine };
}

const failingAuditPaths: Array<[string, () => string]> = [
  ["audit path is a directory", () => { const d = path.join(fresh(), "isdir"); mkdirSync(d); return d; }],
  ["parent is a file", () => { const p = path.join(fresh(), "blk"); writeFileSync(p, "x"); return path.join(p, "a.jsonl"); }],
  ...(process.platform !== "win32"
    ? [["symlink to dir", () => { const d = fresh(); mkdirSync(path.join(d, "t")); symlinkSync(path.join(d, "t"), path.join(d, "a.jsonl"), "dir"); return path.join(d, "a.jsonl"); }] as [string, () => string]]
    : []),
  ...(posixNonRoot
    ? [["read-only file", () => { const f = path.join(fresh(), "a.jsonl"); writeFileSync(f, ""); chmodSync(f, 0o400); return f; }] as [string, () => string]]
    : []),
];

describe("order path refuses when the shared probe fails", () => {
  // Every caller of auditAttempt in bindings.ts: trade.place and trade.modify.
  describe.each(failingAuditPaths)("%s", (_name, mk) => {
    it.each(["paper", "live"] as const)("trade.place (%s) refuses, broker never called, no reservation leaked", async (mode) => {
      const { b, client, engine } = setup(mk(), mode);
      await expect(b.trade.place(ORDER)).rejects.toThrow(/^audit log unavailable — order refused$/);
      expect(client.placeOrder).not.toHaveBeenCalled();
      expect(engine.status().today.orders).toBe(0);
      expect(engine.status().today.notional).toBe(0);
    });

    it.each(["paper", "live"] as const)("trade.modify (%s) refuses, broker never called", async (mode) => {
      const { b, client } = setup(mk(), mode);
      await expect(b.trade.modify({ ...ORDER, orderId: "42" })).rejects.toThrow(/^audit log unavailable — order refused$/);
      expect(client.modifyOrder).not.toHaveBeenCalled();
    });
  });

  it("the exact message is used (em dash, no underlying fs error leaked)", async () => {
    const { b } = setup(failingAuditPaths[0][1]());
    const err = await b.trade.place(ORDER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("audit log unavailable — order refused");
  });

  it("per-run counter is released: after the audit path is fixed, maxOrdersPerRun orders still go through", async () => {
    const d = fresh();
    const f = path.join(d, "a.jsonl");
    mkdirSync(f); // make the path a directory first
    const { b, client } = setup(f);
    for (let i = 0; i < 7; i++) await expect(b.trade.place(ORDER)).rejects.toThrow("audit log unavailable — order refused");
    // fix it
    const { rmdirSync } = await import("node:fs");
    rmdirSync(f);
    for (let i = 0; i < RISK.maxOrdersPerRun; i++) await expect(b.trade.place(ORDER)).resolves.toBeTruthy();
    expect(client.placeOrder).toHaveBeenCalledTimes(RISK.maxOrdersPerRun);
  });

  it("happy path control: a writable unicode/space path lets place and modify through", async () => {
    const f = path.join(fresh(), "ä b", "audit log.jsonl");
    const { b, client } = setup(f);
    await expect(b.trade.place(ORDER)).resolves.toBeTruthy();
    await expect(b.trade.modify({ ...ORDER, orderId: "42" })).resolves.toBeTruthy();
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(client.modifyOrder).toHaveBeenCalledTimes(1);
  });

  it("cancel / closePosition are risk-reducing and are not gated by the probe", async () => {
    const { b, client } = setup(failingAuditPaths[0][1]());
    await expect(b.trade.cancel({ orderId: "1" })).resolves.toBeTruthy();
    await expect(b.trade.closePosition({})).resolves.toBeTruthy();
    expect(client.cancelOrder).toHaveBeenCalled();
    expect(client.closePosition).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- /readyz bt
const TOKEN = "tok_SECRET_".padEnd(32, "z");
const BT_SECRET = "btsecretpw";

async function readyz(
  bt: (url: string, init?: RequestInit) => Promise<Response>,
  btUrl = `http://user:${BT_SECRET}@bt.internal.example:9/`,
) {
  const cfg = { mode: "paper", mcpToken: TOKEN, btUrl } as unknown as Config;
  const srv = createHttpServer(
    { cfg, client: { analyzerStatus: async () => ({ status: "success" }) } as any, risk: {} as any, auditFile: path.join(fresh(), "a.jsonl") },
    undefined,
  );
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const f = vi.fn(bt);
  vi.stubGlobal("fetch", (u: any, i?: any) => (String(u).startsWith("http://127.0.0.1") ? realFetch(u, i) : f(String(u), i)));
  const r = await realFetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/readyz`);
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as any, f };
}

function expectInit(f: ReturnType<typeof vi.fn>) {
  expect(f).toHaveBeenCalledTimes(1);
  const init = f.mock.calls[0][1] as RequestInit;
  expect(init.redirect).toBe("manual");
  expect(init.signal).toBeInstanceOf(AbortSignal);
}

function expectNoLeak(text: string) {
  expect(text).not.toContain(BT_SECRET);
  expect(text).not.toContain("bt.internal");
  expect(text).not.toContain("http");
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("tok_SECRET");
}

describe("/readyz bt edges", () => {
  it.each([300, 301, 302, 303, 304, 307, 308])("%i -> fail / 503", async (code) => {
    const { status, body, text, f } = await readyz(async () => new Response(null, { status: code, headers: { location: "http://elsewhere.invalid/" } }));
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.bt).toBe("fail");
    expectInit(f);
    expectNoLeak(text);
  });

  it.each([200, 204])("%i -> ok / 200", async (code) => {
    const { status, body, text, f } = await readyz(async () => new Response(code === 204 ? null : "ok", { status: code }));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, checks: { openalgo: "ok", bt: "ok", auditWritable: "ok" } });
    expectInit(f);
    expectNoLeak(text);
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503, 504])("%i -> fail / 503", async (code) => {
    const { status, body, text, f } = await readyz(async () => new Response("bt.internal.example error " + BT_SECRET, { status: code }));
    expect(status).toBe(503);
    expect(body.checks.bt).toBe("fail");
    expectInit(f);
    expectNoLeak(text);
  });

  it("fetch rejecting immediately with an error that contains the URL -> fail, no leak", async () => {
    const { status, body, text, f } = await readyz(async (u) => { throw new TypeError(`fetch failed for ${u} token=${TOKEN}`); });
    expect(status).toBe(503);
    expect(body.checks.bt).toBe("fail");
    expectInit(f);
    expectNoLeak(text);
  });

  it("fetch that rejects (with its own error) after the abort fires -> fail", async () => {
    let seen: AbortSignal | undefined;
    const t0 = Date.now();
    const { status, body, f } = await readyz((_u, init) => new Promise<Response>((_, rej) => {
      seen = init!.signal as AbortSignal;
      seen.addEventListener("abort", () => setTimeout(() => rej(new TypeError("socket hang up")), 20));
    }));
    expect(seen?.aborted).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(status).toBe(503);
    expect(body.checks.bt).toBe("fail");
    expectInit(f);
  }, 10000);

  it.each([
    ["http://bt.example:9///", "http://bt.example:9/healthz"],
    ["http://bt.example:9/base//", "http://bt.example:9/base/healthz"],
    ["http://bt.example:9", "http://bt.example:9/healthz"],
  ])("btUrl %s -> fetches %s", async (btUrl, want) => {
    const { f, body } = await readyz(async () => new Response("ok", { status: 200 }), btUrl);
    expect(f.mock.calls[0][0]).toBe(want);
    expect(body.checks.bt).toBe("ok");
  });

  it("body is exactly the fixed shape (enum strings only)", async () => {
    const { body } = await readyz(async () => new Response(null, { status: 302 }));
    expect(Object.keys(body).sort()).toEqual(["checks", "ok"]);
    expect(Object.keys(body.checks).sort()).toEqual(["auditWritable", "bt", "openalgo"]);
    for (const v of Object.values(body.checks)) expect(["ok", "fail", "not_configured"]).toContain(v);
  });
});

// ---------------------------------------------------------------- no duplicate probe
describe("single probe implementation", () => {
  it('"audit path is a directory" appears only in src/risk/audit-probe.ts', () => {
    const srcRoot = path.resolve(__dirname, "..", "src");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|mts|cts)$/.test(e.name) && readFileSync(p, "utf8").includes("audit path is a directory")) {
          hits.push(path.relative(srcRoot, p).split(path.sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    expect(hits).toEqual(["risk/audit-probe.ts"]);
  });

  it("bindings.ts and http.ts both import the shared probe and no longer open the audit file themselves", () => {
    const srcRoot = path.resolve(__dirname, "..", "src");
    for (const rel of ["sdk/bindings.ts", "http.ts"]) {
      const s = readFileSync(path.join(srcRoot, rel), "utf8");
      expect(s).toMatch(/import \{ probeAuditWritable \} from "\.\.?\/(risk\/)?(\.\.\/risk\/)?audit-probe\.js"/);
      expect(s).not.toMatch(/openSync\(/);
    }
  });
});
