import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeJob, type Job } from "../src/jobs.js";

const BOT = "123456:FAKE-bot-token";
const ENV = { MCP_TOKEN: "fake-mcp-token", TELEGRAM_BOT_TOKEN: BOT, TG_CHAT: "-1001" };
let dir: string;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tm218-"));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const job = (): Job => ({
  name: "eod",
  schedule: { days: ["Mon"], time: "10:00", tz: "UTC" },
  backend: "claude",
  prompt: "p",
  mcp: { name: "t", url: "https://x/mcp", tokenEnv: "MCP_TOKEN" },
  notify: { telegram: { chatIdEnv: "TG_CHAT" } },
  outputDir: dir,
});
const run = async () => ({ ok: true, text: "hello", error: undefined, exitCode: 0 });
const logs = () => JSON.stringify([...errSpy.mock.calls, ...logSpy.mock.calls]);

describe("telegram non-2xx body drain", () => {
  for (const status of [400, 401, 429, 500, 503]) {
    it(`consumes body on ${status}, logs status only`, async () => {
      const text = vi.fn().mockResolvedValue(`echo ${BOT} secret-body`);
      const f = vi.fn().mockResolvedValue({ ok: false, status, text });
      const r = await executeJob(job(), { run, env: ENV, fetch: f });
      expect(text).toHaveBeenCalledTimes(1);
      expect(logs()).toContain(`HTTP ${status}`);
      expect(logs()).not.toContain("secret-body");
      expect(logs()).not.toContain(BOT);
      expect(await readFile(r, "utf8")).toContain("- status: ok");
    });
  }

  it("does not read the body on 2xx", async () => {
    const text = vi.fn();
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, text });
    await executeJob(job(), { run, env: ENV, fetch: f });
    expect(text).not.toHaveBeenCalled();
  });

  it("a rejecting body read is swallowed", async () => {
    const text = vi.fn().mockRejectedValue(new Error(`boom ${BOT}`));
    const f = vi.fn().mockResolvedValue({ ok: false, status: 500, text });
    const r = await executeJob(job(), { run, env: ENV, fetch: f });
    expect(await readFile(r, "utf8")).toContain("- status: ok");
    expect(logs()).not.toContain(BOT);
  });

  it("a hanging body is cut off by the 10 s timeout", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(10_000);
      return realTimeout(50);
    });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const text = vi.fn().mockReturnValue(new Promise(() => {}));
    const f = vi.fn().mockResolvedValue({ ok: false, status: 502, text, body: { cancel } });
    const r = await executeJob(job(), { run, env: ENV, fetch: f });
    expect(spy).toHaveBeenCalledWith(10_000);
    expect(text).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
    expect(await readFile(r, "utf8")).toContain("- status: ok");
  });
});
