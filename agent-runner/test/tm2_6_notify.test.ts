import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeJob, parseJobs, type Job } from "../src/jobs.js";

const MCP = "mcp-secret-123";
const BOT = "123456:BOT-secret-abc";
const ENV = { MCP_TOKEN: MCP, TELEGRAM_BOT_TOKEN: BOT, TG_CHAT: "-1001" };
const URL_ = `https://api.telegram.org/bot${BOT}/sendMessage`;

let dir: string;
let realFetch: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tm26-"));
  realFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("real fetch called"));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const mkJob = (notify = true): Job => ({
  name: "eod",
  schedule: { days: ["Mon"], time: "10:00", tz: "UTC" },
  backend: "claude",
  prompt: "p",
  mcp: { name: "t", url: "https://x/mcp", tokenEnv: "MCP_TOKEN" },
  ...(notify ? { notify: { telegram: { chatIdEnv: "TG_CHAT" } } } : {}),
  outputDir: dir,
});

const clock = () => {
  const ts = [new Date("2026-01-05T10:00:00Z"), new Date("2026-01-05T10:00:02Z")];
  return () => ts.shift() ?? new Date("2026-01-05T10:00:02Z");
};
const okRes = { ok: true, status: 200 } as Response;
const run = (text: string, ok = true, error?: string) => async () => ({ ok, text, error, exitCode: 0 });
const logs = () => JSON.stringify([...errSpy.mock.calls, ...logSpy.mock.calls]);

describe("telegram notify", () => {
  it("posts exact url, method, body and text", async () => {
    const f = vi.fn().mockResolvedValue(okRes);
    await executeJob(mkJob(), { run: run("hello"), now: clock(), env: ENV, fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("-1001");
    expect(body.text).toContain("eod");
    expect(body.text).toContain("ok");
    expect(body.text).toContain("2000 ms");
    expect(body.text).toContain("hello");
    expect(init.body).not.toContain(BOT);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("includes error status and line", async () => {
    const f = vi.fn().mockResolvedValue(okRes);
    await executeJob(mkJob(), { run: run("", false, "boom"), now: clock(), env: ENV, fetch: f });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.text).toContain("error");
    expect(body.text).toContain("boom");
  });

  it("truncates result to 3500 chars", async () => {
    const f = vi.fn().mockResolvedValue(okRes);
    await executeJob(mkJob(), { run: run("x".repeat(9000)), now: clock(), env: ENV, fetch: f });
    const { text } = JSON.parse(f.mock.calls[0][1].body);
    expect(text.match(/x/g)!.length).toBe(3500);
  });

  it("never leaks tokens in text or logs", async () => {
    const f = vi
      .fn()
      .mockRejectedValue(new Error(`failed ${URL_} with ${MCP}`));
    const f2 = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    const leaky = `a ${MCP} b ${BOT} c`;
    await executeJob(mkJob(), { run: run(leaky, false, `err ${MCP}`), now: clock(), env: ENV, fetch: f });
    await executeJob(mkJob(), { run: run(leaky), now: clock(), env: ENV, fetch: f2 });
    const ok = vi.fn().mockResolvedValue(okRes);
    await executeJob(mkJob(), { run: run(leaky, false, `err ${MCP}`), now: clock(), env: ENV, fetch: ok });
    const sent = ok.mock.calls[0][1].body as string;
    expect(sent).not.toContain(MCP);
    expect(sent).not.toContain(BOT);
    expect(sent).toContain("[redacted]");
    for (const t of [MCP, BOT]) expect(logs()).not.toContain(t);
    expect(errSpy).toHaveBeenCalled();
  });

  for (const [label, fetchImpl] of [
    ["throws", () => vi.fn().mockRejectedValue(new Error(`net ${URL_}`))],
    ["4xx", () => vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response)],
    ["5xx", () => vi.fn().mockResolvedValue({ ok: false, status: 502 } as Response)],
    [
      "timeout",
      () =>
        vi.fn(
          (_u: string, init: RequestInit) =>
            new Promise((_res, rej) => {
              if (init.signal!.aborted) return rej(init.signal!.reason);
              init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
            }),
        ),
    ],
  ] as const) {
    it(`does not affect job on ${label}`, async () => {
      const baseline = await executeJob(mkJob(false), { run: run("same"), now: clock(), env: ENV, fetch: vi.fn() });
      const baseText = await readFile(baseline, "utf8");
      if (label === "timeout") {
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
          expect(ms).toBe(10_000);
          return AbortSignal.abort(new DOMException(`timed out ${URL_}`, "TimeoutError"));
        });
      }
      const f = fetchImpl();
      const file = await executeJob(mkJob(), { run: run("same"), now: clock(), env: ENV, fetch: f as any });
      expect(file).toMatch(/\.md$/);
      expect(f).toHaveBeenCalledTimes(1);
      const txt = await readFile(file, "utf8");
      expect(txt).toBe(baseText);
      expect(errSpy).toHaveBeenCalled();
      expect(logs()).not.toContain(BOT);
    });
  }

  it("no notify -> fetch not called", async () => {
    const f = vi.fn();
    await executeJob(mkJob(false), { run: run("x"), now: clock(), env: ENV, fetch: f });
    expect(f).not.toHaveBeenCalled();
    expect(realFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["bot token", { MCP_TOKEN: MCP, TG_CHAT: "-1" }],
    ["chat id", { MCP_TOKEN: MCP, TELEGRAM_BOT_TOKEN: BOT }],
    ["blank token", { MCP_TOKEN: MCP, TELEGRAM_BOT_TOKEN: "  ", TG_CHAT: "-1" }],
  ])("missing %s -> no fetch, safe warning", async (_l, env) => {
    const f = vi.fn();
    const file = await executeJob(mkJob(), { run: run("x"), now: clock(), env, fetch: f });
    expect(file).toMatch(/\.md$/);
    expect(f).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(logs()).not.toContain(MCP);
    expect(logs()).not.toContain(BOT);
  });
});

describe("parseJobs notify", () => {
  const base = () => ({ ...mkJob(false) });
  const parse = (notify: unknown) => parseJobs([{ ...base(), notify }]);
  it("accepts valid notify", () => {
    expect(parse({ telegram: { chatIdEnv: "TG_CHAT" } })[0].notify).toEqual({ telegram: { chatIdEnv: "TG_CHAT" } });
  });
  it("omits notify key when absent", () => {
    expect("notify" in parseJobs([base()])[0]).toBe(false);
  });
  it.each([
    ["string", "x"],
    ["array", []],
    ["null", null],
    ["no telegram", {}],
    ["telegram string", { telegram: "x" }],
    ["missing chatIdEnv", { telegram: {} }],
    ["empty chatIdEnv", { telegram: { chatIdEnv: "" } }],
    ["invalid name", { telegram: { chatIdEnv: "1BAD-NAME" } }],
    ["non-string", { telegram: { chatIdEnv: 5 } }],
    ["unknown key in notify", { telegram: { chatIdEnv: "A" }, slack: {} }],
    ["unknown key in telegram", { telegram: { chatIdEnv: "A", token: "x" } }],
  ])("rejects %s", (_l, n) => {
    expect(() => parse(n)).toThrow(/invalid notify/);
  });
  it("jobs.example.json still parses", async () => {
    const raw = JSON.parse(await readFile(join(__dirname, "..", "jobs.example.json"), "utf8"));
    const jobs = parseJobs(raw);
    expect(jobs.some((j) => j.notify)).toBe(true);
  });
});
