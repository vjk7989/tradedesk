import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BacktestClient, BacktestError } from "../src/backtest/client.js";
import { createBindings } from "../src/sdk/bindings.js";
import { createMcpServer } from "../src/server.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const TOKEN = "bt-edge-token-SECRET-123";
const OPEN = new Date("2026-01-07T04:30:00Z");
const jr = (b: unknown, status = 200) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status });
const req = { code: "class SignalEngine: pass", symbols: ["RELIANCE.NS"], start: "2024-01-01", end: "2024-06-01" };
const mkc = (f: unknown, extra: Record<string, unknown> = {}) =>
  new BacktestClient({ baseUrl: "http://bt:8000", token: TOKEN, fetchImpl: f as typeof fetch, ...extra });
const errOf = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected rejection"); }, (e) => e as BacktestError);

let dir: string;
let client: any;

function setup(opts: { mode?: "paper" | "live"; bt?: unknown; auditFile?: string } = {}) {
  const mode = opts.mode ?? "paper";
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const kill = path.join(dir, "KILL");
  const engine = new RiskEngine(risk as any, { mode, killSwitchFile: kill, stateFile: path.join(dir, "st.json"), now: () => OPEN });
  const cfg = { mode, risk, killSwitchFile: kill } as unknown as Config;
  const auditFile = opts.auditFile ?? path.join(dir, "audit.log");
  const deps = { client, risk: engine, cfg, auditFile, bt: opts.bt as any };
  const b = createBindings(deps, { id: "r1" }) as any;
  return { b, engine, cfg, kill, auditFile, deps };
}
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const fakeBt = (result: unknown) => ({ run: vi.fn(async (_r: any) => result) });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bte-"));
  client = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : vi.fn(async () => { throw new Error("broker touched: " + String(k)); })) });
});

describe("BacktestClient request", () => {
  it("POSTs {btUrl}/backtest with Bearer token and exact body keys (no timeout/apikey)", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => jr({ ok: true }));
    const full = { ...req, interval: "1D", capital: 1e6, costs: { fee: 1 }, source: "auto", signal_parameters: { a: 1 } };
    await mkc(f).run(full);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://bt:8000/backtest");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["capital", "code", "costs", "end", "interval", "signal_parameters", "source", "start", "symbols"]);
    expect(body).toEqual(full);
    expect(init.body as string).not.toContain(TOKEN);
  });
  it.each([
    ["http://bt:8000/", "http://bt:8000/backtest"],
    ["http://bt:8000///", "http://bt:8000/backtest"],
    ["http://h/prefix/api", "http://h/prefix/api/backtest"],
    ["http://h/prefix/api/", "http://h/prefix/api/backtest"],
  ])("btUrl %s -> %s", async (base, want) => {
    const f = vi.fn(async (_u: string) => jr({ ok: true }));
    await new BacktestClient({ baseUrl: base, token: TOKEN, fetchImpl: f as any }).run(req);
    expect(f.mock.calls[0][0]).toBe(want);
  });
});

describe("BacktestClient errors", () => {
  it.each([
    [401, /rejected the token \(401\)/],
    [503, /not configured \(503\)/],
    [429, /^backtest service busy, retry later$/],
    [413, /too large \(413\)/],
    [500, /service error \(500\)/],
    [502, /service error \(502\)/],
    [404, /service error \(404\)/],
    [302, /service error \(302\)/],
  ])("status %i mapped", async (s, re) => {
    const e = await errOf(mkc(async () => new Response("x", { status: s })).run(req));
    expect(e).toBeInstanceOf(BacktestError);
    expect(e.message).toMatch(re);
    expect(e.httpStatus).toBe(s);
  });
  it("422 includes first 500 chars only, token redacted", async () => {
    const body = `bad ${TOKEN} ` + "y".repeat(2000);
    const e = await errOf(mkc(async () => jr(body, 422)).run(req));
    expect(e.httpStatus).toBe(422);
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).toContain("[REDACTED]");
    const detail = e.message.replace(/^backtest request invalid \(422\): /, "");
    expect(detail.length).toBeLessThanOrEqual(500 + "[REDACTED]".length);
    expect(e.message).not.toContain("y".repeat(600));
  });
  it("422 with token straddling the 500 char cut does not leak a partial token", async () => {
    const body = "z".repeat(490) + TOKEN;
    const e = await errOf(mkc(async () => jr(body, 422)).run(req));
    expect(e.message).not.toContain(TOKEN.slice(0, 10));
  });
  it("non-JSON 200 mapped", async () => {
    const e = await errOf(mkc(async () => jr("<html>", 200)).run(req));
    expect(e.message).toMatch(/non-JSON/);
  });
  it("empty 200 body mapped to non-JSON", async () => {
    const e = await errOf(mkc(async () => new Response("", { status: 200 })).run(req));
    expect(e.message).toMatch(/non-JSON/);
  });
  it("network error is redacted (code containing the token is not echoed)", async () => {
    const f = vi.fn(async (_u: string, i: RequestInit) => { throw new Error("boom " + i.body + " " + TOKEN); });
    const e = await errOf(mkc(f).run({ ...req, code: `x = "${TOKEN}"` }));
    expect(e.message).toMatch(/unreachable/);
    expect(e.message).not.toContain(TOKEN);
  });
  it("5xx body containing the code+token is not echoed", async () => {
    const e = await errOf(mkc(async () => jr(`trace ${TOKEN}`, 500)).run({ ...req, code: TOKEN }));
    expect(e.message).not.toContain(TOKEN);
  });
});

describe("BacktestClient timeout", () => {
  it("fetch never resolves -> timeout error and abort signalled", async () => {
    let sig: AbortSignal | undefined;
    const f = vi.fn((_u: string, i: RequestInit) => { sig = i.signal!; return new Promise<Response>(() => {}); });
    const e = await errOf(mkc(f, { timeoutMs: 30 }).run(req));
    expect(e.message).toMatch(/timeout after 30ms/);
    expect(sig?.aborted).toBe(true);
  });
  it("body read hangs -> timeout", async () => {
    const f = async () => ({ status: 200, text: () => new Promise<string>(() => {}) }) as unknown as Response;
    const e = await errOf(mkc(f, { timeoutMs: 30 }).run(req));
    expect(e.message).toMatch(/timeout/);
  });
  it("default timeout is 180000ms", async () => {
    vi.useFakeTimers();
    try {
      const p = errOf(mkc(() => new Promise<Response>(() => {})).run(req));
      await vi.advanceTimersByTimeAsync(179999);
      let settled = false;
      p.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await p).message).toMatch(/timeout after 180000ms/);
    } finally {
      vi.useRealTimers();
    }
  });
  it("concurrent 3 calls are independent", async () => {
    const f = vi.fn(async (_u: string, i: RequestInit) => {
      const b = JSON.parse(i.body as string);
      await new Promise((r) => setTimeout(r, 30 - b.symbols[0].length));
      return jr({ ok: true, metrics: { sym: b.symbols[0] } });
    });
    const c = mkc(f);
    const out = await Promise.all(["A", "BB", "CCC"].map((s) => c.run({ ...req, symbols: [s] })));
    expect(out.map((o) => o.metrics!.sym)).toEqual(["A", "BB", "CCC"]);
  });
});

describe("backtest.run binding", () => {
  it("not configured -> throws, audited as error", async () => {
    const { b, auditFile } = setup();
    await expect(b.backtest.run(req)).rejects.toThrow("backtest service not configured");
    const l = lines(auditFile);
    expect(l[0]).toMatchObject({ action: "backtest.run", decision: "error" });
  });
  it.each(["timeout", "apikey", "signal_parameters", "foo"])("unknown field %s rejected without calling service", async (k) => {
    const bt = fakeBt({ ok: true });
    const { b } = setup({ bt });
    await expect(b.backtest.run({ ...req, [k]: 1 })).rejects.toThrow(/unknown field/);
    expect(bt.run).not.toHaveBeenCalled();
  });
  it("unknown-field rejection is audited as error without the code body", async () => {
    const bt = fakeBt({ ok: true });
    const { b, auditFile } = setup({ bt });
    await expect(b.backtest.run({ ...req, code: "MARKER-BODY", timeout: 5 })).rejects.toThrow(/unknown field/);
    expect(readFileSync(auditFile, "utf8")).not.toContain("MARKER-BODY");
    expect(lines(auditFile)[0]).toMatchObject({ action: "backtest.run", decision: "error" });
  });
  it.each([undefined, null, "x", 5])("non-object args %s rejected", async (a) => {
    const bt = fakeBt({ ok: true });
    await expect(setup({ bt }).b.backtest.run(a)).rejects.toThrow();
    expect(bt.run).not.toHaveBeenCalled();
  });
  it.each(["code", "symbols", "start", "end"])("missing %s rejected", async (k) => {
    const bt = fakeBt({ ok: true });
    const a: any = { ...req };
    delete a[k];
    await expect(setup({ bt }).b.backtest.run(a)).rejects.toThrow(/missing field/);
    expect(bt.run).not.toHaveBeenCalled();
  });
  it.each([["RELIANCE.NS"].join(), [1], [null]])("bad symbols %j rejected", async (s) => {
    const bt = fakeBt({ ok: true });
    await expect(setup({ bt }).b.backtest.run({ ...req, symbols: s })).rejects.toThrow();
    expect(bt.run).not.toHaveBeenCalled();
  });
  it("params -> signal_parameters; body keys exact; optional omitted when absent", async () => {
    const bt = fakeBt({ ok: true });
    const { b } = setup({ bt });
    await b.backtest.run({ ...req, interval: "1H", capital: 5000, costs: { c: 1 }, source: "binance", params: { fast: 5 } });
    expect(bt.run.mock.calls[0][0]).toEqual({ ...req, interval: "1H", capital: 5000, costs: { c: 1 }, source: "binance", signal_parameters: { fast: 5 } });
    await b.backtest.run(req);
    expect(Object.keys(bt.run.mock.calls[1][0]).sort()).toEqual(["code", "end", "start", "symbols"]);
  });
  it("returns summary shape with defaults; ok:false passes through", async () => {
    const { b } = setup({ bt: fakeBt({ ok: false, error: "SignalEngine missing" }) });
    expect(await b.backtest.run(req)).toEqual({ ok: false, metrics: {}, equity: [], trades: [], tradeCount: 0, warnings: [], error: "SignalEngine missing" });
  });
  const eq = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, value: i }));
  it.each([0, 1, 2, 99, 100])("equity of %i points kept as-is", async (n) => {
    const { b } = setup({ bt: fakeBt({ ok: true, equity: eq(n) }) });
    expect((await b.backtest.run(req)).equity).toEqual(eq(n));
  });
  it.each([101, 1000, 100000])("equity of %i points downsampled to 100, first & last kept, ordered", async (n) => {
    const { b } = setup({ bt: fakeBt({ ok: true, equity: eq(n) }) });
    const e = (await b.backtest.run(req)).equity;
    expect(e.length).toBe(100);
    expect(e[0]).toEqual({ date: "d0", value: 0 });
    expect(e[99]).toEqual({ date: `d${n - 1}`, value: n - 1 });
    for (let i = 1; i < e.length; i++) expect(e[i].value).toBeGreaterThan(e[i - 1].value);
  });
  it("equity with null/NaN values does not throw and stays JSON-serialisable", async () => {
    const pts = [{ date: "a", value: null }, { date: "b", value: NaN }, { date: "c", value: 1 }];
    const { b } = setup({ bt: fakeBt({ ok: true, equity: pts }) });
    const r = await b.backtest.run(req);
    expect(r.equity.length).toBe(3);
    expect(() => JSON.stringify(r)).not.toThrow();
  });
  it.each([[20, 20], [21, 20], [0, 0], [1000, 20]])("trades %i -> %i kept, tradeCount exact", async (n, kept) => {
    const trades = Array.from({ length: n }, (_, i) => ({ i }));
    const { b } = setup({ bt: fakeBt({ ok: true, trades }) });
    const r = await b.backtest.run(req);
    expect(r.trades.length).toBe(kept);
    expect(r.tradeCount).toBe(n);
    if (kept) expect(r.trades[0]).toEqual({ i: 0 });
  });
  it("audit has codeLength + sha256 (unicode), never the code body", async () => {
    const code = "# 注文 ₹ 🚀\nclass SignalEngine: pass  # MARKER-BODY";
    const { b, auditFile } = setup({ bt: fakeBt({ ok: true }) });
    await b.backtest.run({ ...req, code });
    const raw = readFileSync(auditFile, "utf8");
    expect(raw).not.toContain("MARKER-BODY");
    const l = lines(auditFile)[0];
    expect(l.action).toBe("backtest.run");
    expect(l.decision).toBe("allowed");
    expect(l.args.code).toBeUndefined();
    expect(l.args.codeLength).toBe(code.length);
    expect(l.args.codeSha256).toBe(createHash("sha256").update(code, "utf8").digest("hex"));
  });
  it("error path audit also omits the code body and token", async () => {
    const c = mkc(async () => jr(`echo ${TOKEN}`, 422));
    const { b, auditFile } = setup({ bt: c });
    const e = await b.backtest.run({ ...req, code: `MARKER ${TOKEN}` }).catch((x: Error) => x);
    expect(e.message).not.toContain(TOKEN);
    const raw = readFileSync(auditFile, "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("MARKER");
    expect(lines(auditFile)[0].decision).toBe("error");
  });
  it.each(["paper", "live"] as const)("kill switch on (%s): backtest works, never touches broker/risk", async (mode) => {
    const bt = fakeBt({ ok: true, metrics: { sharpe: 1 } });
    const { b, kill, engine } = setup({ mode, bt });
    writeFileSync(kill, "1");
    const spies = Object.getOwnPropertyNames(Object.getPrototypeOf(engine))
      .filter((k) => k !== "constructor" && typeof (engine as any)[k] === "function")
      .map((k) => vi.spyOn(engine as any, k));
    const r = await b.backtest.run(req);
    expect(r.ok).toBe(true);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    // client is a Proxy that throws on any method call; reaching here means none was invoked
  });
  it("audit file unwritable -> backtest still returns (not fail-closed; backtests are not orders)", async () => {
    const auditDir = path.join(dir, "auditdir");
    mkdirSync(auditDir);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { b } = setup({ bt: fakeBt({ ok: true }), auditFile: auditDir });
    await expect(b.backtest.run(req)).resolves.toMatchObject({ ok: true });
    err.mockRestore();
  });
  it("concurrent 3 binding calls independent", async () => {
    const bt = { run: vi.fn(async (r: any) => { await new Promise((x) => setTimeout(x, 10)); return { ok: true, metrics: { s: r.symbols[0] } }; }) };
    const { b, auditFile } = setup({ bt });
    const out = await Promise.all(["A", "B", "C"].map((s) => b.backtest.run({ ...req, symbols: [s] })));
    expect(out.map((o: any) => o.metrics.s)).toEqual(["A", "B", "C"]);
    expect(lines(auditFile).length).toBe(3);
  });
});

describe("backtest via MCP execute", () => {
  it("await backtest.run(...) returns summarised JSON", async () => {
    const { deps } = setup({ bt: fakeBt({ ok: true, metrics: { cagr: 0.1 }, equity: Array.from({ length: 500 }, (_, i) => ({ date: `d${i}`, value: i })), trades: Array.from({ length: 30 }, (_, i) => ({ i })) }) });
    const server = createMcpServer(deps as any);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(ct);
    const code = `const r = await backtest.run(${JSON.stringify(req)}); return { ok: r.ok, n: r.equity.length, t: r.trades.length, tc: r.tradeCount, m: r.metrics };`;
    const r: any = await c.callTool({ name: "execute", arguments: { code } });
    const txt: string = r.content[0].text;
    const out = JSON.parse(txt.split("\n").slice(1).join("\n"));
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ ok: true, n: 100, t: 20, tc: 30, m: { cagr: 0.1 } });
    await c.close();
    expect(existsSync(deps.auditFile)).toBe(true);
  });
});
