import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { OpenAlgoClient, OpenAlgoError } from "../src/openalgo/client.js";
import type { Config } from "../src/config.js";

const API_KEY = "oa_SECRETKEY_" + "q".repeat(20);
const TOKEN = "tok_SECRETMCP_" + "z".repeat(20);
const realFetch = globalThis.fetch;
const TIMEOUT_MS = 50;
const ABORTED = "request aborted";
const TIMED_OUT = `request timeout after ${TIMEOUT_MS}ms`;

// ---- unhandled rejection capture ----
const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => { unhandled.push(r); };
beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
  process.off("unhandledRejection", onUnhandled);
});

/** Flush microtasks and a few real macrotasks (setImmediate is not faked). */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}
async function expectNoUnhandled() {
  await settle();
  expect(unhandled).toEqual([]);
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
const mk = (fetchImpl: any, timeoutMs = TIMEOUT_MS, baseUrl = "http://oa.invalid:5000") =>
  new OpenAlgoClient({ baseUrl, apiKey: API_KEY, fetchImpl, timeoutMs });
const okResponse = () => new Response(JSON.stringify({ status: "success", data: { mode: "analyze" } }));
const order = { symbol: "SBIN", exchange: "NSE", strategy: "s", action: "BUY", pricetype: "MARKET", product: "MIS", quantity: 1 } as any;

/** fetch that never settles and ignores its signal entirely; records the signals. */
function deafFetch() {
  const signals: AbortSignal[] = [];
  const impl = vi.fn((_u: any, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return new Promise<Response>(() => {}); });
  return { impl, signals };
}
/** fetch that resolves/rejects on a fake timer at `at` ms. */
function timedFetch(at: number, outcome: "ok" | "reject", err?: Error) {
  const signals: AbortSignal[] = [];
  const impl = vi.fn((_u: any, init?: RequestInit) => {
    signals.push(init!.signal as AbortSignal);
    return new Promise<Response>((res, rej) => setTimeout(() => (outcome === "ok" ? res(okResponse()) : rej(err ?? new Error("boom"))), at));
  });
  return { impl, signals };
}

function isDocumented(r: any) {
  if (r && r.status === "success") return true;
  return r instanceof OpenAlgoError && (r.message === ABORTED || r.message === TIMED_OUT);
}

// =====================================================================
describe("TM2-15 edge: races between caller abort, internal timeout and fetch", () => {
  type Ev = "abort" | "timeout" | "fetch";
  // Order of registration of same-deadline timers decides firing order. The client's own
  // timer is registered at call time, so "abort before timeout" means we register our abort timer first.
  const orders: Ev[][] = [
    ["abort", "timeout", "fetch"], ["abort", "fetch", "timeout"],
    ["timeout", "abort", "fetch"], ["timeout", "fetch", "abort"],
    ["fetch", "abort", "timeout"], ["fetch", "timeout", "abort"],
  ];
  for (const ord of orders) {
    it(`same tick, firing order ${ord.join(" > ")}: documented outcome, no leak, no unhandled`, async () => {
      fakeTimers();
      const ctl = new AbortController();
      const signals: AbortSignal[] = [];
      let resolveFetch!: (r: Response) => void;
      const impl = vi.fn((_u: any, init?: RequestInit) => {
        signals.push(init!.signal as AbortSignal);
        return new Promise<Response>((res) => { resolveFetch = res; });
      });
      const add = vi.spyOn(ctl.signal, "addEventListener");
      const remove = vi.spyOn(ctl.signal, "removeEventListener");
      const c = mk(impl);
      const idxTimeout = ord.indexOf("timeout");
      // Timers registered before the call fire before the client's own timer on the same deadline.
      const reg = (ev: Ev) => {
        if (ev === "abort") setTimeout(() => ctl.abort(), TIMEOUT_MS);
        if (ev === "fetch") setTimeout(() => resolveFetch(okResponse()), TIMEOUT_MS);
      };
      // resolveFetch is read lazily inside the timer callback, so pre-registering "fetch" is fine.
      ord.slice(0, idxTimeout).forEach(reg);
      const p = c.analyzerStatus(ctl.signal).then((v) => v, (e) => e);
      ord.slice(idxTimeout + 1).forEach(reg);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      const r = await p;
      expect(isDocumented(r), String(r?.message ?? JSON.stringify(r))).toBe(true);
      if (ord[0] === "abort") expect((r as any).message).toBe(ABORTED);
      if (ord[0] === "timeout") expect((r as any).message).toBe(TIMED_OUT);
      expect(vi.getTimerCount()).toBe(0);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(signals[0]).toBeDefined();
      await expectNoUnhandled();
    });
  }

  it("fetch resolves and caller aborts in the same synchronous tick: abort wins, fetch signal aborted, no leak", async () => {
    fakeTimers();
    const ctl = new AbortController();
    let resolveFetch!: (r: Response) => void;
    const signals: AbortSignal[] = [];
    const c = mk(vi.fn((_u: any, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return new Promise<Response>((r) => { resolveFetch = r; }); }));
    const p = c.analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await Promise.resolve();
    resolveFetch(okResponse());
    ctl.abort();
    const r = await p;
    expect(isDocumented(r)).toBe(true);
    expect(r).toBeInstanceOf(OpenAlgoError);
    expect((r as OpenAlgoError).message).toBe(ABORTED);
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });

  it("caller aborts in the tick right after fetch resolved (text pending): still an abort", async () => {
    fakeTimers();
    const ctl = new AbortController();
    const c = mk(vi.fn(async () => okResponse()));
    const p = c.analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await Promise.resolve();
    await Promise.resolve();
    ctl.abort();
    const r = await p;
    expect(isDocumented(r)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });

  it("caller aborts one tick after the call fully succeeded: success kept, internal signal untouched", async () => {
    fakeTimers();
    const ctl = new AbortController();
    const signals: AbortSignal[] = [];
    const c = mk(vi.fn(async (_u: any, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return okResponse(); }));
    const r = await c.analyzerStatus(ctl.signal);
    ctl.abort();
    expect(r.status).toBe("success");
    expect(signals[0].aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });

  it("internal timeout fires, then the caller aborts later: message stays the timeout", async () => {
    fakeTimers();
    const ctl = new AbortController();
    const { impl } = deafFetch();
    const p = mk(impl).analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    ctl.abort();
    const r = await p;
    expect((r as OpenAlgoError).message).toBe(TIMED_OUT);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });

  it("fetch rejects with a network error in the same tick as the caller abort: one documented/redacted message", async () => {
    fakeTimers();
    const ctl = new AbortController();
    let rejectFetch!: (e: Error) => void;
    const c = mk(vi.fn(() => new Promise<Response>((_, rej) => { rejectFetch = rej; })));
    const p = c.analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await Promise.resolve();
    rejectFetch(new Error(`ECONNRESET apikey=${API_KEY}`));
    ctl.abort();
    const r = (await p) as OpenAlgoError;
    expect(r).toBeInstanceOf(OpenAlgoError);
    expect([ABORTED, "network error: ECONNRESET apikey=[REDACTED]"]).toContain(r.message);
    expect(r.message).not.toContain(API_KEY);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });
});

// =====================================================================
describe("TM2-15 edge: abort after the response arrived, before text() resolves", () => {
  it("text() pending forever: caller abort rejects promptly with 'request aborted' and aborts the fetch signal", async () => {
    fakeTimers();
    const ctl = new AbortController();
    const signals: AbortSignal[] = [];
    let textCalled = false;
    const resLike = { ok: true, status: 200, statusText: "OK", text: () => { textCalled = true; return new Promise<string>(() => {}); } };
    const c = mk(vi.fn(async (_u: any, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return resLike as any; }));
    const p = c.analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await settle();
    expect(textCalled).toBe(true);
    ctl.abort();
    const r = (await p) as OpenAlgoError;
    expect(r).toBeInstanceOf(OpenAlgoError);
    expect(r.message).toBe(ABORTED);
    expect(r.endpoint).toBe("analyzer");
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });

  it("text() rejects later after the abort (body stream aborted): no unhandled rejection", async () => {
    fakeTimers();
    const ctl = new AbortController();
    let rejectText!: (e: Error) => void;
    const resLike = { ok: true, status: 200, statusText: "OK", text: () => new Promise<string>((_, rej) => { rejectText = rej; }) };
    const p = mk(vi.fn(async () => resLike as any)).analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await settle();
    ctl.abort();
    const r = (await p) as OpenAlgoError;
    rejectText(new Error(`body aborted ${API_KEY}`));
    expect(r.message).toBe(ABORTED);
    await expectNoUnhandled();
  });
});

// =====================================================================
describe("TM2-15 edge: fetch ignores the signal entirely", () => {
  it("caller abort still rejects promptly (no timer advance needed)", async () => {
    fakeTimers();
    const ctl = new AbortController();
    const { impl, signals } = deafFetch();
    const p = mk(impl, 10_000).analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await Promise.resolve();
    ctl.abort();
    const r = (await p) as OpenAlgoError;
    expect(r.message).toBe(ABORTED);
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });

  it("with real timers, the abort settles well before the client's own timeout", async () => {
    const ctl = new AbortController();
    const { impl } = deafFetch();
    const t0 = Date.now();
    const p = mk(impl, 5_000).analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    setTimeout(() => ctl.abort(), 10);
    const r = (await p) as OpenAlgoError;
    expect(r.message).toBe(ABORTED);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("abort with a custom reason (string / Error containing the key) still yields the fixed redacted message", async () => {
    for (const reason of [API_KEY, new Error(`reason ${API_KEY}`), undefined]) {
      const ctl = new AbortController();
      const { impl } = deafFetch();
      const p = mk(impl).analyzerStatus(ctl.signal).then((v) => v, (e) => e);
      ctl.abort(reason);
      const r = (await p) as OpenAlgoError;
      expect(r.message).toBe(ABORTED);
      expect(r.message).not.toContain(API_KEY);
    }
    await expectNoUnhandled();
  });
});

// =====================================================================
describe("TM2-15 edge: redaction on the abort path", () => {
  it("API key in the base URL and in the fetch error: abort message never leaks it", async () => {
    const ctl = new AbortController();
    const urls: string[] = [];
    const c = mk(vi.fn((u: any, init?: RequestInit) => {
      urls.push(String(u));
      return new Promise<Response>((_, rej) => init!.signal!.addEventListener("abort", () => rej(new Error(`aborted fetching ${u} body apikey=${API_KEY}`))));
    }), TIMEOUT_MS, `http://oa.invalid:5000/${API_KEY}`);
    const p = c.analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    await Promise.resolve();
    ctl.abort();
    const r = (await p) as OpenAlgoError;
    expect(urls[0]).toContain(API_KEY); // precondition: the key really is in the URL
    expect(r.message).toBe(ABORTED);
    expect(JSON.stringify({ m: r.message, s: r.stack, e: r.endpoint })).not.toContain(API_KEY);
    await expectNoUnhandled();
  });

  it("pre-aborted signal with the key in the URL: no fetch, no leak", async () => {
    const ctl = new AbortController();
    ctl.abort(new Error(API_KEY));
    const f = vi.fn(async () => okResponse());
    const r = (await mk(f, TIMEOUT_MS, `http://oa.invalid/${API_KEY}`).analyzerStatus(ctl.signal).catch((e) => e)) as OpenAlgoError;
    expect(f).not.toHaveBeenCalled();
    expect(r.message).toBe(ABORTED);
    expect(r.message).not.toContain(API_KEY);
  });

  it("non-abort network error with a signal attached is still redacted", async () => {
    const ctl = new AbortController();
    const r = (await mk(vi.fn(async () => { throw new Error(`connect ${API_KEY}`); })).analyzerStatus(ctl.signal).catch((e) => e)) as OpenAlgoError;
    expect(r.message).toBe("network error: connect [REDACTED]");
  });
});

// =====================================================================
describe("TM2-15 edge: AbortSignal.any", () => {
  const hasAny = typeof (AbortSignal as any).any === "function";
  it.skipIf(!hasAny)("a combined signal aborts the probe when any source aborts", async () => {
    fakeTimers();
    const a = new AbortController();
    const b = new AbortController();
    const sig: AbortSignal = (AbortSignal as any).any([a.signal, b.signal]);
    const { impl, signals } = deafFetch();
    const p = mk(impl).analyzerStatus(sig).then((v) => v, (e) => e);
    await Promise.resolve();
    b.abort();
    const r = (await p) as OpenAlgoError;
    expect(r.message).toBe(ABORTED);
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expectNoUnhandled();
  });

  it.skipIf(!hasAny)("an already-aborted combined signal rejects without fetch", async () => {
    const a = new AbortController();
    a.abort();
    const sig: AbortSignal = (AbortSignal as any).any([a.signal, new AbortController().signal]);
    const f = vi.fn(async () => okResponse());
    const r = (await mk(f).analyzerStatus(sig).catch((e) => e)) as OpenAlgoError;
    expect(r.message).toBe(ABORTED);
    expect(f).not.toHaveBeenCalled();
  });

  it.skipIf(!hasAny)("combined with AbortSignal.timeout: success when the probe is fast", async () => {
    const sig: AbortSignal = (AbortSignal as any).any([new AbortController().signal, AbortSignal.timeout(5_000)]);
    const r = await mk(vi.fn(async () => okResponse())).analyzerStatus(sig);
    expect(r.status).toBe("success");
  });
});

// =====================================================================
describe("TM2-15 edge: listener cleanup on every path", () => {
  const paths: Record<string, { fetch: () => any; expectMsg: string | null; advance?: number }> = {
    success: { fetch: () => vi.fn(async () => okResponse()), expectMsg: null },
    "http error": { fetch: () => vi.fn(async () => new Response(JSON.stringify({ status: "error", message: "nope" }), { status: 500 })), expectMsg: "HTTP 500: nope" },
    "status error": { fetch: () => vi.fn(async () => new Response(JSON.stringify({ status: "error", message: "bad" }))), expectMsg: "bad" },
    "non-JSON": { fetch: () => vi.fn(async () => new Response("<html>")), expectMsg: "non-JSON response body" },
    "network error": { fetch: () => vi.fn(async () => { throw new Error("ECONNREFUSED"); }), expectMsg: "network error: ECONNREFUSED" },
    timeout: { fetch: () => deafFetch().impl, expectMsg: TIMED_OUT, advance: TIMEOUT_MS },
  };
  for (const [name, cfg] of Object.entries(paths)) {
    it(`${name}: exactly one add and one matching remove; later caller abort is a no-op`, async () => {
      fakeTimers();
      const ctl = new AbortController();
      const add = vi.spyOn(ctl.signal, "addEventListener");
      const remove = vi.spyOn(ctl.signal, "removeEventListener");
      const f = cfg.fetch();
      const p = mk(f).analyzerStatus(ctl.signal).then((v) => v, (e) => e);
      if (cfg.advance) await vi.advanceTimersByTimeAsync(cfg.advance);
      const r = await p;
      if (cfg.expectMsg === null) expect(r.status).toBe("success");
      else { expect(r).toBeInstanceOf(OpenAlgoError); expect(r.message).toBe(cfg.expectMsg); }
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0][0]).toBe("abort");
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0][0]).toBe("abort");
      expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
      expect(vi.getTimerCount()).toBe(0);
      const seen = (f.mock.calls[0] as any)[1].signal as AbortSignal;
      const before = seen.aborted;
      ctl.abort();
      expect(seen.aborted).toBe(before);
      await expectNoUnhandled();
    });
  }

  it("caller abort: one add, one matching remove", async () => {
    fakeTimers();
    const ctl = new AbortController();
    const add = vi.spyOn(ctl.signal, "addEventListener");
    const remove = vi.spyOn(ctl.signal, "removeEventListener");
    const p = mk(deafFetch().impl).analyzerStatus(ctl.signal).then((v) => v, (e) => e);
    ctl.abort();
    const r = await p;
    expect(r.message).toBe(ABORTED);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a shared signal across 50 sequential calls does not accumulate listeners", async () => {
    const ctl = new AbortController();
    const add = vi.spyOn(ctl.signal, "addEventListener");
    const remove = vi.spyOn(ctl.signal, "removeEventListener");
    const c = mk(vi.fn(async () => okResponse()));
    for (let i = 0; i < 50; i++) await c.analyzerStatus(ctl.signal);
    expect(add).toHaveBeenCalledTimes(50);
    expect(remove).toHaveBeenCalledTimes(50);
  });

  it("one shared signal aborts all concurrent in-flight calls", async () => {
    const ctl = new AbortController();
    const { impl, signals } = deafFetch();
    const c = mk(impl, 10_000);
    const ps = Array.from({ length: 5 }, () => c.analyzerStatus(ctl.signal).catch((e) => e));
    await Promise.resolve();
    ctl.abort();
    const rs = await Promise.all(ps);
    for (const r of rs) expect(r.message).toBe(ABORTED);
    expect(signals).toHaveLength(5);
    for (const s of signals) expect(s.aborted).toBe(true);
    await expectNoUnhandled();
  });
});

// =====================================================================
describe("TM2-15 edge: other methods are unaffected", () => {
  const others: Array<[string, (c: OpenAlgoClient, extra?: any) => Promise<any>]> = [
    ["placeOrder", (c, x) => (c as any).placeOrder(order, x)],
    ["modifyOrder", (c, x) => (c as any).modifyOrder({ ...order, orderid: "1" }, x)],
    ["cancelOrder", (c, x) => (c as any).cancelOrder({ orderid: "1" }, x)],
    ["funds", (c, x) => (c as any).funds(x)],
    ["quotes", (c, x) => (c as any).quotes({ symbol: "SBIN", exchange: "NSE" }, x)],
  ];
  for (const [name, call] of others) {
    it(`${name}: a signal smuggled as an extra arg is ignored; timeout message unchanged`, async () => {
      fakeTimers();
      const ctl = new AbortController();
      const add = vi.spyOn(ctl.signal, "addEventListener");
      const { impl, signals } = deafFetch();
      const p = call(mk(impl), ctl.signal).then((v) => v, (e) => e);
      await Promise.resolve();
      ctl.abort();
      await settle();
      expect(add).not.toHaveBeenCalled();
      expect(signals[0].aborted).toBe(false); // caller abort did not reach the request
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      const r = (await p) as OpenAlgoError;
      expect(r).toBeInstanceOf(OpenAlgoError);
      expect(r.message).toBe(TIMED_OUT);
      expect(signals[0].aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await expectNoUnhandled();
    });
  }

  it("placeOrder: fetch still receives an internal (non-null) signal and the same request shape", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ status: "success", orderid: "9" })));
    const r = await mk(f).placeOrder(order);
    expect(r.status).toBe("success");
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("http://oa.invalid:5000/api/v1/placeorder");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ ...order, apikey: API_KEY });
  });

  it("analyzerStatus() with no signal: timeout message unchanged, never 'request aborted'", async () => {
    fakeTimers();
    const p = mk(deafFetch().impl).analyzerStatus().then((v) => v, (e) => e);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const r = (await p) as OpenAlgoError;
    expect(r.message).toBe(TIMED_OUT);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// =====================================================================
// /readyz through the real HTTP server with a real OpenAlgoClient
async function start(client: OpenAlgoClient) {
  const cfg = { mode: "paper", mcpToken: TOKEN, openalgoApiKey: API_KEY, btUrl: undefined } as unknown as Config;
  const dir = mkdtempSync(path.join(tmpdir(), "tm2-15e-"));
  const srv = createHttpServer({ cfg, client, risk: {} as any, auditFile: path.join(dir, "a.jsonl") }, undefined);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise<void>((r) => setImmediate(r));
  expect(cond()).toBe(true);
}
const get = async (base: string) => {
  const r = await realFetch(base + "/readyz");
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
};
/**
 * Tracks the readyz deadline timer (3000 ms) and the client's own timer (clientMs). The HTTP server and undici
 * keep per-connection timers on the faked global, so vi.getTimerCount() is not usable here; instead every
 * readyz/client timer (identified by delay and by its callback calling ctl.abort()) must have been passed to
 * clearTimeout (both clear in `finally`, fired or not).
 */
function trackTimers(clientMs: number) {
  const st = vi.spyOn(globalThis, "setTimeout");
  const ct = vi.spyOn(globalThis, "clearTimeout");
  return () => {
    // undici also schedules 3000 ms parser timers; keep only ours (their callbacks abort a controller).
    const ours = st.mock.calls
      .map((c, i) => [c[1], st.mock.results[i].value, String(c[0])] as const)
      .filter(([d, , src]) => (d === 3000 || d === clientMs) && src.includes("ctl.abort()"));
    const cleared = new Set(ct.mock.calls.map((c) => c[0]));
    expect(ours.length).toBeGreaterThan(0);
    for (const [d, id] of ours) expect(cleared.has(id), `timer ${d}ms never cleared`).toBe(true);
  };
}
const FAIL_BODY = { ok: false, checks: { openalgo: "fail", bt: "not_configured", auditWritable: "ok" } };
const OK_BODY = { ok: true, checks: { openalgo: "ok", bt: "not_configured", auditWritable: "ok" } };

describe("TM2-15 edge: /readyz probe cancellation and cache", () => {
  it("deaf fetch (ignores signal): /readyz fails at 3 s, probe signal aborted, no timers left", async () => {
    fakeTimers();
    const { impl, signals } = deafFetch();
    const base = await start(mk(impl, 10_000));
    const allCleared = trackTimers(10_000);
    const p = get(base);
    await waitFor(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.status).toBe(503);
    expect(r.body).toEqual(FAIL_BODY);
    expect(signals[0].aborted).toBe(true);
    allCleared(); // readyz timer and the client's 10 s timer both cleared
    await expectNoUnhandled();
  });

  it("within the 5 s window: one probe; after it: a fresh probe; the aborted probe does not poison the next window", async () => {
    fakeTimers();
    let mode: "hang" | "ok" = "hang";
    const signals: AbortSignal[] = [];
    const impl = vi.fn((_u: any, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return mode === "hang" ? new Promise<Response>(() => {}) : Promise.resolve(okResponse());
    });
    const base = await start(mk(impl, 10_000));
    const allCleared = trackTimers(10_000);
    const p1 = get(base);
    await waitFor(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(3000);
    const r1 = await p1;
    expect(r1.body).toEqual(FAIL_BODY);
    mode = "ok";
    await vi.advanceTimersByTimeAsync(1000); // t = 4000: still cached
    const r2 = await get(base);
    expect(r2.body).toEqual(FAIL_BODY);
    expect(impl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); // t = 4999: still cached
    expect((await get(base)).body).toEqual(FAIL_BODY);
    expect(impl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t = 5000: new window
    const r3 = await get(base);
    expect(r3.status).toBe(200);
    expect(r3.body).toEqual(OK_BODY);
    expect(impl).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);
    // the next successful window's signal is not aborted after its own 3 s deadline passes either
    await vi.advanceTimersByTimeAsync(3000);
    expect(signals[1].aborted).toBe(false);
    allCleared();
    await expectNoUnhandled();
  });

  it("20 concurrent /readyz requests share one probe (hanging), all fail together at 3 s", async () => {
    fakeTimers();
    const { impl, signals } = deafFetch();
    const base = await start(mk(impl, 10_000));
    const allCleared = trackTimers(10_000);
    const ps = Array.from({ length: 20 }, () => get(base));
    await waitFor(() => signals.length >= 1);
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    const rs = await Promise.all(ps);
    expect(impl).toHaveBeenCalledTimes(1);
    for (const r of rs) { expect(r.status).toBe(503); expect(r.body).toEqual(FAIL_BODY); }
    expect(signals[0].aborted).toBe(true);
    allCleared();
    await expectNoUnhandled();
  });

  it("20 concurrent /readyz requests share one probe (fast ok)", async () => {
    fakeTimers();
    const impl = vi.fn(async () => okResponse());
    const base = await start(mk(impl, 10_000));
    const allCleared = trackTimers(10_000);
    const rs = await Promise.all(Array.from({ length: 20 }, () => get(base)));
    expect(impl).toHaveBeenCalledTimes(1);
    for (const r of rs) expect(r.body).toEqual(OK_BODY);
    allCleared();
  });

  it("probe succeeds just before the deadline (2999 ms): ok, signal never aborted", async () => {
    fakeTimers();
    const { impl, signals } = timedFetch(2999, "ok");
    const base = await start(mk(impl, 10_000));
    const allCleared = trackTimers(10_000);
    const p = get(base);
    await waitFor(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(2999);
    const r = await p;
    expect(r.body).toEqual(OK_BODY);
    await vi.advanceTimersByTimeAsync(10);
    expect(signals[0].aborted).toBe(false);
    allCleared();
  });

  it("probe resolves on the same tick as the 3 s deadline: documented result, no leak, no unhandled", async () => {
    fakeTimers();
    const { impl, signals } = timedFetch(3000, "ok");
    const base = await start(mk(impl, 10_000));
    const allCleared = trackTimers(10_000);
    const p = get(base);
    await waitFor(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect([OK_BODY, FAIL_BODY]).toContainEqual(r.body);
    allCleared();
    await expectNoUnhandled();
  });

  it("client timeout (1 s) shorter than the readyz deadline: fail at 1 s, no leftovers", async () => {
    fakeTimers();
    const { impl, signals } = deafFetch();
    const base = await start(mk(impl, 1000));
    const allCleared = trackTimers(1000);
    const p = get(base);
    await waitFor(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.body).toEqual(FAIL_BODY);
    expect(signals[0].aborted).toBe(true);
    allCleared();
    await expectNoUnhandled();
  });

  it("client timeout equal to the readyz deadline (3 s): fail, no leftovers, no unhandled", async () => {
    fakeTimers();
    const { impl, signals } = deafFetch();
    const base = await start(mk(impl, 3000));
    const allCleared = trackTimers(3000);
    const p = get(base);
    await waitFor(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.body).toEqual(FAIL_BODY);
    allCleared();
    await expectNoUnhandled();
  });

  it("body never includes error text: key-bearing network error, abort, timeout", async () => {
    const leaks = [API_KEY, "SECRET", "aborted", "abort", "timeout", "network", "ECONNREFUSED", "Error", "REDACTED", "oa.invalid"];
    // network error with the key in it
    const b1 = await start(mk(vi.fn(async () => { throw new Error(`ECONNREFUSED oa.invalid apikey=${API_KEY}`); }), 10_000, `http://oa.invalid:5000`));
    const r1 = await get(b1);
    expect(r1.body).toEqual(FAIL_BODY);
    for (const s of leaks) expect(r1.text).not.toContain(s);
    // deadline abort with a fetch that rejects carrying the key
    fakeTimers();
    const signals: AbortSignal[] = [];
    const b2 = await start(mk(vi.fn((_u: any, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>((_, rej) => init!.signal!.addEventListener("abort", () => rej(new Error(`aborted ${API_KEY}`))));
    }), 10_000));
    const allCleared = trackTimers(10_000);
    const p2 = get(b2);
    await waitFor(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(3000);
    const r2 = await p2;
    expect(r2.body).toEqual(FAIL_BODY);
    for (const s of leaks) expect(r2.text).not.toContain(s);
    await expectNoUnhandled();
  });
});
