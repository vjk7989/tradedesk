import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/jobs.js";
import { notifyTelegram, type NotifyResult } from "../src/notify.js";

// Independent edge tests for TM2-21 (abort-listener hygiene in the Telegram drain), written from the
// brief + src diff only. All tokens are fake. The 10 s timeout is never waited for: AbortSignal.timeout
// is replaced by a controllable, instrumented signal so tests can fire the "timeout" on demand.

const MCP = "mcpFakeTok_TM221_e7";
const BOT = "333444:FakeBotTok_TM221_z2";
const CHAT = "-100921";
const ENV: Record<string, string | undefined> = { MCP_TOKEN: MCP, TELEGRAM_BOT_TOKEN: BOT, TG_CHAT: CHAT };
const BODY_SECRET = "SECRET_RESPONSE_BODY_tm221";

/** Instrumented signal: tracks live abort listeners, adds/removes, and calls after settle. */
interface Tracked {
  ctl: AbortController;
  signal: AbortSignal;
  live: Set<EventListenerOrEventListenerObject>;
  adds: number;
  removes: number;
  fired: number;
}

function tracked(): Tracked {
  const ctl = new AbortController();
  const signal = ctl.signal;
  const t: Tracked = { ctl, signal, live: new Set(), adds: 0, removes: 0, fired: 0 };
  const wrappers = new Map<EventListenerOrEventListenerObject, EventListener>();
  const origAdd = signal.addEventListener.bind(signal);
  const origRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, l: EventListenerOrEventListenerObject, opts?: unknown) => {
    if (type !== "abort" || !l) return origAdd(type, l, opts as AddEventListenerOptions);
    t.adds++;
    const once = typeof opts === "object" && opts !== null && (opts as AddEventListenerOptions).once === true;
    const w: EventListener = (ev) => {
      t.fired++;
      if (once) t.live.delete(l);
      if (typeof l === "function") l.call(signal, ev);
      else l.handleEvent(ev);
    };
    wrappers.set(l, w);
    t.live.add(l);
    origAdd(type, w, opts as AddEventListenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, l: EventListenerOrEventListenerObject, opts?: unknown) => {
    if (type !== "abort" || !l) return origRemove(type, l, opts as EventListenerOptions);
    t.removes++;
    t.live.delete(l);
    const w = wrappers.get(l);
    if (w) origRemove(type, w, opts as EventListenerOptions);
  }) as typeof signal.removeEventListener;
  return t;
}

let spies: ReturnType<typeof vi.spyOn>[];
let unhandled: unknown[];
let current: Tracked;
let all: Tracked[];
let shared: Tracked | undefined;
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("real fetch must not be used"));
  spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  all = [];
  shared = undefined;
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    current = shared ?? tracked();
    if (!shared) all.push(current);
    return current.signal;
  });
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

const mkJob = (): Job => ({
  name: "eod",
  schedule: { days: ["Mon"], time: "10:00", tz: "UTC" },
  backend: "claude",
  prompt: "p",
  mcp: { name: "t", url: "https://x/mcp", tokenEnv: "MCP_TOKEN" },
  notify: { telegram: { chatIdEnv: "TG_CHAT" } },
  outputDir: "/nonexistent-tm221",
});
const RESULT: NotifyResult = { ok: true, durationMs: 5, text: "report body" };
const notify = (f: unknown) => notifyTelegram(mkJob(), RESULT, { env: ENV, fetch: f as typeof fetch });

/** A non-2xx response-like object whose text() is controlled by the test. */
const fakeRes = (status: number, text: () => unknown, cancel = vi.fn(async () => {})) =>
  ({ ok: status >= 200 && status < 300, status, text, body: { cancel } }) as unknown as Response;

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** After settle: no live listener, adds balanced, and a later abort reaches no listener of ours. */
async function expectClean(t: Tracked) {
  expect(t.live.size).toBe(0);
  const firedBefore = t.fired;
  if (!t.signal.aborted) t.ctl.abort();
  await flush();
  expect(t.fired).toBe(firedBefore);
}

describe("TM2-21 edge: abort listener removed on every settle path", () => {
  it("2xx: no listener is left (none needed)", async () => {
    const f = vi.fn(async () => new Response("ok", { status: 200 }));
    await notify(f);
    expect(f).toHaveBeenCalledTimes(1);
    await expectClean(current);
  });

  it("non-2xx, drain resolves: listener added once and removed", async () => {
    await notify(vi.fn(async () => new Response(BODY_SECRET, { status: 400 })));
    expect(current.adds).toBe(1);
    expect(current.removes).toBeGreaterThanOrEqual(1);
    await expectClean(current);
  });

  it("non-2xx, text() rejects: listener removed", async () => {
    await notify(vi.fn(async () => fakeRes(500, () => Promise.reject(new Error(BODY_SECRET)))));
    expect(current.adds).toBe(1);
    await expectClean(current);
  });

  it("non-2xx, text() throws synchronously: listener removed, notify resolves", async () => {
    await expect(
      notify(
        vi.fn(async () =>
          fakeRes(502, () => {
            throw new Error(BODY_SECRET);
          }),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(current.adds).toBe(1);
    await expectClean(current);
  });

  it("non-2xx, timeout fires mid-drain: notify settles, listener removed, body cancel is best-effort", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("locked");
    });
    let textCalled = false;
    const p = notify(
      vi.fn(async () =>
        fakeRes(
          503,
          () => {
            textCalled = true;
            return new Promise(() => {}); // never settles
          },
          cancel,
        ),
      ),
    );
    await flush();
    expect(textCalled).toBe(true);
    expect(current.live.size).toBe(1);
    current.ctl.abort();
    await expect(p).resolves.toBeUndefined();
    expect(current.fired).toBe(1);
    expect(current.live.size).toBe(0);
    await expectClean(current);
  });

  it("signal already aborted before the drain: no listener ever added", async () => {
    const text = vi.fn(() => new Promise(() => {}));
    await notify(
      vi.fn(async () => {
        current.ctl.abort();
        return fakeRes(429, text);
      }),
    );
    expect(current.adds).toBe(0);
    expect(text).not.toHaveBeenCalled();
    await expectClean(current);
  });

  it("fetch itself rejects: no listener left", async () => {
    await notify(vi.fn(async () => Promise.reject(new Error("ECONNRESET"))));
    expect(current.live.size).toBe(0);
    await expectClean(current);
  });

  it("non-2xx with a null body: listener removed", async () => {
    await notify(vi.fn(async () => new Response(null, { status: 500 })));
    expect(current.adds).toBe(1);
    await expectClean(current);
  });

  it("non-2xx with a null body and a timeout mid-drain: no throw on body?.cancel()", async () => {
    const res = { ok: false, status: 500, body: null, text: () => new Promise(() => {}) } as unknown as Response;
    const p = notify(vi.fn(async () => res));
    await flush();
    current.ctl.abort();
    await expect(p).resolves.toBeUndefined();
    await expectClean(current);
  });
});

describe("TM2-21 edge: no growth over many mixed runs", () => {
  const kinds = [
    () => new Response("ok", { status: 200 }),
    () => new Response(BODY_SECRET, { status: 400 }),
    () => fakeRes(500, () => Promise.reject(new Error("x"))),
    () =>
      fakeRes(500, () => {
        throw new Error("x");
      }),
    () => new Response(null, { status: 404 }),
    () => {
      throw new Error("net down");
    },
  ];

  it("1200 non-aborting runs on ONE shared signal leave zero live listeners", async () => {
    shared = tracked();
    for (let i = 0; i < 1200; i++) await notify(vi.fn(async () => kinds[i % kinds.length]()));
    expect(shared.adds).toBeGreaterThan(0);
    expect(shared.live.size).toBe(0);
    expect(shared.removes).toBe(shared.adds);
    await expectClean(shared);
  });

  it("1000 mixed runs incl. timeouts (fresh signal each) leave no live listener on any signal", async () => {
    for (let i = 0; i < 1000; i++) {
      if (i % 7 === 3) {
        const p = notify(vi.fn(async () => fakeRes(504, () => new Promise(() => {}))));
        await flush();
        current.ctl.abort();
        await p;
      } else {
        await notify(vi.fn(async () => kinds[i % kinds.length]()));
      }
    }
    expect(all.length).toBe(1000);
    expect(all.filter((t) => t.live.size > 0)).toEqual([]);
    const adds = all.reduce((n, t) => n + t.adds, 0);
    const removes = all.reduce((n, t) => n + t.removes, 0);
    expect(removes).toBe(adds);
  });

  it("real AbortSignal.timeout: EventTarget add/remove for 'abort' stay balanced over 500 runs", async () => {
    vi.mocked(AbortSignal.timeout).mockRestore();
    const net = new Map<EventTarget, number>();
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const rem = vi.spyOn(EventTarget.prototype, "removeEventListener");
    for (let i = 0; i < 500; i++) await notify(vi.fn(async () => kinds[i % kinds.length]()));
    add.mock.calls.forEach((c, i) => {
      const tgt = add.mock.contexts[i] as EventTarget;
      if (c[0] === "abort" && tgt instanceof AbortSignal) net.set(tgt, (net.get(tgt) ?? 0) + 1);
    });
    rem.mock.calls.forEach((c, i) => {
      const tgt = rem.mock.contexts[i] as EventTarget;
      if (c[0] === "abort" && tgt instanceof AbortSignal) net.set(tgt, (net.get(tgt) ?? 0) - 1);
    });
    expect([...net.values()].filter((v) => v !== 0)).toEqual([]);
  });
});

describe("TM2-21 edge: timers, rejections, secrecy", () => {
  it("leaves no pending fake timers after drain/timeout paths", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval"] });
    await notify(vi.fn(async () => new Response(BODY_SECRET, { status: 400 })));
    const p = notify(vi.fn(async () => fakeRes(503, () => new Promise(() => {}))));
    await flush();
    current.ctl.abort();
    await p;
    await notify(vi.fn(async () => Promise.reject(new Error("boom"))));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("late text() rejection after a timeout does not surface as an unhandled rejection", async () => {
    let rejectLate!: (e: unknown) => void;
    const p = notify(
      vi.fn(async () =>
        fakeRes(
          500,
          () =>
            new Promise((_, rej) => {
              rejectLate = rej;
            }),
          vi.fn(() => Promise.reject(new Error("cancel failed"))),
        ),
      ),
    );
    await flush();
    current.ctl.abort();
    await p;
    rejectLate(new Error(BODY_SECRET));
    await flush();
    await new Promise((r) => setTimeout(r, 5));
    expect(unhandled).toEqual([]);
    await expectClean(current);
  });

  it("never logs the response body, the bot token or the MCP token on any path", async () => {
    const bodyFetch = (status: number) => vi.fn(async () => new Response(`${BODY_SECRET} ${BOT} ${MCP}`, { status }));
    await notify(bodyFetch(200));
    await notify(bodyFetch(400));
    await notify(vi.fn(async () => fakeRes(500, () => Promise.reject(new Error(`${BODY_SECRET} ${BOT}`)))));
    await notify(
      vi.fn(async () =>
        fakeRes(500, () => {
          throw new Error(`${BODY_SECRET} ${MCP}`);
        }),
      ),
    );
    const p = notify(vi.fn(async () => fakeRes(503, () => new Promise(() => {}))));
    await flush();
    current.ctl.abort();
    await p;
    await notify(vi.fn(async () => Promise.reject(new Error(`net ${BOT} ${MCP}`))));
    const out = consoleOut();
    expect(out).toContain("HTTP 400");
    expect(out).not.toContain(BODY_SECRET);
    expect(out).not.toContain(BOT);
    expect(out).not.toContain(BOT.split(":")[1]);
    expect(out).not.toContain(MCP);
    expect(out).not.toContain("report body");
  });
});
