import { describe, it, expect, vi } from "vitest";
import { OpenAlgoClient, OpenAlgoError } from "../src/openalgo/client.js";

const KEY = "sekret-key-123";
const jr = (b: unknown, status = 200) =>
  new Response(typeof b === "string" ? b : JSON.stringify(b), { status });
const mk = (f: typeof fetch, extra = {}) =>
  new OpenAlgoClient({ baseUrl: "http://h:5000//", apiKey: KEY, fetchImpl: f, ...extra });

describe("OpenAlgoClient", () => {
  it("builds URL and body", async () => {
    const f = vi.fn(async () => jr({ status: "success", data: {} }));
    const c = mk(f as unknown as typeof fetch);
    await c.quotes({ symbol: "SBIN", exchange: "NSE" });
    await c.positions();
    await c.placeOrder({ strategy: "s", symbol: "SBIN", exchange: "NSE", action: "BUY",
      pricetype: "MARKET", product: "MIS", quantity: 1 });
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("http://h:5000/api/v1/quotes");
    expect(calls[0][1].method).toBe("POST");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ symbol: "SBIN", exchange: "NSE", apikey: KEY });
    expect(calls[1][0]).toBe("http://h:5000/api/v1/positionbook");
    expect(calls[2][0]).toBe("http://h:5000/api/v1/placeorder");
    expect(JSON.parse(calls[2][1].body as string)).toMatchObject({ action: "BUY", quantity: 1, apikey: KEY });
  });

  it("maps errors", async () => {
    const c1 = mk((async () => jr({ status: "error", message: "bad" }, 400)) as typeof fetch);
    await expect(c1.funds()).rejects.toMatchObject({ endpoint: "funds", httpStatus: 400 });
    const c2 = mk((async () => jr("<html>")) as typeof fetch);
    await expect(c2.funds()).rejects.toBeInstanceOf(OpenAlgoError);
    const c3 = mk((async () => jr({ status: "error", message: "nope" })) as typeof fetch);
    await expect(c3.funds()).rejects.toThrow("nope");
  });

  it("times out", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(mk(f, { timeoutMs: 20 }).funds()).rejects.toThrow(/timeout/);
  });

  it("redacts apikey", async () => {
    const c = mk((async () => jr({ status: "error", message: `invalid key ${KEY}` }, 403)) as typeof fetch);
    const e = await c.funds().catch((x) => x as Error);
    expect(e).toBeInstanceOf(OpenAlgoError);
    expect(e.message).not.toContain(KEY);
    expect(e.stack).not.toContain(KEY);
  });
});
