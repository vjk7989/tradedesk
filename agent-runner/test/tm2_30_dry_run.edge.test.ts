import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---- side-effect traps (armed only while main() runs) ----
const fx = vi.hoisted(() => {
  const state = { armed: false };
  const sideFx = vi.fn();
  const trapIfArmed = <F extends (...a: any[]) => any>(n: string, orig: F) =>
    ((...a: unknown[]) => {
      if (state.armed) sideFx(n, ...a);
      return orig(...a);
    }) as unknown as F;
  return { state, sideFx, trapIfArmed };
});
const sideFx = fx.sideFx;

const runTask = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => runTask(...a),
}));
const executeJob = vi.fn();
vi.mock("../src/jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs.js")>()),
  executeJob: (...a: unknown[]) => executeJob(...a),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  const trap = (n: string) => (...a: unknown[]) => {
    fx.sideFx(n, ...a);
    throw new Error(`unexpected ${n}`);
  };
  const t = {
    spawn: trap("spawn"), exec: trap("exec"), execFile: trap("execFile"), fork: trap("fork"),
    spawnSync: trap("spawnSync"), execSync: trap("execSync"), execFileSync: trap("execFileSync"),
  };
  return { ...orig, ...t, default: { ...orig, ...t } };
});
vi.mock("node:http", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:http")>();
  const t = { request: fx.trapIfArmed("http.request", orig.request), get: fx.trapIfArmed("http.get", orig.get) };
  return { ...orig, ...t, default: { ...orig, ...t } };
});
vi.mock("node:https", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:https")>();
  const t = { request: fx.trapIfArmed("https.request", orig.request), get: fx.trapIfArmed("https.get", orig.get) };
  return { ...orig, ...t, default: { ...orig, ...t } };
});
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const names = [
    "writeFileSync", "writeFile", "appendFileSync", "appendFile", "mkdirSync", "mkdir", "mkdtempSync", "mkdtemp",
    "openSync", "createWriteStream", "rmSync", "rm", "unlinkSync", "renameSync", "copyFileSync", "writeSync",
  ] as const;
  const t: Record<string, unknown> = {};
  for (const n of names) t[n] = fx.trapIfArmed(`fs.${n}`, (orig as any)[n]);
  return { ...orig, ...t, default: { ...orig, ...t } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  const names = ["writeFile", "appendFile", "mkdir", "mkdtemp", "open", "rm", "unlink", "rename", "copyFile"] as const;
  const t: Record<string, unknown> = {};
  for (const n of names) t[n] = fx.trapIfArmed(`fsp.${n}`, (orig as any)[n]);
  return { ...orig, ...t, default: { ...orig, ...t } };
});

import { main } from "../src/main.js";
import { DEFAULT_GEMINI_MODEL } from "../src/gemini.js";

// ---- helpers ----
type J = {
  name: string; backend?: string; tz?: string; days?: string[]; time?: string; tokenEnv?: string;
  prompt?: string; url?: string; timeoutMs?: number; notify?: string;
};
const tmpDir = () => mkdtempSync(path.join(tmpdir(), "tm230e-"));
const writeRaw = (content: string) => {
  const file = path.join(tmpDir(), "jobs.json");
  writeFileSync(file, content);
  return file;
};
const writeJobs = (jobs: J[]) =>
  writeRaw(JSON.stringify(jobs.map((j) => ({
    name: j.name,
    schedule: { days: j.days ?? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], time: j.time ?? "08:45", tz: j.tz ?? "Asia/Kolkata" },
    backend: j.backend ?? "claude",
    prompt: j.prompt ?? "p",
    mcp: { name: "tradedesk", url: j.url ?? "https://mcp.example.com/mcp", tokenEnv: j.tokenEnv ?? "TM230E_TOKEN" },
    ...(j.timeoutMs !== undefined ? { timeoutMs: j.timeoutMs } : {}),
    ...(j.notify ? { notify: { telegram: { chatIdEnv: j.notify } } } : {}),
    outputDir: "./runs-tm230e",
  }))));

async function run(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(console, "info").mockImplementation((...a) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => (stdout.push(String(c)), true)) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => (stderr.push(String(c)), true)) as any);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("unexpected fetch");
  });
  const exit = vi.fn();
  const onSignal = vi.fn();
  let threw: unknown;
  fx.state.armed = true;
  try {
    await main(args, { exit, onSignal });
  } catch (e) {
    threw = e;
  } finally {
    fx.state.armed = false;
  }
  return { out: stdout.join("\n"), err: stderr.join("\n"), all: [...stdout, ...stderr].join("\n"), exit, onSignal, threw, fetchSpy };
}
type R = Awaited<ReturnType<typeof run>>;

const nothingRan = (r: R) => {
  expect(runTask).not.toHaveBeenCalled();
  expect(executeJob).not.toHaveBeenCalled();
  expect(sideFx).not.toHaveBeenCalled();
  expect(r.fetchSpy).not.toHaveBeenCalled();
  expect(r.onSignal).not.toHaveBeenCalled();
  expect(r.all).not.toContain("scheduler started");
};
const ok = (r: R) => {
  expect(r.threw).toBeUndefined();
  expect(r.exit).toHaveBeenCalledTimes(1);
  expect(r.exit).toHaveBeenCalledWith(0);
  expect(r.err).toBe("");
  nothingRan(r);
};
const fail = (r: R, re: RegExp) => {
  expect(r.threw).toBeUndefined();
  expect(r.exit).toHaveBeenCalledTimes(1);
  expect(r.exit).toHaveBeenCalledWith(1);
  expect(r.err).toMatch(re);
  expect(r.out).not.toMatch(/^prompt:/m);
  nothingRan(r);
};
const noStack = (r: R) => {
  expect(r.all).not.toMatch(/\n\s+at /);
  expect(r.all).not.toMatch(/\.ts:\d+|\.js:\d+:\d+/);
};
const promptOf = (out: string) => out.split("\nprompt:\n")[1];
const absent = (r: R, ...vals: string[]) => {
  for (const v of vals) {
    expect(r.out).not.toContain(v);
    expect(r.err).not.toContain(v);
  }
};

const ENVS = [
  "TM230E_TOKEN", "TM230E_T2", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TM230E_CHAT", "OPENAI_MODEL", "GEMINI_MODEL",
];
const clearEnv = () => { for (const n of ENVS) vi.stubEnv(n, undefined as unknown as string); };

afterEach(() => {
  fx.state.armed = false;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  runTask.mockReset();
  executeJob.mockReset();
  sideFx.mockReset();
});

// ---- secret leakage ----
describe("TM2-30 edge: --dry-run never prints secret values", () => {
  const TOK = "fake-mcp-tok-QX81ZZ";
  const ANTH = "fake-anth-key-77AB";
  const OAI = "fake-oai-key-55CD";
  const GEM = "fake-gem-key-33EF";
  const TG = "fake-tg-123456:ABCdefGHI";
  const CHAT = "fake-chat-998877";

  it.each([
    ["api", "ANTHROPIC_API_KEY", ANTH],
    ["api-openai", "OPENAI_API_KEY", OAI],
    ["api-gemini", "GEMINI_API_KEY", GEM],
  ])("%s: prompt holding the token and the backend key prints neither", async (backend, keyEnv, keyVal) => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", TOK);
    vi.stubEnv(keyEnv, keyVal);
    const prompt = `use ${TOK} then ${keyVal}; again:${keyVal}${TOK}`;
    const r = await run(["--jobs", writeJobs([{ name: "a", backend, prompt }]), "--dry-run", "a"]);
    ok(r);
    absent(r, TOK, keyVal);
    expect(promptOf(r.out)).toBe("use [redacted] then [redacted]; again:[redacted][redacted]");
  });

  it("notify job: Telegram bot token and chat id in the prompt are redacted", async () => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", TOK);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TG);
    vi.stubEnv("TM230E_CHAT", CHAT);
    const prompt = `bot ${TG} chat ${CHAT} url https://api.telegram.org/bot${TG}/sendMessage`;
    const r = await run(["--jobs", writeJobs([{ name: "n", prompt, notify: "TM230E_CHAT" }]), "--dry-run", "n"]);
    ok(r);
    absent(r, TG, CHAT, "ABCdefGHI", "998877");
  });

  // BUG (leak): TELEGRAM_BOT_TOKEN is only treated as a secret when the job has `notify`.
  it("job WITHOUT notify: Telegram bot token value in the prompt is still not printed", async () => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", TOK);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TG);
    const r = await run(["--jobs", writeJobs([{ name: "a", prompt: `leak ${TG}` }]), "--dry-run", "a"]);
    ok(r);
    absent(r, TG);
  });

  // BUG (leak): only the job's own backend key is redacted; other set API keys are printed verbatim.
  it("API key of a different backend that is set in env is not printed either", async () => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", TOK);
    vi.stubEnv("ANTHROPIC_API_KEY", ANTH);
    vi.stubEnv("OPENAI_API_KEY", OAI);
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "claude", prompt: `k1 ${ANTH} k2 ${OAI}` }]), "--dry-run", "a"]);
    ok(r);
    absent(r, ANTH, OAI);
  });

  it.each([
    ["token is a prefix of the key", "fakeOVL", "fakeOVL-longer-key"],
    ["key is a prefix of the token", "fakeOVL-longer-tok", "fakeOVL"],
  ])("overlapping secrets (%s): neither value survives in any order", async (_d, tok, key) => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", tok);
    vi.stubEnv("ANTHROPIC_API_KEY", key);
    const prompt = `A=${tok} B=${key} C=${key}${tok} D=${tok}${key}`;
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api", prompt }]), "--dry-run", "a"]);
    ok(r);
    absent(r, "fakeOVL");
  });

  it("whitespace-padded env values: padded and trimmed forms are both redacted; state is 'set'", async () => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", "  fake-pad-tok-9Q \n");
    vi.stubEnv("ANTHROPIC_API_KEY", "\tfake-pad-key-8R  ");
    const prompt = "x  fake-pad-tok-9Q \n y fake-pad-tok-9Q z fake-pad-key-8R w\tfake-pad-key-8R  ";
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api", prompt }]), "--dry-run", "a"]);
    ok(r);
    absent(r, "fake-pad-tok-9Q", "fake-pad-key-8R");
    expect(r.out).toContain("token env: TM230E_TOKEN (set)");
  });

  // BUG (leak): the MCP url line is printed raw, so a token embedded in the url is shown.
  it("token value that also appears in the MCP url is not printed", async () => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", "fake-url-tok-5521");
    const url = "https://mcp.example.com/mcp?key=fake-url-tok-5521";
    const r = await run(["--jobs", writeJobs([{ name: "a", url, prompt: "hello" }]), "--dry-run", "a"]);
    ok(r);
    absent(r, "fake-url-tok-5521");
  });

  it("secret containing regex/replace metacharacters is redacted literally", async () => {
    clearEnv();
    const v = "fake$&.*+?^${}()|[]\\$1-tok";
    vi.stubEnv("TM230E_TOKEN", v);
    const r = await run(["--jobs", writeJobs([{ name: "a", prompt: `a ${v} b` }]), "--dry-run", "a"]);
    ok(r);
    absent(r, v);
    expect(promptOf(r.out)).toBe("a [redacted] b");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   \t "],
  ])("%s env values do not redact anything and show 'missing'", async (_d, v) => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", v);
    vi.stubEnv("ANTHROPIC_API_KEY", v);
    const prompt = "Summarise the  book; keep\ttabs and   spaces.";
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api", prompt }]), "--dry-run", "a"]);
    ok(r);
    expect(promptOf(r.out)).toBe(prompt);
    expect(r.out).not.toContain("[redacted]");
    expect(r.out).toContain("token env: TM230E_TOKEN (missing)");
  });

  // BUG (over-redaction): a 1-2 char env value is redacted inside ordinary words, mangling the prompt.
  it.each([["a"], ["e"], ["10"]])("very short env value %j does not mangle normal prompt text", async (v) => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", v);
    const prompt = "Review a balance sheet for the 10 best entries";
    const r = await run(["--jobs", writeJobs([{ name: "a", prompt }]), "--dry-run", "a"]);
    ok(r);
    expect(promptOf(r.out)).toBe(prompt);
  });

  it("prompt with no secret is printed verbatim (multi-line, unicode, trailing spaces)", async () => {
    clearEnv();
    vi.stubEnv("TM230E_TOKEN", TOK);
    const prompt = "line1  \nline2 ✓ üñí\n\n  indented\ttab";
    const r = await run(["--jobs", writeJobs([{ name: "a", prompt }]), "--dry-run", "a"]);
    ok(r);
    expect(promptOf(r.out)).toBe(prompt);
  });
});

// ---- no side effects ----
describe("TM2-30 edge: --dry-run has no side effects", () => {
  it.each(["claude", "codex", "gemini", "api", "api-openai", "api-gemini"])(
    "%s with all env set and notify: no spawn/exec/fetch/http/fs write", async (backend) => {
      for (const n of ENVS) vi.stubEnv(n, `fake-${n}-val`);
      const r = await run(["--jobs", writeJobs([{ name: "a", backend, notify: "TM230E_CHAT", timeoutMs: 5 }]), "--dry-run", "a"]);
      ok(r);
    },
  );
  it("the jobs file itself is left unchanged", async () => {
    const file = writeJobs([{ name: "a" }]);
    const before = readFileSync(file, "utf8");
    ok(await run(["--jobs", file, "--dry-run", "a"]));
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

// ---- errors ----
describe("TM2-30 edge: --dry-run argument errors", () => {
  const file = () => writeJobs([{ name: "alpha" }, { name: "beta_2" }, { name: "gamma-3" }]);

  it("unknown name exits 1 and lists every valid name", async () => {
    const r = await run(["--jobs", file(), "--dry-run", "delta"]);
    fail(r, /delta/);
    for (const n of ["alpha", "beta_2", "gamma-3"]) expect(r.err).toContain(n);
  });
  it("name match is exact (case and prefix)", async () => {
    fail(await run(["--jobs", file(), "--dry-run", "Alpha"]), /alpha/);
    fail(await run(["--jobs", file(), "--dry-run", "alph"]), /alpha/);
  });
  it("missing name at end of args exits 1", async () => {
    fail(await run(["--jobs", file(), "--dry-run"]), /requires a job name/);
  });
  it("missing name followed by another flag exits 1", async () => {
    fail(await run(["--dry-run", "--jobs", file()]), /requires a job name/);
  });
  it("empty-string name exits 1", async () => {
    fail(await run(["--jobs", file(), "--dry-run", ""]), /.+/);
  });

  // BUG: `--dry-run=<name>` is not recognised; main falls through and STARTS THE SCHEDULER.
  it.each(["--dry-run=alpha", "--dry-run="])("%s is either accepted as a dry run or rejected; it never starts the scheduler", async (flag) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void stdout.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected fetch"); });
    const exit = vi.fn();
    const handlers: Record<string, () => void> = {};
    const onSignal = (s: string, fn: () => void) => void (handlers[s] = fn);
    const p = main(["--jobs", file(), flag], { exit, onSignal }).catch((e) => e);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stderr.join("\n")).not.toContain("scheduler started");
      expect(exit).toHaveBeenCalledTimes(1);
      if (flag === "--dry-run=alpha" && exit.mock.calls[0][0] === 0) expect(stdout.join("\n")).toContain("job: alpha");
      else expect(exit).toHaveBeenCalledWith(1);
    } finally {
      handlers.SIGINT?.();
      await vi.advanceTimersByTimeAsync(3600000);
      await p;
      expect(executeJob).not.toHaveBeenCalled();
    }
  });

  const pairs: [string, string[]][] = [
    ["--once", ["--once", "alpha"]],
    ["--check", ["--check"]],
    ["--next", ["--next", "3"]],
    ["--next", ["--next"]],
  ];
  for (const [flag, extra] of pairs) {
    it(`--dry-run with ${extra.join(" ")} (dry-run first) exits 1 naming ${flag}`, async () => {
      const r = await run(["--jobs", file(), "--dry-run", "alpha", ...extra]);
      fail(r, new RegExp(`--dry-run.*${flag}|${flag}.*--dry-run`));
    });
    it(`--dry-run with ${extra.join(" ")} (dry-run last) exits 1 naming ${flag}`, async () => {
      const r = await run(["--jobs", file(), ...extra, "--dry-run", "alpha"]);
      fail(r, new RegExp(`--dry-run.*${flag}|${flag}.*--dry-run`));
    });
  }
  it("all three conflicting flags at once are all named", async () => {
    const r = await run(["--check", "--dry-run", "alpha", "--next", "2", "--once", "alpha", "--jobs", file()]);
    fail(r, /--dry-run/);
    for (const f of ["--once", "--check", "--next"]) expect(r.err).toContain(f);
  });
  it("conflict is reported even when the name is missing", async () => {
    fail(await run(["--jobs", file(), "--check", "--dry-run"]), /--dry-run|--check/);
  });
  it("--jobs may come after the name", async () => {
    ok(await run(["--dry-run", "beta_2", "--jobs", file()]));
  });
});

// ---- next run ----
describe("TM2-30 edge: next run with a pinned clock", () => {
  const nextLine = (out: string) => out.split("\n").find((l) => l.startsWith("next run:"));
  const at = async (iso: string, j: J) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    const r = await run(["--jobs", writeJobs([j]), "--dry-run", j.name]);
    ok(r);
    return nextLine(r.out);
  };

  it("IST job, later today (IST)", async () => {
    // Fri 2026-11-27 02:00Z = 07:30 IST Fri
    expect(await at("2026-11-27T02:00:00Z", { name: "a", tz: "Asia/Kolkata", time: "08:45", days: ["Fri"] }))
      .toBe("next run: 2026-11-27 08:45 Asia/Kolkata | 2026-11-27T03:15:00.000Z");
  });
  it("IST/UTC date boundary: already Saturday in IST while still Friday in UTC", async () => {
    // Fri 2026-11-27 20:00Z = Sat 2026-11-28 01:30 IST. Sat 02:00 IST = Fri 20:30Z.
    expect(await at("2026-11-27T20:00:00Z", { name: "a", tz: "Asia/Kolkata", time: "02:00", days: ["Sat"] }))
      .toBe("next run: 2026-11-28 02:00 Asia/Kolkata | 2026-11-27T20:30:00.000Z");
  });
  it("IST job whose Friday slot has passed in IST (though it is still Friday UTC) goes to next Friday", async () => {
    // Fri 20:00Z = Sat 01:30 IST; Fri 08:45 IST already passed -> Fri 2026-12-04 08:45 IST
    expect(await at("2026-11-27T20:00:00Z", { name: "a", tz: "Asia/Kolkata", time: "08:45", days: ["Fri"] }))
      .toBe("next run: 2026-12-04 08:45 Asia/Kolkata | 2026-12-04T03:15:00.000Z");
  });
  it("UTC job at the same instant stays on Friday UTC", async () => {
    expect(await at("2026-11-27T20:00:00Z", { name: "u", tz: "UTC", time: "21:00", days: ["Fri"] }))
      .toBe("next run: 2026-11-27 21:00 UTC | 2026-11-27T21:00:00.000Z");
  });
  it("exactly at the slot time picks the next occurrence, not now", async () => {
    expect(await at("2026-11-27T21:00:00Z", { name: "u", tz: "UTC", time: "21:00", days: ["Fri"] }))
      .toBe("next run: 2026-12-04 21:00 UTC | 2026-12-04T21:00:00.000Z");
  });
  it("UTC job crossing a month/year boundary", async () => {
    // Thu 2026-12-31 23:59Z -> Fri 2027-01-01 00:00Z
    expect(await at("2026-12-31T23:59:00Z", { name: "u", tz: "UTC", time: "00:00", days: ["Fri"] }))
      .toBe("next run: 2027-01-01 00:00 UTC | 2027-01-01T00:00:00.000Z");
  });
  it("IST midnight slot maps to previous UTC day", async () => {
    // Sun 2026-11-29 00:00 IST = Sat 2026-11-28 18:30Z
    expect(await at("2026-11-28T12:00:00Z", { name: "a", tz: "Asia/Kolkata", time: "00:00", days: ["Sun"] }))
      .toBe("next run: 2026-11-29 00:00 Asia/Kolkata | 2026-11-28T18:30:00.000Z");
  });
});

// ---- per backend ----
describe("TM2-30 edge: per-backend fields", () => {
  it.each([
    ["claude", /model: .*CLI default/i, undefined],
    ["codex", /model: .*CLI default/i, undefined],
    ["gemini", /model: .*CLI default/i, undefined],
    ["api", /model: claude-opus-5-5/, undefined],
    ["api-openai", /model: gpt-5\.5\b.*OPENAI_MODEL/, "OPENAI_MODEL"],
    ["api-gemini", new RegExp(`model: ${DEFAULT_GEMINI_MODEL.replace(/\./g, "\\.")}\\b.*GEMINI_MODEL`), "GEMINI_MODEL"],
  ] as [string, RegExp, string | undefined][])("%s: backend, model and override env name (value hidden)", async (backend, modelRe, override) => {
    clearEnv();
    vi.stubEnv("OPENAI_MODEL", "fake-override-model-OAI");
    vi.stubEnv("GEMINI_MODEL", "fake-override-model-GEM");
    const r = await run(["--jobs", writeJobs([{ name: "a", backend, timeoutMs: 12345, tz: "UTC", time: "07:05", days: ["Mon", "Wed"] }]), "--dry-run", "a"]);
    ok(r);
    expect(r.out).toContain(`backend: ${backend}`);
    expect(r.out).toMatch(modelRe);
    if (override) expect(r.out).toContain(override);
    absent(r, "fake-override-model-OAI", "fake-override-model-GEM");
    expect(r.out).toContain("mcp url: https://mcp.example.com/mcp");
    expect(r.out).toContain("token env: TM230E_TOKEN (missing)");
    expect(r.out).toMatch(/timeout: 12345 ms/);
    expect(r.out).toMatch(/schedule: Mon,Wed 07:05 UTC/);
  });

  it("api-openai default shown matches the runner's DEFAULT_OPENAI_MODEL (drift guard)", async () => {
    const src = readFileSync(path.join(import.meta.dirname, "../src/openai.ts"), "utf8");
    const def = /DEFAULT_OPENAI_MODEL\s*=\s*"([^"]+)"/.exec(src)?.[1];
    expect(def).toBeTruthy();
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api-openai" }]), "--dry-run", "a"]);
    expect(r.out).toContain(`model: ${def}`);
  });
  it("api default shown matches the model hard-coded in api.ts (drift guard)", async () => {
    const src = readFileSync(path.join(import.meta.dirname, "../src/api.ts"), "utf8");
    const def = /model:\s*"([^"]+)"/.exec(src)?.[1];
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api" }]), "--dry-run", "a"]);
    expect(r.out).toContain(`model: ${def}`);
  });
  it("timeout unset shows a default, not 'undefined'", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--dry-run", "a"]);
    ok(r);
    expect(r.out).toMatch(/^timeout: /m);
    expect(r.out).not.toContain("undefined");
  });
});

// ---- jobs file errors ----
describe("TM2-30 edge: jobs file errors are clear, not stack traces", () => {
  it.each([
    ["invalid JSON", "{not json", /JSON|Unexpected|Expected/i],
    ["empty file", "", /JSON|Unexpected|end/i],
    ["not an array", '{"name":"a"}', /jobs must be an array/],
    ["bad job entry", '[{"name":"a b"}]', /jobs\[0\]: name/],
    ["non-object entry", JSON.stringify([1, 1]), /jobs\[0\]: must be an object/],
  ])("%s -> exit 1 with a clear message", async (_d, content, re) => {
    const r = await run(["--jobs", writeRaw(content), "--dry-run", "a"]);
    fail(r, re);
    noStack(r);
  });
  it("missing jobs file -> exit 1, message names the file", async () => {
    const missing = path.join(tmpDir(), "nope.json");
    const r = await run(["--jobs", missing, "--dry-run", "a"]);
    fail(r, /ENOENT|no such file/);
    expect(r.err).toContain("nope.json");
    noStack(r);
  });
  it("jobs path is a directory -> exit 1 cleanly", async () => {
    const r = await run(["--jobs", tmpDir(), "--dry-run", "a"]);
    fail(r, /EISDIR|directory/i);
    noStack(r);
  });
});
