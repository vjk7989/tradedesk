import { describe, it, expect, vi } from "vitest";
import { OpenAlgoClient, OpenAlgoError } from "../src/openalgo/client.js";

const KEY = "sekret-key-XYZ-987";
const ok = () => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
const jr = (b: unknown, status = 200) =>
  new Response(typeof b === "string" ? b : JSON.stringify(b), { status });
type Call = [string, RequestInit];
const spy = (impl: () => Promise<Response> = async () => ok()) => vi.fn(impl);
const mk = (f: unknown, extra: Record<string, unknown> = {}) =>
  new OpenAlgoClient({ baseUrl: "http://h:5000", apiKey: KEY, fetchImpl: f as typeof fetch, ...extra } as any);
const leak = (e: unknown) => {
  const err = e as Error;
  expect(err).toBeInstanceOf(OpenAlgoError);
  expect(err.message).not.toContain(KEY);
  expect(String(err.stack ?? "")).not.toContain(KEY);
  expect(JSON.stringify(err)).not.toContain(KEY);
};
const catchErr = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e; }
  throw new Error("expected reject");
};

const se = { symbol: "SBIN", exchange: "NSE" };
const cases: [string, (c: any) => Promise<unknown>, string, Record<string, unknown>][] = [
  ["quotes", (c) => c.quotes(se), "quotes", se],
  ["depth", (c) => c.depth(se), "depth", se],
  ["history", (c) => c.history({ ...se, interval: "D", start_date: "2025-01-01", end_date: "2025-01-02" }), "history", { interval: "D" }],
  ["search", (c) => c.search({ query: "SBIN", exchange: "NSE" }), "search", { query: "SBIN" }],
  ["optionChain", (c) => c.optionChain({ underlying: "NIFTY", exchange: "NSE_INDEX", expiry_date: "30JAN25" }), "optionchain", { underlying: "NIFTY" }],
  ["funds", (c) => c.funds(), "funds", {}],
  ["positions", (c) => c.positions(), "positionbook", {}],
  ["holdings", (c) => c.holdings(), "holdings", {}],
  ["orders", (c) => c.orders(), "orderbook", {}],
  ["trades", (c) => c.trades(), "tradebook", {}],
  ["analyzerStatus", (c) => c.analyzerStatus(), "analyzer", {}],
  ["placeOrder", (c) => c.placeOrder({ strategy: "s", ...se, action: "BUY", pricetype: "MARKET", product: "MIS", quantity: 1 }), "placeorder", { action: "BUY", quantity: 1 }],
  ["modifyOrder", (c) => c.modifyOrder({ orderid: "1", strategy: "s", ...se, action: "BUY", pricetype: "LIMIT", product: "MIS", quantity: 2, price: 10 }), "modifyorder", { orderid: "1", quantity: 2 }],
  ["cancelOrder", (c) => c.cancelOrder({ orderid: "1", strategy: "s" }), "cancelorder", { orderid: "1" }],
  ["closePosition", (c) => c.closePosition({ strategy: "s" }), "closeposition", { strategy: "s" }],
];

describe("OpenAlgoClient edges: endpoints and body", () => {
  for (const [name, run, ep, keys] of cases) {
    it(`${name} POSTs /api/v1/${ep} with body keys + apikey`, async () => {
      const f = spy();
      await run(mk(f));
      const [url, init] = f.mock.calls[0] as unknown as Call;
      expect(url).toBe(`http://h:5000/api/v1/${ep}`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toMatchObject({ ...keys, apikey: KEY });
    });
  }

  it("pnl POSTs under /api/v1/pnl", async () => {
    const f = spy();
    await mk(f).pnl();
    const [url, init] = f.mock.calls[0] as unknown as Call;
    expect(url).toMatch(/^http:\/\/h:5000\/api\/v1\/pnl(\/|$)/);
    expect(JSON.parse(init.body as string).apikey).toBe(KEY);
  });

  it("closePosition with no args still sends apikey", async () => {
    const f = spy();
    await mk(f).closePosition();
    expect(JSON.parse((f.mock.calls[0] as unknown as Call)[1].body as string)).toEqual({ apikey: KEY });
  });

  it("caller-supplied apikey cannot override", async () => {
    const f = spy();
    const c = mk(f) as any;
    await c.quotes({ ...se, apikey: "evil" });
    await c.placeOrder({ strategy: "s", ...se, action: "BUY", pricetype: "MARKET", product: "MIS", quantity: 1, apikey: "evil" });
    for (const [, init] of f.mock.calls as unknown as Call[]) {
      expect(JSON.parse(init.body as string).apikey).toBe(KEY);
      expect(init.body as string).not.toContain("evil");
    }
  });
});

describe("OpenAlgoClient edges: surface", () => {
  it("no toggle / apikey-management methods on instance or prototype", () => {
    const c = mk(spy()) as any;
    const names = new Set<string>([...Object.getOwnPropertyNames(OpenAlgoClient.prototype), ...Object.keys(c)]);
    for (const n of names) {
      if (typeof c[n] === "function") expect(n).not.toMatch(/toggle|apikey/i);
    }
    expect(c.analyzerToggle).toBeUndefined();
    expect(c.toggleAnalyzer).toBeUndefined();
    expect(typeof c.analyzerStatus).toBe("function");
  });
});

describe("OpenAlgoClient edges: baseUrl", () => {
  for (const [base, want] of [
    ["http://h", "http://h/api/v1/funds"],
    ["http://h/", "http://h/api/v1/funds"],
    ["http://h////", "http://h/api/v1/funds"],
    ["http://h/openalgo", "http://h/openalgo/api/v1/funds"],
    ["http://h/openalgo/", "http://h/openalgo/api/v1/funds"],
    ["http://h/openalgo///", "http://h/openalgo/api/v1/funds"],
  ]) {
    it(`${base} -> ${want}`, async () => {
      const f = spy();
      await mk(f, { baseUrl: base }).funds();
      expect((f.mock.calls[0] as unknown as Call)[0]).toBe(want);
    });
  }
});

describe("OpenAlgoClient edges: errors", () => {
  it("500 with JSON error -> httpStatus 500, endpoint", async () => {
    const e = (await catchErr(mk(async () => jr({ status: "error", message: "boom" }, 500)).funds())) as OpenAlgoError;
    leak(e);
    expect(e.endpoint).toBe("funds");
    expect(e.httpStatus).toBe(500);
    expect(e.message).toContain("boom");
  });
  it("200 with status error", async () => {
    const e = (await catchErr(mk(async () => jr({ status: "error", message: "nope" })).orders())) as OpenAlgoError;
    leak(e);
    expect(e.endpoint).toBe("orderbook");
    expect(e.message).toContain("nope");
  });
  it("200 with missing status is not success", async () => {
    leak(await catchErr(mk(async () => jr({ data: 1 })).funds()));
  });
  it("200 with JSON null / array", async () => {
    leak(await catchErr(mk(async () => jr("null")).funds()));
    leak(await catchErr(mk(async () => jr("[]")).funds()));
  });
  it("200 non-JSON", async () => {
    const e = (await catchErr(mk(async () => jr("<html>oops</html>")).funds())) as OpenAlgoError;
    leak(e);
    expect(e.endpoint).toBe("funds");
  });
  it("empty body", async () => {
    leak(await catchErr(mk(async () => new Response("", { status: 200 })).funds()));
  });
  it("502 non-JSON keeps httpStatus", async () => {
    const e = (await catchErr(mk(async () => jr("Bad Gateway", 502)).funds())) as OpenAlgoError;
    leak(e);
    expect(e.httpStatus).toBe(502);
  });
  it("server echoing apikey in error message (200 and 4xx) is redacted", async () => {
    leak(await catchErr(mk(async () => jr({ status: "error", message: `invalid key ${KEY}` })).funds()));
    leak(await catchErr(mk(async () => jr({ status: "error", message: `bad ${KEY}` }, 403)).funds()));
  });
  it("network reject containing apikey is redacted", async () => {
    const f = async (u: string, init: RequestInit) => {
      throw new TypeError(`fetch failed ${u} body=${init.body} key=${KEY}`);
    };
    const e = (await catchErr(mk(f).funds())) as OpenAlgoError;
    leak(e);
    expect(e.endpoint).toBe("funds");
  });
  it("network reject with non-Error value", async () => {
    leak(await catchErr(mk(async () => { throw `str ${KEY}`; }).funds()));
  });
  it("timeout via never-resolving fetch (ignores signal)", async () => {
    const f = () => new Promise<Response>(() => {});
    const p = mk(f, { timeoutMs: 15 }).funds();
    const e = await Promise.race([catchErr(p), new Promise((r) => setTimeout(() => r("HUNG"), 1000))]);
    expect(e).not.toBe("HUNG");
    leak(e);
    expect((e as Error).message).toMatch(/timeout/);
  });
  it("timeout via abort-respecting fetch", async () => {
    const f = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error(`aborted ${KEY}`))));
    const e = await catchErr(mk(f, { timeoutMs: 10 }).funds());
    leak(e);
    expect((e as Error).message).toMatch(/timeout/);
  });
  it("default timeoutMs is 10000", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const f = (_u: string, init: RequestInit) => {
        init.signal!.addEventListener("abort", () => { aborted = true; });
        return new Promise<Response>(() => {});
      };
      void mk(f).funds().catch(() => {});
      await vi.advanceTimersByTimeAsync(9999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenAlgoClient edges: concurrency", () => {
  it("concurrent calls are independent", async () => {
    const f = vi.fn(async (u: string) => {
      await new Promise((r) => setTimeout(r, u.endsWith("funds") ? 20 : 1));
      if (u.endsWith("orderbook")) return jr({ status: "error", message: "x" });
      return jr({ status: "success", data: u.split("/").pop() });
    });
    const c = mk(f);
    const [a, b, d] = await Promise.allSettled([c.funds(), c.orders(), c.holdings()]);
    expect(a).toMatchObject({ status: "fulfilled", value: { data: "funds" } });
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.endpoint).toBe("orderbook");
    expect(d).toMatchObject({ status: "fulfilled", value: { data: "holdings" } });
  });
  it("one timing out does not abort another", async () => {
    const f = (u: string) => (u.endsWith("funds") ? new Promise<Response>(() => {}) : Promise.resolve(ok()));
    const c = mk(f, { timeoutMs: 20 });
    const [a, b] = await Promise.allSettled([c.funds(), c.holdings()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
  });
});
