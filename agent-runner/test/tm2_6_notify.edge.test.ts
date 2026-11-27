import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeJob, parseJobs, type Job } from "../src/jobs.js";
import { runScheduler } from "../src/scheduler.js";
import type { RunResult } from "../src/types.js";

// Edge tests for TM2-6 (Telegram notify), written from the diff + acceptance criteria only.

const MCP = "mcpEdgeSecretQ7w9";
const BOT = "987654:BotEdgeSecretZ3x";
const CHAT = "-100777";
const ENV: Record<string, string | undefined> = { MCP_TOKEN: MCP, TELEGRAM_BOT_TOKEN: BOT, TG_CHAT: CHAT };
const TG_URL = `https://api.telegram.org/bot${BOT}/sendMessage`;

type FetchFn = typeof fetch;
type Call = [string, RequestInit];

let dir: string;
let spies: ReturnType<typeof vi.spyOn>[];
let globalFetch: ReturnType<typeof vi.spyOn>;
let unhandled: unknown[];
const onUnhandled = (e: unknown) => unhandled.push(e);
const realTimeout = AbortSignal.timeout.bind(AbortSignal);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tm26-edge-"));
  globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("real fetch must not be used"));
  spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 5));
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

const consoleOut = () => JSON.stringify(spies.flatMap((s) => (s.mock.calls as unknown[][]).map((c) => c.map((x) => String(x)))));
const consoleCalls = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);

const mkJob = (over: Partial<Job> = {}, notify: Job["notify"] | null = { telegram: { chatIdEnv: "TG_CHAT" } }): Job => ({
  name: "eod",
  schedule: { days: ["Mon"], time: "10:00", tz: "UTC" },
  backend: "claude",
  prompt: "p",
  mcp: { name: "t", url: "https://x/mcp", tokenEnv: "MCP_TOKEN" },
  ...(notify ? { notify } : {}),
  outputDir: dir,
  ...over,
});

const clock = () => {
  const ts = [new Date("2026-01-05T10:00:00Z"), new Date("2026-01-05T10:00:01Z")];
  return () => ts.shift() ?? new Date("2026-01-05T10:00:01Z");
};
const runWith =
  (text: string, ok = true, error?: string) =>
  async (): Promise<RunResult> => ({ ok, text, error, exitCode: ok ? 0 : 1 });
const okFetch = () => vi.fn(async () => new Response("{\"ok\":true}", { status: 200 }));
const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls as unknown as Call[];
const sentBody = (f: ReturnType<typeof vi.fn>, i = 0) => calls(f)[i][1].body as string;
const sentText = (f: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(sentBody(f, i)).text as string;
/** The result part of the message: everything after the "name: status / duration / [error]" head. */
const resultPart = (text: string) => text.replace(/^[^\n]*\nduration: \d+ ms\n(error: [^\n]*\n)?/, "");
const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

async function exec(job: Job, run: () => Promise<RunResult>, f: unknown, env = ENV) {
  return executeJob(job, { run, now: clock(), env, fetch: f as FetchFn });
}

describe("TM2-6 edge: token never leaks", () => {
  it("tokens in result, error and job name are redacted in the sent body", async () => {
    const f = okFetch();
    const job = mkJob({ name: `job${MCP}` });
    await exec(job, runWith(`r ${MCP} r ${BOT} r`, false, `e ${BOT} e ${MCP}`), f);
    expect(f).toHaveBeenCalledTimes(1);
    const text = sentText(f);
    expect(text).not.toContain(MCP);
    expect(text).not.toContain(BOT);
    expect(text).toContain("[redacted]");
    expect(text).toContain("error");
    // body as a whole (chat_id etc) must not carry either token
    expect(sentBody(f)).not.toContain(MCP);
    expect(sentBody(f)).not.toContain(BOT);
    expect(consoleOut()).not.toContain(MCP);
    expect(consoleOut()).not.toContain(BOT);
  });

  it("fetch error whose message is the full URL with the bot token is redacted in logs", async () => {
    const f = vi.fn(async () => {
      throw new TypeError(`fetch failed: ${TG_URL} (mcp ${MCP})`);
    });
    const file = await exec(mkJob(), runWith("fine"), f);
    expect(file).toMatch(/\.md$/);
    expect(consoleCalls()).toBeGreaterThan(0);
    expect(consoleOut()).not.toContain(BOT);
    expect(consoleOut()).not.toContain(MCP);
    expect(consoleOut()).toContain("[redacted]");
  });

  it("error with a cause chain / stack holding the token is not dumped into logs", async () => {
    const err = new Error(`outer ${TG_URL}`, { cause: new Error(`inner ${BOT}`) });
    const f = vi.fn(async () => {
      throw err;
    });
    await exec(mkJob(), runWith("fine"), f);
    expect(consoleOut()).not.toContain(BOT);
  });

  it.each([
    ["string", () => `boom ${TG_URL}`],
    ["number", () => 42],
    ["undefined", () => undefined],
    ["null", () => null],
    ["plain object", () => ({ url: TG_URL, toString: () => `obj ${TG_URL}` })],
    ["null-prototype object", () => Object.create(null)],
    ["symbol", () => Symbol(`sym ${BOT}`)],
  ])("fetch rejecting with a non-Error value (%s): job returns, nothing leaks", async (_l, val) => {
    const f = vi.fn(() => Promise.reject(val()));
    const file = await exec(mkJob(), runWith("res"), f);
    expect(file).toMatch(/\.md$/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(consoleOut()).not.toContain(BOT);
    expect(consoleOut()).not.toContain(MCP);
  });

  it("an Error whose message getter throws does not escape", async () => {
    const evil = new Error("x");
    Object.defineProperty(evil, "message", {
      get() {
        throw new Error(`getter ${BOT}`);
      },
    });
    const f = vi.fn(() => Promise.reject(evil));
    await expect(exec(mkJob(), runWith("res"), f)).resolves.toMatch(/\.md$/);
    expect(consoleOut()).not.toContain(BOT);
  });

  it("a token that is a substring of ordinary text is still never present in text/logs", async () => {
    const env = { ...ENV, MCP_TOKEN: "ok" };
    const f = okFetch();
    await exec(mkJob(), runWith("the market looked ok, ok?"), f, env);
    const text = sentText(f);
    expect(text).not.toContain("ok");
    expect(consoleOut()).not.toContain("ok");
  });

  it("overlapping tokens: MCP token is a prefix of the bot token -> no fragment of the bot token is sent", async () => {
    // Redaction order matters: replacing the shorter token first leaves the tail of the longer one.
    const bot = "sharedPrefixA1:TailOfBotSecret9";
    const env = { ...ENV, MCP_TOKEN: "sharedPrefixA1", TELEGRAM_BOT_TOKEN: bot };
    const f = okFetch();
    await exec(mkJob(), runWith(`leak ${bot} end`), f, env);
    const text = sentText(f);
    expect(text).not.toContain(bot);
    expect(text).not.toContain("TailOfBotSecret9");
  });

  it("bot token padded with whitespace in env: the trimmed token (as used in the URL) is still redacted from logs", async () => {
    const env = { ...ENV, TELEGRAM_BOT_TOKEN: `  ${BOT}\n` };
    const f = vi.fn(async (url: string) => {
      throw new Error(`fetch failed for ${url}`);
    });
    await exec(mkJob(), runWith("res"), f, env);
    expect(calls(f)[0][0]).toBe(TG_URL);
    expect(consoleOut()).not.toContain(BOT);
  });

  it("bot token padded with whitespace in env: the token inside result text is redacted from the message", async () => {
    const env = { ...ENV, TELEGRAM_BOT_TOKEN: ` ${BOT} ` };
    const f = okFetch();
    await exec(mkJob(), runWith(`see ${BOT}`), f, env);
    expect(sentText(f)).not.toContain(BOT);
  });

  it("chatIdEnv pointing at the MCP token env never sends the MCP token to Telegram", async () => {
    // misconfiguration: chatIdEnv === mcp.tokenEnv. Either refuse at parse time, or never put the token in the body.
    let parsed: Job | undefined;
    try {
      [parsed] = parseJobs([{ ...mkJob({}, null), notify: { telegram: { chatIdEnv: "MCP_TOKEN" } } }]);
    } catch {
      return; // rejected by parseJobs: fine
    }
    const f = okFetch();
    await exec(parsed!, runWith("r"), f);
    for (const c of calls(f)) expect(String(c[1].body)).not.toContain(MCP);
  });
});

describe("TM2-6 edge: skip paths", () => {
  it.each([
    ["whitespace-only bot token", { ...ENV, TELEGRAM_BOT_TOKEN: " \t\n " }],
    ["empty bot token", { ...ENV, TELEGRAM_BOT_TOKEN: "" }],
    ["whitespace-only chat id", { ...ENV, TG_CHAT: "   " }],
    ["empty chat id", { ...ENV, TG_CHAT: "" }],
    ["undefined chat id", { ...ENV, TG_CHAT: undefined }],
    ["both blank", { MCP_TOKEN: MCP, TELEGRAM_BOT_TOKEN: " ", TG_CHAT: "\t" }],
  ])("%s -> no fetch, job unaffected, no secret in warning", async (_l, env) => {
    const f = vi.fn();
    const file = await exec(mkJob(), runWith(`x ${MCP}`), f, env);
    expect(file).toMatch(/\.md$/);
    expect(f).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(consoleOut()).not.toContain(MCP);
    expect(consoleOut()).not.toContain(BOT);
  });

  it("no notify -> no fetch and no console output from notify", async () => {
    const f = vi.fn();
    await exec(mkJob({}, null), runWith("x"), f);
    expect(f).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(consoleCalls()).toBe(0);
  });

  it("chat id is trimmed before sending", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith("x"), f, { ...ENV, TG_CHAT: `  ${CHAT}\n` });
    expect(JSON.parse(sentBody(f)).chat_id).toBe(CHAT);
  });
});

describe("TM2-6 edge: truncation", () => {
  it("exactly 3500 chars -> all kept", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith("x".repeat(3499) + "Z"), f);
    const r = resultPart(sentText(f));
    expect(r.length).toBe(3500);
    expect(r.endsWith("Z")).toBe(true);
  });

  it("3501 chars -> the 3501st is dropped", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith("x".repeat(3500) + "Q"), f);
    const r = resultPart(sentText(f));
    expect(r.length).toBe(3500);
    expect(r).not.toContain("Q");
  });

  it("empty result -> head still sent with status and duration", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith(""), f);
    const t = sentText(f);
    expect(t).toContain("eod");
    expect(t).toContain("1000 ms");
  });

  it("head (name/status/duration/error) is outside the 3500 budget and a long error does not swallow it", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith("y".repeat(5000), false, "bad"), f);
    const t = sentText(f);
    expect(t.startsWith("eod")).toBe(true);
    expect(t).toContain("bad");
    expect(t.match(/y/g)!.length).toBe(3500);
  });

  it("emoji straddling the 3500 cut does not produce a lone surrogate (invalid UTF-8 for Telegram)", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith("x".repeat(3499) + "😀" + "tail"), f);
    const r = resultPart(sentText(f));
    expect(r.length).toBeLessThanOrEqual(3500);
    expect(hasLoneSurrogate(r)).toBe(false);
  });

  it("all-emoji result stays within 3500 UTF-16 units", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith("😀".repeat(3000)), f);
    const r = resultPart(sentText(f));
    expect(r.length).toBeLessThanOrEqual(3500);
    expect(r.length).toBeGreaterThanOrEqual(3498);
  });

  it("multi-byte BMP chars count as characters, not bytes", async () => {
    const f = okFetch();
    await exec(mkJob(), runWith("é".repeat(4000)), f);
    expect(resultPart(sentText(f)).length).toBe(3500);
  });

  it.each([
    ["bot", BOT],
    ["mcp", MCP],
  ])("redaction happens before truncation: %s token straddling the cut leaks no fragment", async (_l, tok) => {
    for (let off = 1; off < tok.length; off += 3) {
      const f = okFetch();
      await exec(mkJob(), runWith("x".repeat(3500 - off) + tok + "after"), f);
      const r = resultPart(sentText(f));
      expect(r.length).toBeLessThanOrEqual(3500);
      expect(r).not.toContain(tok.slice(0, Math.min(off, 4)));
    }
  });
});

describe("TM2-6 edge: transport failures", () => {
  it("fetch never resolves but honours abort -> job returns, no unhandled rejection", async () => {
    const seen: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      seen.push(ms);
      return realTimeout(30);
    });
    const f = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
        }),
    );
    const file = await exec(mkJob(), runWith("res"), f);
    expect(file).toMatch(/\.md$/);
    expect(seen).toEqual([10_000]);
    expect(consoleCalls()).toBeGreaterThan(0);
    expect(consoleOut()).not.toContain(BOT);
  });

  it("a 200 with a non-JSON body is fine and is not logged as a failure", async () => {
    const f = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }));
    const file = await exec(mkJob(), runWith("res"), f);
    expect(file).toMatch(/\.md$/);
    expect(consoleCalls()).toBe(0);
  });

  it.each([400, 401, 403, 404, 429, 500, 502, 503])("HTTP %i -> one redacted log, job unchanged", async (status) => {
    const f = vi.fn(async () => new Response(`{"ok":false,"description":"${BOT}"}`, { status, statusText: `st ${BOT}` }));
    const base = await exec(mkJob({ name: "base" }, null), runWith("same"), vi.fn());
    const file = await exec(mkJob(), runWith("same"), f);
    expect(file).toMatch(/\.md$/);
    const a = (await readFile(base, "utf8")).replace(/base/g, "eod");
    expect(await readFile(file, "utf8")).toBe(a);
    expect(consoleCalls()).toBe(1);
    expect(consoleOut()).toContain(String(status));
    expect(consoleOut()).not.toContain(BOT);
  });

  it("res.ok false with a weird response object (no status) does not throw", async () => {
    const f = vi.fn(async () => ({ ok: false }) as unknown as Response);
    await expect(exec(mkJob(), runWith("x"), f)).resolves.toMatch(/\.md$/);
  });

  it("fetch that throws synchronously does not affect the job", async () => {
    const f = vi.fn(() => {
      throw new Error(`sync ${TG_URL}`);
    });
    await expect(exec(mkJob(), runWith("x"), f)).resolves.toMatch(/\.md$/);
    expect(consoleOut()).not.toContain(BOT);
  });

  it("a failing run (run throws) still notifies with error status", async () => {
    const f = okFetch();
    const file = await executeJob(mkJob(), {
      run: async () => {
        throw new Error(`crash ${MCP}`);
      },
      now: clock(),
      env: ENV,
      fetch: f as unknown as FetchFn,
    });
    expect(file).toMatch(/\.md$/);
    const t = sentText(f);
    expect(t).toContain("error");
    expect(t).toContain("crash");
    expect(t).not.toContain(MCP);
  });
});

describe("TM2-6 edge: notify vs the report file write", () => {
  it("EEXIST loop: notify happens once, after the -1 file is written", async () => {
    const d = join(dir, "eod");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "2026-01-05.md"), "old");
    let existedAtFetch = false;
    let file = "";
    const f = vi.fn(async () => {
      existedAtFetch = (await readdir(d)).includes("2026-01-05-1.md");
      return new Response("{}", { status: 200 });
    });
    file = await exec(mkJob(), runWith("r"), f);
    expect(file.endsWith("2026-01-05-1.md")).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(existedAtFetch).toBe(true);
    expect(await readFile(join(d, "2026-01-05.md"), "utf8")).toBe("old");
  });

  it("write failure (non-EEXIST) rejects exactly as without notify, and sends nothing", async () => {
    const blocker = join(dir, "file-not-dir");
    await writeFile(blocker, "x");
    const f = vi.fn();
    const withN = exec(mkJob({ outputDir: blocker }), runWith("r"), f);
    const without = exec(mkJob({ outputDir: blocker }, null), runWith("r"), f);
    const [a, b] = await Promise.allSettled([withN, without]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect((a as PromiseRejectedResult).reason.code).toBe((b as PromiseRejectedResult).reason.code);
    expect(f).not.toHaveBeenCalled();
  });

  it("report file content is identical with and without notify, even on fetch failure", async () => {
    const a = await exec(mkJob({ outputDir: join(dir, "a") }, null), runWith(`t ${MCP}`, false, "e"), vi.fn());
    const b = await exec(
      mkJob({ outputDir: join(dir, "b") }),
      runWith(`t ${MCP}`, false, "e"),
      vi.fn(() => Promise.reject(new Error("down"))),
    );
    expect(await readFile(b, "utf8")).toBe(await readFile(a, "utf8"));
  });
});

describe("TM2-6 edge: scheduler survives notify failures", () => {
  it("executeJob in a loop with assorted notify failures always returns a path", async () => {
    const fails: unknown[] = [
      vi.fn(() => Promise.reject(new Error(TG_URL))),
      vi.fn(() => Promise.reject("str")),
      vi.fn(async () => new Response("", { status: 500 })),
      vi.fn(() => {
        throw new Error("sync");
      }),
      okFetch(),
    ];
    const files: string[] = [];
    for (const f of fails) files.push(await exec(mkJob(), runWith("r"), f));
    expect(new Set(files).size).toBe(fails.length);
  });

  it("runScheduler keeps running jobs when every notify fails", async () => {
    let t = new Date("2026-01-05T09:59:00Z").getTime();
    let runs = 0;
    const f = vi.fn(() => Promise.reject(new Error(`net ${TG_URL}`)));
    const job = mkJob({ schedule: { days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], time: "10:00", tz: "UTC" } });
    await runScheduler([job], {
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
      run: async (j) => {
        runs++;
        const start = t;
        await executeJob(j, { run: runWith("r"), now: () => new Date(start), env: ENV, fetch: f as unknown as FetchFn });
        t += 60_000;
      },
      stopped: () => runs >= 3,
    });
    expect(runs).toBe(3);
    expect(f).toHaveBeenCalledTimes(3);
    expect(consoleOut()).not.toContain("job eod failed"); // the scheduler's own catch line
    expect(consoleOut()).not.toContain(BOT);
  });
});

describe("TM2-6 edge: parseJobs notify", () => {
  const base = () => {
    const { notify: _n, ...rest } = mkJob();
    return rest;
  };
  const parse = (notify: unknown) => parseJobs([{ ...base(), notify }]);

  it.each([["tg_chat"], ["_X"], ["A1"], ["chat_ID_2"]])("accepts chatIdEnv %j", (name) => {
    expect(parse({ telegram: { chatIdEnv: name } })[0].notify).toEqual({ telegram: { chatIdEnv: name } });
  });

  it("explicit undefined notify is treated as absent", () => {
    expect("notify" in parse(undefined)[0]).toBe(false);
  });

  it.each([
    ["null", null],
    ["array", [{ telegram: { chatIdEnv: "A" } }]],
    ["telegram array", { telegram: [] }],
    ["telegram null", { telegram: null }],
    ["telegram missing", {}],
    ["telegram missing with other key", { slack: { chatIdEnv: "A" } }],
    ["digits-first", { telegram: { chatIdEnv: "1CHAT" } }],
    ["dashes", { telegram: { chatIdEnv: "TG-CHAT" } }],
    ["spaces", { telegram: { chatIdEnv: " TG_CHAT " } }],
    ["dollar", { telegram: { chatIdEnv: "$TG_CHAT" } }],
    ["literal chat id", { telegram: { chatIdEnv: "-1001234" } }],
    ["extra key in telegram", { telegram: { chatIdEnv: "A", botTokenEnv: "B" } }],
    ["extra key in notify", { telegram: { chatIdEnv: "A" }, email: true }],
    ["number", 1],
    ["true", true],
    ["chatIdEnv array", { telegram: { chatIdEnv: ["A"] } }],
  ])("rejects %s", (_l, n) => {
    expect(() => parse(n)).toThrow(/invalid notify/);
  });

  it("parsed notify is a copy, not the caller's object", () => {
    const n = { telegram: { chatIdEnv: "A" } };
    const [j] = parse(n);
    n.telegram.chatIdEnv = "MUTATED";
    expect(j.notify!.telegram.chatIdEnv).toBe("A");
  });

  it("jobs.example.json still parses and its notify uses env var names only", async () => {
    const p = fileURLToPath(new URL("../jobs.example.json", import.meta.url));
    const raw = await readFile(p, "utf8");
    const jobs = parseJobs(JSON.parse(raw));
    const withN = jobs.filter((j) => j.notify);
    expect(withN.length).toBeGreaterThan(0);
    for (const j of withN) expect(j.notify!.telegram.chatIdEnv).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    expect(raw).not.toMatch(/bot\d+:/i);
  });
});
