import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { BacktestClient, BacktestError } from "../src/backtest/client.js";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const TOKEN = "wf-edge-token-SECRET-456";
const OPEN = new Date("2026-01-07T04:30:00Z");
const jr = (b: unknown, status = 200) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status });
const wreq = {
  code: "class SignalEngine: pass", symbols: ["RELIANCE.NS"], start: "2024-01-01", end: "2024-06-01",
  train_days: 20, test_days: 5, candidates: [{ fast: 5 }],
};
const breq = {
  code: "class SignalEngine: pass", symbols: ["RELIANCE.NS"], start: "2024-01-01", end: "2024-06-01",
  trainDays: 20, testDays: 5, candidates: [{ fast: 5 }],
};
const REQUIRED_KEYS = ["candidates", "code", "end", "start", "symbols", "test_days", "train_days"];
const mkc = (f: unknown, extra: Record<string, unknown> = {}) =>
  new BacktestClient({ baseUrl: "http://bt:8000", token: TOKEN, fetchImpl: f as typeof fetch, ...extra });
const errOf = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected rejection"); }, (e) => e as BacktestError);

let dir: string;
let client: any;

function setup(opts: { mode?: "paper" | "live"; bt?: unknown; scope?: "full" | "readonly" } = {}) {
  const mode = opts.mode ?? "paper";
  const risk = {
    allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
    maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
    maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
  };
  const kill = path.join(dir, "KILL");
  const engine = new RiskEngine(risk as any, { mode, killSwitchFile: kill, stateFile: path.join(dir, "st.json"), now: () => OPEN });
  const cfg = { mode, risk, killSwitchFile: kill } as unknown as Config;
  const auditFile = path.join(dir, "audit.log");
  const deps = { client, risk: engine, cfg, auditFile, bt: opts.bt as any, scope: opts.scope };
  const b = createBindings(deps, { id: "r1" }) as any;
  return { b, engine, kill, auditFile };
}
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const fakeBt = (result: unknown) => ({
  run: vi.fn(async () => { throw new Error("run must not be called"); }),
  walkForward: vi.fn(async (_r: any) => result),
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wfe-"));
  client = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : vi.fn(async () => { throw new Error("broker touched: " + String(k)); })) });
});

describe("walkForward request body (binding -> real client -> fetch)", () => {
  const sent = async (args: Record<string, unknown>) => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => jr({ ok: true }));
    const { b } = setup({ bt: mkc(f) });
    await b.backtest.walkForward(args);
    const [url, init] = f.mock.calls[0];
    return { url, init, body: JSON.parse(init.body as string) };
  };
  it("only required keys when optionals absent; snake_case days; no timeout/apikey", async () => {
    const { url, init, body } = await sent(breq);
    expect(url).toBe("http://bt:8000/walkforward");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(body).sort()).toEqual(REQUIRED_KEYS);
    expect(body).toEqual(wreq);
    expect(init.body as string).not.toContain(TOKEN);
  });
  it("all optionals present -> exactly the 12 request-model keys", async () => {
    const { body } = await sent({ ...breq, metric: "calmar", interval: "1H", capital: 5000, costs: { fee: 1 }, source: "binance" });
    expect(Object.keys(body).sort()).toEqual([...REQUIRED_KEYS, "capital", "costs", "interval", "metric", "source"].sort());
    expect(body).toEqual({ ...wreq, metric: "calmar", interval: "1H", capital: 5000, costs: { fee: 1 }, source: "binance" });
  });
  it.each(["metric", "interval", "capital", "costs", "source"])("only optional %s present -> just that key added", async (k) => {
    const v: Record<string, unknown> = { metric: "sharpe", interval: "1D", capital: 1, costs: {}, source: "auto" };
    const { body } = await sent({ ...breq, [k]: v[k] });
    expect(Object.keys(body).sort()).toEqual([...REQUIRED_KEYS, k].sort());
  });
  it("optionals explicitly undefined are omitted (not sent as null)", async () => {
    const { init } = await sent({ ...breq, metric: undefined, interval: undefined, capital: undefined, costs: undefined, source: undefined });
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(REQUIRED_KEYS);
    expect(init.body as string).not.toContain("null");
  });
  it.each(["sharpe", "total_return", "calmar"])("metric %s accepted", async (m) => {
    const { body } = await sent({ ...breq, metric: m });
    expect(body.metric).toBe(m);
  });
});

describe("walkForward binding validation (rejected without fetch)", () => {
  const rejects = async (args: unknown, re: RegExp = /./) => {
    const bt = fakeBt({ ok: true });
    const { b, auditFile } = setup({ bt });
    await expect(b.backtest.walkForward(args)).rejects.toThrow(re);
    expect(bt.walkForward).not.toHaveBeenCalled();
    return auditFile;
  };
  it.each(["timeout", "apikey", "train_days", "test_days", "signal_parameters", "params", "foo"])("unknown field %s rejected", async (k) => {
    await rejects({ ...breq, [k]: 1 }, /unknown field/);
  });
  it.each([undefined, null, "x", 5, []])("non-object args %j rejected", async (a) => {
    await rejects(a);
  });
  it.each(["code", "symbols", "start", "end", "trainDays", "testDays", "candidates"])("missing %s rejected", async (k) => {
    const a: any = { ...breq };
    delete a[k];
    await rejects(a, /missing field/);
  });
  it.each([["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity], ["string", "20"], ["bool", true]])("trainDays %s rejected", async (_n, v) => {
    await rejects({ ...breq, trainDays: v });
  });
  it.each([["NaN", NaN], ["string", "5"]])("testDays %s rejected", async (_n, v) => {
    await rejects({ ...breq, testDays: v });
  });
  it.each([["string", "a,b"], ["object", { a: 1 }], ["number", 3]])("candidates not array (%s) rejected", async (_n, v) => {
    await rejects({ ...breq, candidates: v }, /candidates/);
  });
  it.each([["number", [1]], ["string", ["x"]], ["null", [null]], ["array", [[1]]], ["mixed", [{ a: 1 }, 2]]])("candidates with non-object entry (%s) rejected", async (_n, v) => {
    await rejects({ ...breq, candidates: v }, /candidates/);
  });
  it.each([["string", "RELIANCE.NS"], ["number entry", [1]], ["null entry", [null]]])("symbols %s rejected", async (_n, v) => {
    await rejects({ ...breq, symbols: v });
  });
  it.each(["SHARPE", "sortino", "", 1])("metric %j rejected", async (m) => {
    await rejects({ ...breq, metric: m });
  });
  it.each([["capital NaN", { capital: NaN }], ["capital string", { capital: "1" }], ["costs array", { costs: [1] }], ["source number", { source: 1 }], ["interval number", { interval: 1 }]])("%s rejected", async (_n, extra) => {
    await rejects({ ...breq, ...extra });
  });
  it("validation rejection is audited as error, without the code body", async () => {
    const auditFile = await rejects({ ...breq, code: "MARKER-BODY", timeout: 5 }, /unknown field/);
    const raw = readFileSync(auditFile, "utf8");
    expect(raw).not.toContain("MARKER-BODY");
    const l = lines(auditFile)[0];
    expect(l).toMatchObject({ action: "backtest.walkForward", decision: "error" });
    expect(l.args.code).toBeUndefined();
    expect(l.args.codeLength).toBe("MARKER-BODY".length);
  });
  it("non-object args rejection audited with placeholder", async () => {
    const auditFile = await rejects("MARKER-STRING-ARGS");
    expect(readFileSync(auditFile, "utf8")).not.toContain("MARKER-STRING-ARGS");
    expect(lines(auditFile)[0]).toMatchObject({ action: "backtest.walkForward", decision: "error", args: "<non-object args>" });
  });
  it("not configured -> throws 'backtest service not configured', audited", async () => {
    const { b, auditFile } = setup();
    await expect(b.backtest.walkForward(breq)).rejects.toThrow("backtest service not configured");
    expect(lines(auditFile)[0]).toMatchObject({ action: "backtest.walkForward", decision: "error" });
  });
});

// Client-side behaviour characterised: bt-service owns range validation (train_days>=20, test_days>=5, 1-10 candidates).
describe("walkForward pass-through of values bt-service validates", () => {
  const passes = async (args: Record<string, unknown>) => {
    const bt = fakeBt({ ok: true });
    await setup({ bt }).b.backtest.walkForward(args);
    expect(bt.walkForward).toHaveBeenCalledTimes(1);
    return bt.walkForward.mock.calls[0][0];
  };
  it.each([["non-integer", 20.5], ["zero", 0], ["negative", -5], ["huge", 1e9], ["below min 19", 19], ["min 20", 20]])("trainDays %s passed through", async (_n, v) => {
    expect((await passes({ ...breq, trainDays: v })).train_days).toBe(v);
  });
  it.each([["non-integer", 5.5], ["zero", 0], ["negative", -1], ["huge", Number.MAX_SAFE_INTEGER], ["below min 4", 4], ["min 5", 5]])("testDays %s passed through", async (_n, v) => {
    expect((await passes({ ...breq, testDays: v })).test_days).toBe(v);
  });
  it.each([0, 1, 10, 11, 100])("candidates length %i passed through (no client cap)", async (n) => {
    const c = Array.from({ length: n }, (_, i) => ({ fast: i }));
    expect((await passes({ ...breq, candidates: c })).candidates).toEqual(c);
  });
});

describe("walkForward client errors (same mapping as run)", () => {
  it.each([
    [401, /rejected the token \(401\)/],
    [503, /not configured \(503\)/],
    [429, /^backtest service busy, retry later$/],
    [413, /too large \(413\)/],
    [500, /service error \(500\)/],
    [502, /service error \(502\)/],
    [504, /service error \(504\)/],
    [404, /service error \(404\)/],
  ])("status %i mapped", async (s, re) => {
    const e = await errOf(mkc(async () => new Response(`x ${TOKEN}`, { status: s })).walkForward(wreq));
    expect(e).toBeInstanceOf(BacktestError);
    expect(e.message).toMatch(re);
    expect(e.message).not.toContain(TOKEN);
    expect(e.httpStatus).toBe(s);
  });
  it("422 with token straddling the 500-char cut: no partial token leaks", async () => {
    const body = "z".repeat(490) + TOKEN + "tail";
    const e = await errOf(mkc(async () => jr(body, 422)).walkForward(wreq));
    expect(e.httpStatus).toBe(422);
    expect(e.message).not.toContain(TOKEN.slice(0, 8));
    expect(e.message).toContain("[REDACTED]");
  });
  it("422 long body truncated to 500 chars after redaction", async () => {
    const e = await errOf(mkc(async () => jr(`bad ${TOKEN} ` + "y".repeat(2000), 422)).walkForward(wreq));
    const detail = e.message.replace(/^backtest request invalid \(422\): /, "");
    expect(detail.length).toBe(500);
    expect(e.message).not.toContain(TOKEN);
  });
  it.each(["<html>", "", "{not json"])("non-JSON 200 body %j mapped", async (t) => {
    const e = await errOf(mkc(async () => new Response(t, { status: 200 })).walkForward(wreq));
    expect(e.message).toMatch(/non-JSON/);
  });
  it("network error echoing body+token is redacted", async () => {
    const f = async (_u: string, i: RequestInit) => { throw new Error("boom " + i.body + " " + TOKEN); };
    const e = await errOf(mkc(f).walkForward({ ...wreq, code: `x = "${TOKEN}"` }));
    expect(e.message).toMatch(/unreachable/);
    expect(e.message).not.toContain(TOKEN);
  });
});

describe("walkForward timeout", () => {
  it("default timeout is 660000ms: pending at 659999, rejects by 660001, abort signalled", async () => {
    vi.useFakeTimers();
    try {
      let sig: AbortSignal | undefined;
      const p = errOf(mkc((_u: string, i: RequestInit) => { sig = i.signal!; return new Promise<Response>(() => {}); }).walkForward(wreq));
      let settled = false;
      p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(659999);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(sig?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await p).message).toMatch(/timeout after 660000ms/);
      expect(sig?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("run() keeps its own 180000ms default (timeouts not shared)", async () => {
    vi.useFakeTimers();
    try {
      const c = mkc(() => new Promise<Response>(() => {}));
      const pr = errOf(c.run({ code: "x", symbols: ["A"], start: "a", end: "b" }));
      const pw = errOf(c.walkForward(wreq));
      let wSettled = false;
      pw.then(() => (wSettled = true));
      await vi.advanceTimersByTimeAsync(180001);
      expect((await pr).message).toMatch(/timeout after 180000ms/);
      expect(wSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(480000);
      expect((await pw).message).toMatch(/timeout after 660000ms/);
    } finally {
      vi.useRealTimers();
    }
  });
  it("walkForwardTimeoutMs override honoured", async () => {
    const e = await errOf(mkc(() => new Promise<Response>(() => {}), { walkForwardTimeoutMs: 25 }).walkForward(wreq));
    expect(e.message).toMatch(/timeout after 25ms/);
  });
});

describe("walkForward result mapping", () => {
  const eq = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, value: i }));
  it.each([0, 1, 100])("oosEquity of %i points kept as-is", async (n) => {
    const { b } = setup({ bt: fakeBt({ ok: true, oos_equity: eq(n) }) });
    expect((await b.backtest.walkForward(breq)).oosEquity).toEqual(eq(n));
  });
  it.each([101, 5000])("oosEquity of %i points -> 100, first & last kept, ordered", async (n) => {
    const { b } = setup({ bt: fakeBt({ ok: true, oos_equity: eq(n) }) });
    const e = (await b.backtest.walkForward(breq)).oosEquity;
    expect(e.length).toBe(100);
    expect(e[0]).toEqual({ date: "d0", value: 0 });
    expect(e[99]).toEqual({ date: `d${n - 1}`, value: n - 1 });
    for (let i = 1; i < e.length; i++) expect(e[i].value).toBeGreaterThan(e[i - 1].value);
  });
  it("folds mapped snake -> camel, full fields", async () => {
    const fold = { train: ["2024-01-01", "2024-01-31"], test: ["2024-02-01", "2024-02-07"], chosen: { fast: 5 }, train_score: 1.2, test_metrics: { sharpe: 0.4 } };
    const { b } = setup({ bt: fakeBt({ ok: true, metric: "sharpe", folds: [fold], summary: { folds: 1 }, warnings: ["w"], error: null }) });
    const r = await b.backtest.walkForward(breq);
    expect(r.folds).toEqual([{ train: fold.train, test: fold.test, chosen: { fast: 5 }, trainScore: 1.2, testMetrics: { sharpe: 0.4 } }]);
    expect(r.folds[0]).not.toHaveProperty("train_score");
    expect(r.folds[0]).not.toHaveProperty("test_metrics");
    expect(r).toEqual({ ok: true, metric: "sharpe", folds: r.folds, oosEquity: [], summary: { folds: 1 }, warnings: ["w"], error: null });
  });
  it("fold with all fields missing gets defaults", async () => {
    const { b } = setup({ bt: fakeBt({ ok: true, folds: [{}] }) });
    expect((await b.backtest.walkForward(breq)).folds).toEqual([{ train: [], test: [], chosen: {}, trainScore: null, testMetrics: {} }]);
  });
  it("train_score 0 is preserved (not coerced to null); null stays null", async () => {
    const { b } = setup({ bt: fakeBt({ ok: true, folds: [{ train_score: 0 }, { train_score: null }] }) });
    expect((await b.backtest.walkForward(breq)).folds.map((f: any) => f.trainScore)).toEqual([0, null]);
  });
  it("empty response {ok:true} -> all defaults", async () => {
    const { b } = setup({ bt: fakeBt({ ok: true }) });
    expect(await b.backtest.walkForward(breq)).toEqual({ ok: true, metric: null, folds: [], oosEquity: [], summary: {}, warnings: [], error: null });
  });
  it("ok:false 'time budget exceeded' passes through and is audited ok:false", async () => {
    const { b, auditFile } = setup({ bt: fakeBt({ ok: false, error: "time budget exceeded", warnings: ["stopped at fold 3"] }) });
    const r = await b.backtest.walkForward(breq);
    expect(r).toEqual({ ok: false, metric: null, folds: [], oosEquity: [], summary: {}, warnings: ["stopped at fold 3"], error: "time budget exceeded" });
    expect(lines(auditFile)[0]).toMatchObject({ action: "backtest.walkForward", decision: "allowed", ok: false, error: "time budget exceeded" });
  });
  it("result is JSON-serialisable with null/NaN equity values", async () => {
    const { b } = setup({ bt: fakeBt({ ok: true, oos_equity: [{ date: "a", value: null }, { date: "b", value: NaN }] }) });
    const r = await b.backtest.walkForward(breq);
    expect(r.oosEquity.length).toBe(2);
    expect(() => JSON.stringify(r)).not.toThrow();
  });
});

describe("walkForward audit", () => {
  it("codeLength + sha256 correct for unicode; no code body", async () => {
    const code = "# 注文 ₹ 🚀\nclass SignalEngine: pass  # MARKER-BODY";
    const { b, auditFile } = setup({ bt: fakeBt({ ok: true }) });
    await b.backtest.walkForward({ ...breq, code });
    const raw = readFileSync(auditFile, "utf8");
    expect(raw).not.toContain("MARKER-BODY");
    const l = lines(auditFile)[0];
    expect(l).toMatchObject({ action: "backtest.walkForward", decision: "allowed", ok: true });
    expect(l.args.code).toBeUndefined();
    expect(l.args.codeLength).toBe(code.length);
    expect(l.args.codeSha256).toBe(createHash("sha256").update(code, "utf8").digest("hex"));
    expect(l.args.trainDays).toBe(20);
  });
  it("error path (422 echoing token + code) audited without token or code body", async () => {
    const c = mkc(async () => jr(`echo ${TOKEN} MARKER`, 422));
    const { b, auditFile } = setup({ bt: c });
    const e = await b.backtest.walkForward({ ...breq, code: `MARKER ${TOKEN}` }).catch((x: Error) => x);
    expect(e.message).not.toContain(TOKEN);
    const raw = readFileSync(auditFile, "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("MARKER " );
    expect(lines(auditFile)[0]).toMatchObject({ action: "backtest.walkForward", decision: "error" });
  });
});

describe("walkForward scope and isolation", () => {
  it("readonly scope: walkForward available and works, trade absent", async () => {
    const bt = fakeBt({ ok: true, metric: "sharpe" });
    const { b } = setup({ bt, scope: "readonly" });
    expect(b.trade).toBeUndefined();
    expect("trade" in b).toBe(false);
    expect(typeof b.backtest.walkForward).toBe("function");
    expect((await b.backtest.walkForward(breq)).metric).toBe("sharpe");
  });
  it.each(["paper", "live"] as const)("kill switch on (%s): works, never touches broker/risk or run()", async (mode) => {
    const bt = fakeBt({ ok: true });
    const { b, kill, engine } = setup({ mode, bt });
    writeFileSync(kill, "1");
    const spies = Object.getOwnPropertyNames(Object.getPrototypeOf(engine))
      .filter((k) => k !== "constructor" && typeof (engine as any)[k] === "function")
      .map((k) => vi.spyOn(engine as any, k));
    expect((await b.backtest.walkForward(breq)).ok).toBe(true);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(bt.run).not.toHaveBeenCalled();
  });
  it("concurrent 3 client calls are independent", async () => {
    const f = vi.fn(async (_u: string, i: RequestInit) => {
      const body = JSON.parse(i.body as string);
      await new Promise((r) => setTimeout(r, 30 - body.symbols[0].length * 5));
      return jr({ ok: true, metric: body.symbols[0] });
    });
    const c = mkc(f);
    const out = await Promise.all(["A", "BB", "CCC"].map((s) => c.walkForward({ ...wreq, symbols: [s] })));
    expect(out.map((o) => o.metric)).toEqual(["A", "BB", "CCC"]);
  });
  it("concurrent binding calls: one failing does not affect the others; each audited", async () => {
    const bt = {
      walkForward: vi.fn(async (r: any) => {
        await new Promise((x) => setTimeout(x, 10));
        if (r.symbols[0] === "B") throw new Error("boom B");
        return { ok: true, metric: r.symbols[0] };
      }),
    };
    const { b, auditFile } = setup({ bt });
    const out = await Promise.allSettled(["A", "B", "C"].map((s) => b.backtest.walkForward({ ...breq, symbols: [s] })));
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((out[0] as any).value.metric).toBe("A");
    expect((out[2] as any).value.metric).toBe("C");
    expect(lines(auditFile).map((l) => l.decision).sort()).toEqual(["allowed", "allowed", "error"]);
  });
});

describe("walkForward discoverability", () => {
  it.each(["walk", "walkforward", "out-of-sample", "WalkForward"])("searchApi(%j) returns walkForward", (q) => {
    expect(searchApi(q)).toContain("function walkForward(");
  });
  it("searchApi readonly still returns walkForward", () => {
    expect(searchApi("walk", "readonly")).toContain("function walkForward(");
  });
  it("doc mentions limits and metrics", () => {
    const s = searchApi("walkforward");
    for (const t of ["trainDays >= 20", "testDays >= 5", "1-10", "60", "10-minute", "sharpe", "total_return", "calmar"]) expect(s).toContain(t);
  });
});
