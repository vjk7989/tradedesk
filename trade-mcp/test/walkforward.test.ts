import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { BacktestClient, BacktestError } from "../src/backtest/client.js";
import { createBindings } from "../src/sdk/bindings.js";
import { searchApi } from "../src/sdk/search.js";
import type { Config } from "../src/config.js";

const TOKEN = "bt-secret-token-xyz";
const jr = (b: unknown, status = 200) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status });
const mk = (f: typeof fetch, extra = {}) =>
  new BacktestClient({ baseUrl: "http://bt:8000//", token: TOKEN, fetchImpl: f, ...extra });
const req = {
  code: "class SignalEngine: pass",
  symbols: ["RELIANCE.NS"],
  start: "2024-01-01",
  end: "2024-06-01",
  train_days: 20,
  test_days: 5,
  candidates: [{ fast: 5 }],
};
const bindReq = {
  code: "class SignalEngine: pass",
  symbols: ["RELIANCE.NS"],
  start: "2024-01-01",
  end: "2024-06-01",
  trainDays: 20,
  testDays: 5,
  candidates: [{ fast: 5 }],
};

function setup(bt?: any, scope?: "full" | "readonly") {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-"));
  const auditFile = path.join(dir, "a.jsonl");
  const b = createBindings({ client: {} as any, risk: {} as any, cfg: {} as Config, auditFile, bt, scope }, { id: "r1" });
  return { b, auditFile };
}

const auditLines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("BacktestClient.walkForward", () => {
  it("posts the exact request model with bearer auth and no timeout", async () => {
    const f = vi.fn(async () => jr({ ok: true }));
    await mk(f as unknown as typeof fetch).walkForward(req);
    const [url, init] = (f.mock.calls as any)[0] as [string, RequestInit];
    expect(url).toBe("http://bt:8000/walkforward");
    expect(init.method).toBe("POST");
    expect((init.headers as any).Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual(req);
    expect(body).not.toHaveProperty("timeout");
    expect(body).not.toHaveProperty("apikey");
  });

  it.each([
    [401, /token/], [503, /not configured/], [429, /busy, retry later/], [413, /too large/],
    [422, /invalid/], [500, /error \(500\)/],
  ])("maps HTTP %i like run()", async (status, re) => {
    const c = mk((async () => jr({ detail: "x" }, status)) as typeof fetch);
    const e = await c.walkForward(req).catch((x) => x);
    expect(e).toBeInstanceOf(BacktestError);
    expect(e.message).toMatch(re);
    expect(e.httpStatus).toBe(status);
  });

  it("redacts the token before truncating a 422 body", async () => {
    const secret = `prefix ${TOKEN} ${"x".repeat(600)}`;
    const c = mk((async () => jr({ detail: secret }, 422)) as typeof fetch);
    const e = await c.walkForward(req).catch((x) => x);
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).toContain("[REDACTED]");
    expect(e.message.length).toBeLessThanOrEqual(500 + "backtest request invalid (422): ".length);
  });

  it("non-JSON, timeout and unreachable redaction", async () => {
    await expect(mk((async () => jr("<html>")) as typeof fetch).walkForward(req)).rejects.toThrow(/non-JSON/);
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
    await expect(mk(hang, { walkForwardTimeoutMs: 20 }).walkForward(req)).rejects.toThrow(/timeout/);
    const leak = (async () => { throw new Error(`conn failed ${TOKEN}`); }) as unknown as typeof fetch;
    const e = await mk(leak).walkForward(req).catch((x) => x);
    expect(e.message).not.toContain(TOKEN);
    expect(String(e.stack)).not.toContain(TOKEN);
  });
});

describe("backtest.walkForward binding", () => {
  it("not configured throws and is audited", async () => {
    const { b, auditFile } = setup();
    await expect(b.backtest.walkForward(bindReq)).rejects.toThrow("backtest service not configured");
    expect(auditLines(auditFile)[0].decision).toBe("error");
  });

  it("maps camelCase to the bt-service fields and reshapes the result", async () => {
    const wf = vi.fn(async () => ({
      ok: true,
      metric: "sharpe",
      folds: [{ train: ["2024-01-01", "2024-01-20"], test: ["2024-01-21", "2024-01-25"], chosen: { fast: 5 }, train_score: 1.5, test_metrics: { sharpe: 0.5 } }],
      oos_equity: [{ date: "2024-01-21", value: 1 }],
      summary: { folds: 1, scored_folds: 1, mean_test_sharpe: 0.5, positive_folds: 1 },
      warnings: ["w"],
    }));
    const { b } = setup({ walkForward: wf });
    const r: any = await b.backtest.walkForward({ ...bindReq, metric: "sharpe", interval: "1D", capital: 5000, costs: { fee: 0.1 }, source: "auto" });
    expect(wf).toHaveBeenCalledWith({
      code: bindReq.code,
      symbols: bindReq.symbols,
      start: "2024-01-01",
      end: "2024-06-01",
      train_days: 20,
      test_days: 5,
      candidates: [{ fast: 5 }],
      metric: "sharpe",
      interval: "1D",
      capital: 5000,
      costs: { fee: 0.1 },
      source: "auto",
    });
    expect(r).toEqual({
      ok: true,
      metric: "sharpe",
      folds: [{ train: ["2024-01-01", "2024-01-20"], test: ["2024-01-21", "2024-01-25"], chosen: { fast: 5 }, trainScore: 1.5, testMetrics: { sharpe: 0.5 } }],
      oosEquity: [{ date: "2024-01-21", value: 1 }],
      summary: { folds: 1, scored_folds: 1, mean_test_sharpe: 0.5, positive_folds: 1 },
      warnings: ["w"],
      error: null,
    });
  });

  it("downsamples oosEquity to 100 points keeping first and last", async () => {
    const one = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, value: i }));
    for (const n of [100, 101]) {
      const wf = vi.fn(async () => ({ ok: true, oos_equity: one(n) }));
      const { b } = setup({ walkForward: wf });
      const r: any = await b.backtest.walkForward(bindReq);
      expect(r.oosEquity).toHaveLength(100);
      expect(r.oosEquity[0].value).toBe(0);
      expect(r.oosEquity[99].value).toBe(n - 1);
    }
  });

  it("rejects unknown fields and caller-supplied timeout/apikey", async () => {
    const { b } = setup({ walkForward: vi.fn(async () => ({ ok: true })) });
    for (const extra of [{ timeout: 5 }, { apikey: "k" }, { train_days: 20 }, { nope: 1 }]) {
      await expect(b.backtest.walkForward({ ...bindReq, ...extra })).rejects.toThrow(/unknown field/);
    }
  });

  it("validates metric, candidates and symbols", async () => {
    const { b } = setup({ walkForward: vi.fn(async () => ({ ok: true })) });
    await expect(b.backtest.walkForward({ ...bindReq, metric: "sortino" })).rejects.toThrow(/metric must be one of/);
    await expect(b.backtest.walkForward({ ...bindReq, candidates: [{}, 5] })).rejects.toThrow(/candidates/);
    await expect(b.backtest.walkForward({ ...bindReq, symbols: ["A", 5] })).rejects.toThrow(/symbols/);
  });

  it("audits codeLength + sha256 and never the code body, including rejections", async () => {
    const wf = vi.fn(async () => ({ ok: true }));
    const { b, auditFile } = setup({ walkForward: wf });
    const code = "class SignalEngine:\n    SECRETBODY = 1";
    await b.backtest.walkForward({ ...bindReq, code });
    await b.backtest.walkForward({ ...bindReq, code, timeout: 5 }).catch(() => {});
    const raw = readFileSync(auditFile, "utf8");
    expect(raw).not.toContain("SECRETBODY");
    const [ok, bad] = auditLines(auditFile);
    for (const line of [ok, bad]) {
      expect(line.action).toBe("backtest.walkForward");
      expect(line.args.codeLength).toBe(code.length);
      expect(line.args.codeSha256).toBe(createHash("sha256").update(code).digest("hex"));
      expect(line.args).not.toHaveProperty("code");
    }
    expect(ok.decision).toBe("allowed");
    expect(bad.decision).toBe("error");
  });

  it("never touches the risk engine or broker", async () => {
    const wf = vi.fn(async () => ({ ok: true }));
    const risk = new Proxy({}, { get: () => { throw new Error("risk touched"); } }) as any;
    const dir = mkdtempSync(path.join(tmpdir(), "wf-"));
    const b = createBindings({ client: {} as any, risk, cfg: {} as Config, auditFile: path.join(dir, "a.jsonl"), bt: { walkForward: wf } as any }, { id: "r1" });
    const r: any = await b.backtest.walkForward(bindReq);
    expect(r.ok).toBe(true);
  });
});

describe("readonly scope", () => {
  it("keeps backtest.walkForward and drops trade", async () => {
    const wf = vi.fn(async () => ({ ok: true, summary: { folds: 1 } }));
    const { b } = setup({ walkForward: wf }, "readonly");
    expect(b.trade).toBeUndefined();
    const r: any = await b.backtest.walkForward(bindReq);
    expect(r.ok).toBe(true);
    expect(wf).toHaveBeenCalled();
  });
});

describe("walkforward docs", () => {
  it("searchApi finds the contract", () => {
    for (const q of ["walk", "walkforward"]) {
      const s = searchApi(q);
      expect(s).toContain("declare namespace backtest");
      expect(s).toContain("walkForward");
      expect(s).toContain("calendar days");
      expect(s).toContain("out-of-sample");
    }
  });
});
