import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
const spawned = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  const trap = (n: string) => (...a: unknown[]) => { spawned(n, ...a); throw new Error(`unexpected ${n}`); };
  return { ...orig, default: orig, spawn: trap("spawn"), exec: trap("exec"), execFile: trap("execFile"), fork: trap("fork"), spawnSync: trap("spawnSync"), execSync: trap("execSync") };
});

import { main } from "../src/main.js";

const BOUND = "--next N must be between 1 and 100";
const POSINT = (n: string) => `--next N must be a positive integer, got: ${n}`;

const writeJobs = (names: string[] = ["a"]) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tm212e-")), "jobs.json");
  writeFileSync(file, JSON.stringify(names.map((name) => ({
    name,
    schedule: { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], time: "08:45", tz: "Asia/Kolkata" },
    backend: "claude", prompt: "p",
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "TM212E_TOKEN" },
    outputDir: "./runs-tm212e",
  }))));
  return file;
};

/** Captures stdout and stderr separately, per call (one entry per console call). */
async function run(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(console, "info").mockImplementation((...a) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => (stdout.push(String(c)), true)) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => (stderr.push(String(c)), true)) as any);
  const exit = vi.fn();
  const onSignal = vi.fn();
  let threw: unknown;
  try {
    await main(args, { exit, onSignal });
  } catch (e) {
    threw = e;
  }
  return { stdout, stderr, out: stdout.join("\n"), exit, onSignal, threw };
}
type R = Awaited<ReturnType<typeof run>>;
const lines = (out: string) => out.split("\n").filter((l) => l.startsWith("  "));

const fakeClock = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-27T04:00:00Z"));
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  runTask.mockReset();
  executeJob.mockReset();
  spawned.mockReset();
});

const nothingRan = (r: R) => {
  expect(r.threw).toBeUndefined();
  expect(runTask).not.toHaveBeenCalled();
  expect(executeJob).not.toHaveBeenCalled();
  expect(spawned).not.toHaveBeenCalled();
  expect(r.onSignal).not.toHaveBeenCalled();
};

/** Exactly one stderr message, nothing on stdout, exit(1) exactly once. */
const rejectedWith = (r: R, msg: string) => {
  expect(r.stderr).toEqual([msg]);
  expect(r.stdout).toEqual([]);
  expect(r.exit).toHaveBeenCalledTimes(1);
  expect(r.exit).toHaveBeenCalledWith(1);
  nothingRan(r);
};

describe("TM2-12 edge: --next boundaries", () => {
  it.each([
    ["99", 99],
    ["100", 100],
    ["0100", 100],
  ])("N=%j accepted -> exactly %i strictly increasing, daily-spaced lines; exit 0 once", async (n, count) => {
    fakeClock();
    const r = await run(["--jobs", writeJobs(), "--next", n]);
    expect(r.stderr).toEqual([]);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(0);
    const ls = lines(r.out);
    expect(ls).toHaveLength(count);
    expect(ls[0]).toBe("  2026-11-28 08:45 Asia/Kolkata  2026-11-28T03:15:00.000Z");
    const ts = ls.map((l) => Date.parse(l.trim().split(/\s+/).at(-1)!));
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBe(86_400_000);
    nothingRan(r);
  });

  it("N=100 with 2 jobs -> 100 lines per job (bound is per job, not total)", async () => {
    fakeClock();
    const r = await run(["--jobs", writeJobs(["a", "b"]), "--next", "100"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(lines(r.out)).toHaveLength(200);
    expect(r.stdout.filter((l) => !l.startsWith("  "))).toEqual(["a", "b"]);
  });

  it.each(["101", "1000", "1e3", "1e6", "Infinity", "000101", "101.5", "99999999999999999999"])(
    "N=%j (> 100) -> bound message once, exit 1 once",
    async (n) => {
      rejectedWith(await run(["--jobs", writeJobs(), "--next", n]), BOUND);
    },
  );

  // Surprising but consistent with the code: the bound check is `Number(a) > 100` and runs BEFORE the
  // digits-only check, so non-digit strings that Number() parses as > 100 get the bound message, not the
  // positive-integer one. Still exit 1 either way.
  it.each(["0x65", " 101", "+101", "101 "])("N=%j (non-digit, Number() > 100) -> bound message", async (n) => {
    rejectedWith(await run(["--jobs", writeJobs(), "--next", n]), BOUND);
  });

  // "100.0", "1e2", "0x64", " 100", "+100" all equal 100 numerically, but the digits-only regex rejects them
  // with the existing positive-integer message (the bound check only fires for > 100).
  it.each(["100.0", "1e2", "0x64", " 100", "+100", "100abc", "-0", "-101", "NaN", "-Infinity", "0", ""])(
    "N=%j -> positive-integer message once, exit 1 once",
    async (n) => {
      rejectedWith(await run(["--jobs", writeJobs(), "--next", n]), POSINT(n));
    },
  );

  it("the bound error happens before the jobs file is read (missing file still gives the bound message)", async () => {
    const r = await run(["--jobs", path.join(tmpdir(), "tm212e-does-not-exist", "jobs.json"), "--next", "101"]);
    rejectedWith(r, BOUND);
  });
});

describe("TM2-12 edge: --next flag shape unchanged", () => {
  it("--next as the last arg -> default 5", async () => {
    fakeClock();
    const r = await run(["--jobs", writeJobs(), "--next"]);
    expect(r.stderr).toEqual([]);
    expect(lines(r.out)).toHaveLength(5);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(0);
    nothingRan(r);
  });

  it("--next followed by another flag (--jobs) -> default 5", async () => {
    fakeClock();
    const r = await run(["--next", "--jobs", writeJobs()]);
    expect(lines(r.out)).toHaveLength(5);
    expect(r.exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ["--next", "--check"],
    ["--check", "--next"],
    ["--next", "101", "--check"],
    ["--next", "100", "--check"],
  ])("%s %s ... -> combined-flag rejection, not the bound message", async (...flags) => {
    const r = await run(["--jobs", writeJobs(), ...flags]);
    rejectedWith(r, "--check and --next cannot be combined");
  });
});
