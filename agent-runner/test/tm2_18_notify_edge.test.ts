import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeJob, type Job } from "../src/jobs.js";
import { notifyTelegram, type NotifyResult } from "../src/notify.js";

// Independent edge tests for TM2-18 (drain non-2xx Telegram bodies), written from the brief + diff only.
// All tokens are fake. The 10 s timeout is never waited for: AbortSignal.timeout is replaced by a
// controllable signal so tests can fire the "timeout" on demand.

const MCP = "mcpFakeTok_TM218_x9";
const BOT = "111222:FakeBotTok_TM218_q4";
const CHAT = "-100918";
const ENV: Record<string, string | undefined> = { MCP_TOKEN: MCP, TELEGRAM_BOT_TOKEN: BOT, TG_CHAT: CHAT };

let dir: string;
let spies: ReturnType<typeof vi.spyOn>[];
let unhandled: unknown[];
let ctl: AbortController;
let timeoutSpy: ReturnType<typeof vi.spyOn>;
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tm218-edge-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("real fetch must not be used"));
  spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  ctl = new AbortController();
  timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => ctl.signal);
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 10));
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

const consoleOut = () =>
  JSON.stringify(spies.flatMap((s) => (s.mock.calls as unknown[][]).map((c) => c.map((x) => String(x)))));
const consoleCalls = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);

const mkJob = (): Job => ({
  name: "eod",
  schedule: { days: ["Mon"], time: "10:00", tz: "UTC" },
  backend: "claude",
  prompt: "p",
  mcp: { name: "t", url: "https://x/mcp", tokenEnv: "MCP_TOKEN" },
  notify: { telegram: { chatIdEnv: "TG_CHAT" } },
  outputDir: dir,
});
const RESULT: NotifyResult = { ok: true, durationMs: 5, text: "report body" };
const deps = (f: unknown) => ({ env: ENV, fetch: f as typeof fetch });
const notify = (f: unknown) => notifyTelegram(mkJob(), RESULT, deps(f));

/** A minimal Response-like object whose text() and body are fully controlled by the test. */
const fakeRes = (status: number, text: () => unknown, body: { cancel: () => unknown } | null = { cancel: vi.fn() }) =>
  ({ ok: status >= 200 && status < 300, status, text: vi.fn(text), body }) as unknown as Response & {
    text: ReturnType<typeof vi.fn>;
  };

/** Real Response over a stream; records how many chunks were pulled and whether the stream was cancelled. */
const streamRes = (status: number, chunks: string[], delayMs = 0) => {
  const st = { pulled: 0, cancelled: false, closed: false };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (st.pulled < chunks.length) c.enqueue(enc.encode(chunks[st.pulled++]));
      else {
        st.closed = true;
        c.close();
      }
    },
    cancel() {
      st.cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), st };
};

/** Resolves when p settles, or "pending" after a few macrotasks. */
const settledSoon = async (p: Promise<unknown>) =>
  Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("pending"), 20))]);

describe("TM2-18 edge: drain on non-2xx", () => {
  it.each([400, 401, 403, 404, 409, 429, 500, 502, 503, 504])("drains the body on HTTP %i and logs only the status", async (status) => {
    const { res, st } = streamRes(status, ["{\"ok\":false,", "\"description\":\"x\"}"]);
    const f = vi.fn(async () => res);
    await notify(f);
    expect(st.closed).toBe(true);
    expect(st.pulled).toBe(2);
    expect(res.bodyUsed).toBe(true);
    expect(consoleCalls()).toBe(1);
    expect(consoleOut()).toContain(`HTTP ${status}`);
    expect(consoleOut()).not.toContain("description");
  });

  it.each([301, 302, 304, 307, 308])("treats 3xx (res.ok false) as non-2xx and drains it: HTTP %i", async (status) => {
    const r = fakeRes(status, async () => "redirect body");
    await notify(vi.fn(async () => r));
    expect(r.text).toHaveBeenCalledTimes(1);
    expect(consoleOut()).toContain(`HTTP ${status}`);
    expect(consoleOut()).not.toContain("redirect body");
  });

  it("drains a body that streams slowly, finishing before notify returns", async () => {
    const { res, st } = streamRes(500, ["a", "b", "c", "d", "e"], 3);
    const p = notify(vi.fn(async () => res));
    expect(st.closed).toBe(false);
    await p;
    expect(st.pulled).toBe(5);
    expect(st.closed).toBe(true);
    expect(st.cancelled).toBe(false);
  });

  it("survives text() throwing synchronously", async () => {
    const r = fakeRes(500, () => {
      throw new Error(`sync boom ${BOT}`);
    });
    await expect(notify(vi.fn(async () => r))).resolves.toBeUndefined();
    expect(r.text).toHaveBeenCalledTimes(1);
    expect(consoleOut()).not.toContain(BOT);
    expect(consoleOut()).not.toContain("sync boom");
  });

  it("survives text() rejecting asynchronously", async () => {
    const r = fakeRes(502, async () => {
      await new Promise((x) => setTimeout(x, 1));
      throw new Error(`async boom ${BOT}`);
    });
    await expect(notify(vi.fn(async () => r))).resolves.toBeUndefined();
    expect(consoleOut()).not.toContain(BOT);
    expect(consoleOut()).not.toContain("async boom");
  });

  it("survives text() returning a non-promise value", async () => {
    const r = fakeRes(500, () => "plain string, not a promise");
    await expect(notify(vi.fn(async () => r))).resolves.toBeUndefined();
    expect(consoleCalls()).toBe(1);
  });

  it("handles a missing res.body (null) on non-2xx", async () => {
    const r = fakeRes(500, async () => "", null);
    await expect(notify(vi.fn(async () => r))).resolves.toBeUndefined();
    expect(consoleCalls()).toBe(1);
  });

  it("handles a missing res.body when the drain hangs and the timeout fires", async () => {
    const r = fakeRes(500, () => new Promise(() => {}), null);
    const p = notify(vi.fn(async () => r));
    expect(await settledSoon(p)).toBe("pending");
    ctl.abort(new DOMException("timeout", "TimeoutError"));
    expect(await settledSoon(p)).toBe("done");
  });
});

describe("TM2-18 edge: token never leaks via the body", () => {
  const leakyBody = `{"ok":false,"description":"Unauthorized bot${BOT} mcp=${MCP}","url":"https://api.telegram.org/bot${BOT}/sendMessage"}`;

  it.each([400, 401, 403, 500])("body echoing both tokens never reaches any console method (HTTP %i)", async (status) => {
    const { res } = streamRes(status, [leakyBody]);
    await notify(vi.fn(async () => res));
    const out = consoleOut();
    expect(out).not.toContain(BOT);
    expect(out).not.toContain(BOT.split(":")[1]);
    expect(out).not.toContain(MCP);
    expect(out).not.toContain("Unauthorized");
    expect(out).not.toContain("description");
  });

  it("body echoing tokens never reaches the job output file", async () => {
    const { res } = streamRes(401, [leakyBody]);
    const file = await executeJob(mkJob(), {
      run: async () => ({ ok: true, text: "result", exitCode: 0 }),
      env: ENV,
      fetch: vi.fn(async () => res) as unknown as typeof fetch,
      now: () => new Date("2026-01-05T10:00:00Z"),
    });
    const files = await readdir(join(dir, "eod"));
    expect(files).toHaveLength(1);
    const md = await readFile(file, "utf8");
    expect(md).not.toContain(BOT);
    expect(md).not.toContain(MCP);
    expect(md).not.toContain("Unauthorized");
    expect(consoleOut()).not.toContain(BOT);
  });

  it("rejection reason of text() carrying the token is not logged", async () => {
    const r = fakeRes(500, () => Promise.reject(new Error(leakyBody)));
    await notify(vi.fn(async () => r));
    expect(consoleOut()).not.toContain(BOT);
    expect(consoleOut()).not.toContain("Unauthorized");
  });
});

describe("TM2-18 edge: timeout bounds the drain", () => {
  it("uses one 10 s timeout signal shared by fetch and drain", async () => {
    const r = fakeRes(500, async () => "");
    const f = vi.fn(async (_u: string, _i: RequestInit) => r);
    await notify(f);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(f.mock.calls[0][1].signal).toBe(ctl.signal);
  });

  it("a hanging text() is cut off by the timeout, and the body is cancelled", async () => {
    const cancel = vi.fn();
    const r = fakeRes(500, () => new Promise(() => {}), { cancel });
    const p = notify(vi.fn(async () => r));
    expect(await settledSoon(p)).toBe("pending");
    ctl.abort(new DOMException("timeout", "TimeoutError"));
    expect(await settledSoon(p)).toBe("done");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(consoleCalls()).toBe(1);
  });

  it("text() rejecting after the timeout produces no unhandled rejection", async () => {
    let rejectText!: (e: unknown) => void;
    const r = fakeRes(500, () => new Promise((_, rej) => (rejectText = rej)));
    const p = notify(vi.fn(async () => r));
    expect(await settledSoon(p)).toBe("pending");
    expect(r.text).toHaveBeenCalledTimes(1);
    ctl.abort(new DOMException("timeout", "TimeoutError"));
    await p;
    rejectText(new DOMException(`aborted ${BOT}`, "AbortError"));
    await new Promise((x) => setTimeout(x, 5));
    expect(consoleOut()).not.toContain(BOT);
    // afterEach asserts no unhandled rejection
  });

  it("body.cancel() rejecting or throwing after timeout is swallowed", async () => {
    for (const cancel of [
      () => Promise.reject(new TypeError("locked")),
      () => {
        throw new TypeError("locked sync");
      },
    ]) {
      ctl = new AbortController();
      const r = fakeRes(500, () => new Promise(() => {}), { cancel });
      const p = notify(vi.fn(async () => r));
      ctl.abort();
      await expect(p).resolves.toBeUndefined();
    }
    expect(consoleOut()).not.toContain("locked");
  });

  it("signal already aborted when fetch resolves: drain returns at once and cancels the body", async () => {
    const cancel = vi.fn(async () => {});
    const r = fakeRes(503, () => new Promise(() => {}), { cancel });
    const f = vi.fn(async () => {
      ctl.abort();
      return r;
    });
    expect(await settledSoon(notify(f))).toBe("done");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("a real hanging stream wired to the signal (like undici) is released on timeout", async () => {
    const st = { cancelled: false };
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("partial"));
          init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
        cancel() {
          st.cancelled = true;
        },
      });
      return new Response(stream, { status: 500 });
    });
    const p = notify(f);
    expect(await settledSoon(p)).toBe("pending");
    ctl.abort(new DOMException("timeout", "TimeoutError"));
    expect(await settledSoon(p)).toBe("done");
  });

  it("drain leaves no pending timers behind (fake timers)", async () => {
    vi.useFakeTimers();
    const r = fakeRes(500, async () => "x");
    await notify(vi.fn(async () => r));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drain does not leave an abort listener firing later work after it finished", async () => {
    const r = fakeRes(500, async () => "x");
    await notify(vi.fn(async () => r));
    const before = consoleCalls();
    ctl.abort();
    await new Promise((x) => setTimeout(x, 5));
    expect(consoleCalls()).toBe(before);
    expect((r.body as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel).not.toHaveBeenCalled();
  });
});

describe("TM2-18 edge: 2xx path unchanged", () => {
  it.each([200, 201, 204])("HTTP %i: no log, one fetch, body not cancelled", async (status) => {
    const cancel = vi.fn();
    const r = fakeRes(status, async () => "{\"ok\":true}", { cancel });
    const f = vi.fn(async () => r);
    await notify(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(consoleCalls()).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("2xx with a body that would hang does not block notify", async () => {
    const r = fakeRes(200, () => new Promise(() => {}));
    expect(await settledSoon(notify(vi.fn(async () => r)))).toBe("done");
  });

  it("request shape unchanged: POST JSON to the bot URL with chat_id", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}", { status: 200 }));
    await notify(f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).chat_id).toBe(CHAT);
  });
});

describe("TM2-18 edge: job status never changed by notify failure", () => {
  const scenarios: [string, () => unknown][] = [
    ["500 with drained body", () => streamRes(500, ["boom"]).res],
    ["404 whose text() throws sync", () => fakeRes(404, () => { throw new Error("x"); })],
    ["429 whose text() rejects", () => fakeRes(429, () => Promise.reject(new Error("x")))],
    ["500 with null body", () => fakeRes(500, async () => "", null)],
  ];

  for (const ok of [true, false]) {
    it.each(scenarios)(`job ok=${ok}: %s leaves the output file status intact`, async (_n, mk) => {
      const file = await executeJob(mkJob(), {
        run: async () => ({ ok, text: "result text", error: ok ? undefined : "run failed", exitCode: ok ? 0 : 1 }),
        env: ENV,
        fetch: vi.fn(async () => mk()) as unknown as typeof fetch,
        now: () => new Date("2026-01-05T10:00:00Z"),
      });
      const md = await readFile(file, "utf8");
      expect(md).toContain(`- status: ${ok ? "ok" : "error"}`);
      expect(md).toContain("result text");
    });
  }

  it("executeJob still returns once the hanging drain is cut off by the timeout", async () => {
    const r = fakeRes(500, () => new Promise(() => {}));
    const p = executeJob(mkJob(), {
      run: async () => ({ ok: true, text: "result text", exitCode: 0 }),
      env: ENV,
      fetch: vi.fn(async () => r) as unknown as typeof fetch,
      now: () => new Date("2026-01-05T10:00:00Z"),
    });
    expect(await settledSoon(p)).toBe("pending");
    ctl.abort();
    const file = (await p) as string;
    expect(await readFile(file, "utf8")).toContain("- status: ok");
  });
});
