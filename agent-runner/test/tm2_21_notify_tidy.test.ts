import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/jobs.js";
import { notifyTelegram, type NotifyResult } from "../src/notify.js";

// TM2-21: the abort listener added while draining must be removed once the request settles. Fake tokens only.

const ENV = { MCP_TOKEN: "mcpFakeTok_TM221", TELEGRAM_BOT_TOKEN: "111:FakeBot_TM221", TG_CHAT: "-100221" };
const job = {
  name: "eod",
  schedule: { days: ["Mon"], time: "10:00", tz: "UTC" },
  backend: "claude",
  prompt: "p",
  mcp: { name: "t", url: "https://x/mcp", tokenEnv: "MCP_TOKEN" },
  notify: { telegram: { chatIdEnv: "TG_CHAT" } },
  outputDir: "/tmp/x",
} as unknown as Job;
const RESULT: NotifyResult = { ok: true, durationMs: 1, text: "body" };

let ctl: AbortController;
let added = 0;
let removed = 0;
beforeEach(() => {
  ctl = new AbortController();
  added = 0;
  removed = 0;
  const add = ctl.signal.addEventListener.bind(ctl.signal);
  const rem = ctl.signal.removeEventListener.bind(ctl.signal);
  vi.spyOn(ctl.signal, "addEventListener").mockImplementation((...a: Parameters<typeof add>) => {
    if (a[0] === "abort") added++;
    return add(...a);
  });
  vi.spyOn(ctl.signal, "removeEventListener").mockImplementation((...a: Parameters<typeof rem>) => {
    if (a[0] === "abort") removed++;
    return rem(...a);
  });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => ctl.signal);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const res = (status: number, text: () => Promise<string>) =>
  ({ ok: status < 300, status, text, body: { cancel: async () => {} } }) as unknown as Response;
const run = (f: () => Promise<Response>) => notifyTelegram(job, RESULT, { env: ENV, fetch: f as unknown as typeof fetch });

describe("abort listener cleanup", () => {
  it("1000 notifies (ok, 4xx, timeout) leave no abort listener behind", async () => {
    for (let i = 0; i < 1000; i++) {
      ctl = new AbortController();
      added = 0;
      removed = 0;
      const add = ctl.signal.addEventListener.bind(ctl.signal);
      const rem = ctl.signal.removeEventListener.bind(ctl.signal);
      let live = 0;
      vi.spyOn(ctl.signal, "addEventListener").mockImplementation((...a: Parameters<typeof add>) => {
        if (a[0] === "abort") live++;
        return add(...a);
      });
      vi.spyOn(ctl.signal, "removeEventListener").mockImplementation((...a: Parameters<typeof rem>) => {
        if (a[0] === "abort") live--;
        return rem(...a);
      });
      (AbortSignal.timeout as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ctl.signal);
      const kind = i % 3;
      if (kind === 0) await run(async () => res(200, async () => "ok"));
      else if (kind === 1) await run(async () => res(400, async () => "bad"));
      else {
        const p = run(async () => res(500, () => new Promise<string>(() => {})));
        await new Promise((r) => setImmediate(r));
        ctl.abort();
        await p;
      }
      expect(live).toBe(0);
    }
  });

  it("non-2xx with text() finishing first removes the listener it added", async () => {
    await run(async () => res(502, async () => "x"));
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it("timeout path also leaves none, and still swallows everything", async () => {
    const p = run(async () => res(500, () => new Promise<string>(() => {})));
    await new Promise((r) => setImmediate(r));
    ctl.abort();
    await expect(p).resolves.toBeUndefined();
    expect(added).toBe(removed);
  });
});
