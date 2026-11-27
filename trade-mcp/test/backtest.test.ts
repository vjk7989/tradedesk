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
const mk = (f: typeof fetch, extra = {}) => new BacktestClient({ baseUrl: "http://bt:8000//", token: TOKEN, fetchImpl: f, ...extra });
const req = { code: "class SignalEngine: pass", symbols: ["RELIANCE.NS"], start: "2024-01-01", end: "2024-06-01" };

describe("BacktestClient", () => {
  it("request shape and auth", async () => {
    const f = vi.fn(async () => jr({ ok: true }));
    await mk(f as unknown as typeof fetch).run({ ...req, interval: "1D", signal_parameters: { a: 1 } });
    const [url, init] = (f.mock.calls as any)[0] as [string, RequestInit];
    expect(url).toBe("http://bt:8000/backtest");
    expect(init.method).toBe("POST");
    expect((init.headers as any).Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ ...req, interval: "1D", signal_parameters: { a: 1 } });
    expect(body).not.toHaveProperty("timeout");
  });

  it.each([
    [401, /token/], [503, /not configured/], [429, /busy, retry later/], [413, /too large/],
    [422, /invalid/], [500, /error \(500\)/],
  ])("maps HTTP %i", async (status, re) => {
    const c = mk((async () => jr({ detail: "x" }, status)) as typeof fetch);
    const e = await c.run(req).catch((x) => x);
    expect(e).toBeInstanceOf(BacktestError);
    expect(e.message).toMatch(re);
    expect(e.httpStatus).toBe(status);
  });

  it("non-JSON, timeout, redaction", async () => {
    await expect(mk((async () => jr("<html>")) as typeof fetch).run(req)).rejects.toThrow(/non-JSON/);
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
    await expect(mk(hang, { timeoutMs: 20 }).run(req)).rejects.toThrow(/timeout/);
    const leak = (async () => { throw new Error(`conn failed ${TOKEN}`); }) as unknown as typeof fetch;
    const e = await mk(leak).run(req).catch((x) => x);
    expect(e.message).not.toContain(TOKEN);
    expect(String(e.stack)).not.toContain(TOKEN);
  });
});

function setup(bt?: BacktestClient) {
  const dir = mkdtempSync(path.join(tmpdir(), "bt-"));
  const auditFile = path.join(dir, "a.jsonl");
  const b = createBindings({ client: {} as any, risk: {} as any, cfg: {} as Config, auditFile, bt }, { id: "r1" });
  return { b, auditFile };
}

describe("backtest binding", () => {
  it("not configured throws and is audited", async () => {
    const { b, auditFile } = setup();
    await expect(b.backtest.run(req)).rejects.toThrow("backtest service not configured");
    expect(JSON.parse(readFileSync(auditFile, "utf8").trim()).decision).toBe("error");
  });

  it("downsamples equity, trims trades, maps params, audits without code", async () => {
    const equity = Array.from({ length: 500 }, (_, i) => ({ date: `d${i}`, value: i }));
    const trades = Array.from({ length: 50 }, (_, i) => ({ n: i }));
    const f = vi.fn(async () => jr({ ok: true, metrics: { sharpe: 1 }, equity, trades, warnings: ["w"] }));
    const { b, auditFile } = setup(mk(f as unknown as typeof fetch));
    const code = "class SignalEngine:\n    SECRETBODY = 1";
    const r: any = await b.backtest.run({ ...req, code, params: { fast: 5 }, capital: 5000 });
    expect(r.equity).toHaveLength(100);
    expect(r.equity[0].value).toBe(0);
    expect(r.equity[99].value).toBe(499);
    expect(r.trades).toHaveLength(20);
    expect(r.tradeCount).toBe(50);
    expect(r.metrics).toEqual({ sharpe: 1 });
    expect(r.error).toBeNull();
    const sent = JSON.parse(((f.mock.calls as any)[0][1] as RequestInit).body as string);
    expect(sent.signal_parameters).toEqual({ fast: 5 });
    expect(sent.capital).toBe(5000);
    const raw = readFileSync(auditFile, "utf8");
    expect(raw).not.toContain("SECRETBODY");
    const line = JSON.parse(raw.trim());
    expect(line.args.codeLength).toBe(code.length);
    expect(line.args.codeSha256).toBe(createHash("sha256").update(code).digest("hex"));
    expect(line.args).not.toHaveProperty("code");
  });

  it("rejects unknown fields", async () => {
    const { b } = setup(mk((async () => jr({ ok: true })) as typeof fetch));
    await expect(b.backtest.run({ ...req, timeout: 5 })).rejects.toThrow(/unknown field/);
  });
});

describe("backtest docs", () => {
  it("searchApi('backtest') returns the contract", () => {
    const s = searchApi("backtest");
    expect(s).toContain("declare namespace backtest");
    expect(s).toContain("SignalEngine");
    expect(s).toContain("next bar's open");
  });
});
