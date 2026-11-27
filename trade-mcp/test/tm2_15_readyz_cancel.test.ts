import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { OpenAlgoClient, OpenAlgoError } from "../src/openalgo/client.js";
import type { Config } from "../src/config.js";

const API_KEY = "oa_SECRETKEY_" + "k".repeat(20);
const TOKEN = "tok_SECRETMCP_" + "z".repeat(20);
const realFetch = globalThis.fetch;

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
});

/** fetch that never resolves but rejects when init.signal aborts; records every signal seen. */
function hangingFetch() {
  const signals: AbortSignal[] = [];
  const impl = vi.fn((_u: any, init?: RequestInit) => {
    const s = init!.signal as AbortSignal;
    signals.push(s);
    return new Promise<Response>((_, rej) => {
      s.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  return { impl, signals };
}
const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ status: "success", data: {} })));
const mk = (fetchImpl: any, timeoutMs?: number) =>
  new OpenAlgoClient({ baseUrl: "http://oa.invalid:5000", apiKey: API_KEY, fetchImpl, timeoutMs });

async function start(client: OpenAlgoClient) {
  const cfg = { mode: "paper", mcpToken: TOKEN, openalgoApiKey: API_KEY, btUrl: undefined } as unknown as Config;
  const dir = mkdtempSync(path.join(tmpdir(), "tm2-15-"));
  const srv = createHttpServer({ cfg, client, risk: {} as any, auditFile: path.join(dir, "a.jsonl") }, undefined);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

describe("TM2-15 /readyz cancels the OpenAlgo probe", () => {
  it("aborts the fetch signal at the 3s deadline and reports fail", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { impl, signals } = hangingFetch();
    const base = await start(mk(impl)); // client timeout 10s, well after the readyz deadline
    const p = realFetch(base + "/readyz");
    while (signals.length === 0) await new Promise<void>((r) => setImmediate(r)); // real I/O: wait for the probe to start
    await vi.advanceTimersByTimeAsync(2999);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signals[0].aborted).toBe(true);
    const r = await p;
    expect(r.status).toBe(503);
    expect((await r.json() as any).checks.openalgo).toBe("fail");
  });
});

describe("TM2-15 OpenAlgoClient.analyzerStatus(signal)", () => {
  it("without a signal still times out with the client's own timeout", async () => {
    const { impl } = hangingFetch();
    const c = mk(impl, 20);
    const e = await c.analyzerStatus().catch((x) => x);
    expect(e).toBeInstanceOf(OpenAlgoError);
    expect(e.message).toBe("request timeout after 20ms");
  });

  it("a pre-aborted signal rejects without calling fetch, as an abort not a timeout", async () => {
    const f = okFetch();
    const ctl = new AbortController();
    ctl.abort();
    const e = await mk(f).analyzerStatus(ctl.signal).catch((x) => x);
    expect(e).toBeInstanceOf(OpenAlgoError);
    expect(e.message).toBe("request aborted");
    expect(e.message).not.toContain("timeout");
    expect(f).not.toHaveBeenCalled();
  });

  it("aborting mid-flight aborts the fetch signal and rejects promptly as an abort", async () => {
    const { impl, signals } = hangingFetch();
    const ctl = new AbortController();
    const p = mk(impl).analyzerStatus(ctl.signal).catch((x) => x);
    await Promise.resolve();
    ctl.abort();
    const e = await p;
    expect(signals[0].aborted).toBe(true);
    expect(e).toBeInstanceOf(OpenAlgoError);
    expect(e.message).toBe("request aborted");
  });

  it("leaves no listener behind: aborting after a successful call has no effect", async () => {
    const f = okFetch();
    const ctl = new AbortController();
    const add = vi.spyOn(ctl.signal, "addEventListener");
    const remove = vi.spyOn(ctl.signal, "removeEventListener");
    const r = await mk(f).analyzerStatus(ctl.signal);
    expect(r.status).toBe("success");
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    const seen = (f.mock.calls[0] as any)[1].signal as AbortSignal;
    expect(seen.aborted).toBe(false);
    ctl.abort();
    expect(seen.aborted).toBe(false);
  });
});
