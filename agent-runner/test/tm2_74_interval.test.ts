import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runTask = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => runTask(...a),
}));

import { parseJobs, type Job, type Schedule } from "../src/jobs.js";
import { nextRun, runScheduler } from "../src/scheduler.js";
import { main } from "../src/main.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NAME = "intv-job";
const rawJob = (schedule: Record<string, unknown>, name = NAME) => ({
  name, schedule, backend: "claude", prompt: "p",
  mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" }, outputDir: "./out",
});
const every = (n: unknown, over: Record<string, unknown> = {}) => ({ days: ALL, everyMinutes: n, tz: "UTC", ...over });
const parseErr = (schedule: Record<string, unknown>): string => {
  try {
    parseJobs([rawJob(schedule)]);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected parseJobs to throw");
};
const iso = (d: Date) => d.toISOString();
const S = (over: Partial<Schedule>): Schedule => ({ days: ALL as Schedule["days"], tz: "UTC", ...over });
/** k successive nextRun values from `from`. */
const seq = (s: Schedule, from: string, k: number) => {
  const out: string[] = [];
  let t = new Date(from);
  for (let i = 0; i < k; i++) out.push(iso((t = nextRun(s, t))));
  return out;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runTask.mockReset();
});

// ---------------------------------------------------------------- 1. parse validation
describe("parseJobs: everyMinutes", () => {
  const RANGE = `schedule.everyMinutes must be an integer from 5 to 1440 (job "${NAME}")`;
  it.each([
    ["0", 0], ["4", 4], ["1441", 1441], ["7.5", 7.5], ['"30"', "30"], ["-5", -5], ["NaN", NaN], ["null", null],
  ])("rejects everyMinutes %s", (_l, v) => {
    expect(parseErr(every(v))).toBe(`jobs[0]: ${RANGE}`);
  });
  it.each([[5], [1440], [5.0]])("accepts everyMinutes %s", (v) => {
    const [j] = parseJobs([rawJob(every(v))]);
    expect(j.schedule).toEqual({ days: ALL, everyMinutes: v, tz: "UTC" });
    expect("time" in j.schedule).toBe(false);
  });
  it("both time and everyMinutes is an error naming the job", () => {
    expect(parseErr(every(30, { time: "10:00" }))).toBe(
      `jobs[0]: schedule must have exactly one of time or everyMinutes, not both (job "${NAME}")`,
    );
  });
  it("neither time nor everyMinutes is an error naming the job", () => {
    expect(parseErr({ days: ALL, tz: "UTC" })).toBe(
      `jobs[0]: schedule must have exactly one of time or everyMinutes (job "${NAME}")`,
    );
  });
});

describe("parseJobs: between", () => {
  const SHAPE = `jobs[0]: schedule.between must be ["HH:MM","HH:MM"] (job "${NAME}")`;
  const ORDER = `jobs[0]: schedule.between start must be before end, no overnight windows (job "${NAME}")`;
  it.each([
    ["24:00 end", ["09:00", "24:00"], SHAPE],
    ["9:5 start", ["9:5", "10:00"], SHAPE],
    ["3 elements", ["09:00", "10:00", "11:00"], SHAPE],
    ["null", null, SHAPE],
    ["a string", "09:00-10:00", SHAPE],
    ["equal ends", ["09:00", "09:00"], ORDER],
    ["reversed ends", ["15:30", "09:15"], ORDER],
  ])("rejects %s", (_l, between, msg) => {
    expect(parseErr(every(30, { between }))).toBe(msg);
  });
  it("between with time is rejected", () => {
    expect(parseErr({ days: ALL, time: "10:00", between: ["09:00", "10:00"], tz: "UTC" })).toBe(
      `jobs[0]: schedule.between is only allowed with everyMinutes (job "${NAME}")`,
    );
  });
  it.each([
    [60, ["09:10", "09:50"]],
    [1440, ["00:01", "23:59"]],
    [7, ["23:56", "23:59"]],
  ])("rejects an empty window: every %s within %j", (n, between) => {
    expect(parseErr(every(n, { between }))).toBe(
      `jobs[0]: job "${NAME}": between ${between[0]}-${between[1]} contains no every-${n}-min slot`,
    );
  });
  it("accepts every 60 within 09:00-09:50 (one slot, 09:00)", () => {
    const [j] = parseJobs([rawJob(every(60, { between: ["09:00", "09:50"] }))]);
    expect(j.schedule).toEqual({ days: ALL, everyMinutes: 60, between: ["09:00", "09:50"], tz: "UTC" });
    expect(seq(j.schedule, "2026-11-30T08:00:00Z", 2)).toEqual(["2026-11-30T09:00:00.000Z", "2026-12-01T09:00:00.000Z"]);
  });
});

// ---------------------------------------------------------------- 2. nextRun math
describe("nextRun: interval grid", () => {
  it("every 30 across midnight, UTC", () => {
    expect(seq(S({ everyMinutes: 30 }), "2026-11-28T23:40:00Z", 3)).toEqual([
      "2026-11-29T00:00:00.000Z", "2026-11-29T00:30:00.000Z", "2026-11-29T01:00:00.000Z",
    ]);
  });
  it("every 30 across IST midnight (18:30Z)", () => {
    expect(seq(S({ everyMinutes: 30, tz: "Asia/Kolkata" }), "2026-11-28T17:50:00Z", 3)).toEqual([
      "2026-11-28T18:00:00.000Z", "2026-11-28T18:30:00.000Z", "2026-11-28T19:00:00.000Z",
    ]);
  });
  it("N=7 at the day end: 23:55 then next day 00:00 (UTC and IST)", () => {
    expect(seq(S({ everyMinutes: 7 }), "2026-11-28T23:50:00Z", 3)).toEqual([
      "2026-11-28T23:55:00.000Z", "2026-11-29T00:00:00.000Z", "2026-11-29T00:07:00.000Z",
    ]);
    expect(seq(S({ everyMinutes: 7, tz: "Asia/Kolkata" }), "2026-11-28T18:20:00Z", 3)).toEqual([
      "2026-11-28T18:25:00.000Z", "2026-11-28T18:30:00.000Z", "2026-11-28T18:37:00.000Z",
    ]);
  });
  it("N=1440: one slot per local day at 00:00", () => {
    expect(seq(S({ everyMinutes: 1440 }), "2026-11-28T00:00:00Z", 2)).toEqual([
      "2026-11-29T00:00:00.000Z", "2026-11-30T00:00:00.000Z",
    ]);
    expect(seq(S({ everyMinutes: 1440, tz: "Asia/Kolkata" }), "2026-11-28T10:00:00Z", 2)).toEqual([
      "2026-11-28T18:30:00.000Z", "2026-11-29T18:30:00.000Z",
    ]);
  });
  it("weekend filter uses the LOCAL weekday (IST vs UTC at the boundary)", () => {
    const ist = S({ everyMinutes: 30, days: ["Sat", "Sun"], tz: "Asia/Kolkata" });
    const utc = S({ everyMinutes: 30, days: ["Sat", "Sun"] });
    // 2026-11-27 is a Friday. 18:25Z = Fri 23:55 IST; 18:30Z = Sat 00:00 IST; 18:37Z = Sat 00:07 IST.
    expect(iso(nextRun(ist, new Date("2026-11-27T18:25:00Z")))).toBe("2026-11-27T18:30:00.000Z");
    expect(iso(nextRun(ist, new Date("2026-11-27T18:30:00Z")))).toBe("2026-11-27T19:00:00.000Z");
    expect(iso(nextRun(ist, new Date("2026-11-27T18:37:00Z")))).toBe("2026-11-27T19:00:00.000Z");
    // the same instants are still Friday in UTC
    expect(iso(nextRun(utc, new Date("2026-11-27T18:25:00Z")))).toBe("2026-11-28T00:00:00.000Z");
    expect(iso(nextRun(utc, new Date("2026-11-27T18:30:00Z")))).toBe("2026-11-28T00:00:00.000Z");
    expect(iso(nextRun(utc, new Date("2026-11-27T18:37:00Z")))).toBe("2026-11-28T00:00:00.000Z");
    // end of Sunday IST (Sun 23:55 IST = 18:25Z) -> next Saturday 00:00 IST
    expect(iso(nextRun(ist, new Date("2026-11-29T18:25:00Z")))).toBe("2026-12-04T18:30:00.000Z");
  });
  it("Monday-only filter uses the LOCAL weekday", () => {
    const ist = S({ everyMinutes: 30, days: ["Mon"], tz: "Asia/Kolkata" });
    const utc = S({ everyMinutes: 30, days: ["Mon"] });
    // 2026-11-29 is a Sunday in UTC; 18:30Z is Mon 00:00 IST.
    expect(iso(nextRun(ist, new Date("2026-11-29T18:25:00Z")))).toBe("2026-11-29T18:30:00.000Z");
    expect(iso(nextRun(ist, new Date("2026-11-29T18:30:00Z")))).toBe("2026-11-29T19:00:00.000Z");
    expect(iso(nextRun(ist, new Date("2026-11-29T18:37:00Z")))).toBe("2026-11-29T19:00:00.000Z");
    expect(iso(nextRun(utc, new Date("2026-11-29T18:37:00Z")))).toBe("2026-11-30T00:00:00.000Z");
    // Mon 23:55 IST -> next Monday 00:00 IST; UTC Monday at 18:30Z still has Monday slots
    expect(iso(nextRun(ist, new Date("2026-11-30T18:25:00Z")))).toBe("2026-12-06T18:30:00.000Z");
    expect(iso(nextRun(utc, new Date("2026-11-30T18:30:00Z")))).toBe("2026-11-30T19:00:00.000Z");
  });
  it("between: end inclusive, grid not re-anchored to the window start", () => {
    const w45 = S({ everyMinutes: 45, between: ["09:15", "15:30"] });
    expect(seq(w45, "2026-11-30T09:00:00Z", 9)).toEqual([
      "2026-11-30T09:45:00.000Z", "2026-11-30T10:30:00.000Z", "2026-11-30T11:15:00.000Z",
      "2026-11-30T12:00:00.000Z", "2026-11-30T12:45:00.000Z", "2026-11-30T13:30:00.000Z",
      "2026-11-30T14:15:00.000Z", "2026-11-30T15:00:00.000Z", "2026-12-01T09:45:00.000Z",
    ]);
    const w60 = S({ everyMinutes: 60, between: ["09:00", "10:00"] });
    expect(seq(w60, "2026-11-30T08:59:00Z", 3)).toEqual([
      "2026-11-30T09:00:00.000Z", "2026-11-30T10:00:00.000Z", "2026-12-01T09:00:00.000Z",
    ]);
    // IST, Mon/Tue, asked on Saturday
    const ist = S({ everyMinutes: 45, between: ["09:15", "15:30"], days: ["Mon", "Tue"], tz: "Asia/Kolkata" });
    expect(seq(ist, "2026-11-28T00:00:00Z", 3)).toEqual([
      "2026-11-30T04:15:00.000Z", "2026-11-30T05:00:00.000Z", "2026-11-30T05:45:00.000Z",
    ]);
  });
  it("a start exactly on a slot is strictly after it", () => {
    const s = S({ everyMinutes: 30 });
    expect(iso(nextRun(s, new Date("2026-11-30T09:30:00.000Z")))).toBe("2026-11-30T10:00:00.000Z");
    expect(iso(nextRun(s, new Date("2026-11-30T09:29:59.999Z")))).toBe("2026-11-30T09:30:00.000Z");
    expect(iso(nextRun(S({ everyMinutes: 1440, tz: "Asia/Kolkata" }), new Date("2026-11-28T18:30:00Z")))).toBe(
      "2026-11-29T18:30:00.000Z",
    );
  });
  it("year-end rollover (UTC and IST)", () => {
    expect(iso(nextRun(S({ everyMinutes: 30 }), new Date("2026-12-31T23:45:00Z")))).toBe("2027-01-01T00:00:00.000Z");
    expect(iso(nextRun(S({ everyMinutes: 30, tz: "Asia/Kolkata" }), new Date("2026-12-31T18:15:00Z")))).toBe(
      "2026-12-31T18:30:00.000Z",
    );
    expect(iso(nextRun(S({ everyMinutes: 1440, days: ["Fri"] }), new Date("2026-12-31T12:00:00Z")))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------- 3. runScheduler with fake deps
function harness(stopAfter: number, durations: Record<string, number>) {
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
  const ran: string[] = [];
  let clock = 0;
  let stop = false;
  const deps = {
    now: () => new Date(clock),
    sleep: async (ms: number) => { clock += ms; },
    run: async (j: Job) => {
      ran.push(`${j.name}@${new Date(clock).toISOString()}`);
      clock += durations[j.name] * 60000;
      if (ran.length >= stopAfter) stop = true;
    },
    stopped: () => stop,
  };
  return { logs, ran, deps, setClock: (t: string) => { clock = new Date(t).getTime(); } };
}

describe("runScheduler: interval overlap", () => {
  it("30-min job with 70-min runs starts at 10:00, 11:30, 13:00; one log per skipped slot", async () => {
    const jobs = parseJobs([rawJob(every(30), "a")]);
    const h = harness(3, { a: 70 });
    h.setClock("2026-11-30T09:50:00Z");
    await runScheduler(jobs, h.deps);
    expect(h.ran).toEqual([
      "a@2026-11-30T10:00:00.000Z", "a@2026-11-30T11:30:00.000Z", "a@2026-11-30T13:00:00.000Z",
    ]);
    const skips = h.logs.filter((l) => l.includes("skipped"));
    expect(skips).toEqual([
      "job a: slot 2026-11-30T10:30:00.000Z skipped (previous run still active)",
      "job a: slot 2026-11-30T11:00:00.000Z skipped (previous run still active)",
      "job a: slot 2026-11-30T12:00:00.000Z skipped (previous run still active)",
      "job a: slot 2026-11-30T12:30:00.000Z skipped (previous run still active)",
      "job a: slot 2026-11-30T13:30:00.000Z skipped (previous run still active)",
      "job a: slot 2026-11-30T14:00:00.000Z skipped (previous run still active)",
    ]);
    expect(new Set(skips).size).toBe(skips.length);
    expect(h.logs).toEqual(skips); // nothing else logged
  });

  it("a slot missed because another job was running logs 'missed while runner busy with another job'", async () => {
    // b (time 10:00, 40 min) is listed first; a (every 30, 5 min) is also due at 10:00 and starts 10:40.
    const jobs = parseJobs([rawJob({ days: ALL, time: "10:00", tz: "UTC" }, "b"), rawJob(every(30), "a")]);
    const h = harness(3, { a: 5, b: 40 });
    h.setClock("2026-11-30T09:50:00Z");
    await runScheduler(jobs, h.deps);
    expect(h.ran).toEqual(["b@2026-11-30T10:00:00.000Z", "a@2026-11-30T10:40:00.000Z", "a@2026-11-30T11:00:00.000Z"]);
    expect(h.logs).toEqual(["job a: slot 2026-11-30T10:30:00.000Z skipped (missed while runner busy with another job)"]);
  });
});

describe("runScheduler: cross-job time jobs (unchanged from main)", () => {
  it("a time job whose minute passes during another run is not skipped; it runs late", async () => {
    const jobs = parseJobs([
      rawJob({ days: ALL, time: "10:00", tz: "UTC" }, "a"),
      rawJob({ days: ALL, time: "10:15", tz: "UTC" }, "b"),
      rawJob({ days: ALL, time: "10:16", tz: "UTC" }, "c"),
    ]);
    const h = harness(6, { a: 20, b: 5, c: 30 });
    h.setClock("2026-11-30T09:00:00Z");
    await runScheduler(jobs, h.deps);
    expect(h.ran).toEqual([
      "a@2026-11-30T10:00:00.000Z", "b@2026-11-30T10:20:00.000Z", "c@2026-11-30T10:25:00.000Z",
      "a@2026-12-01T10:00:00.000Z", "b@2026-12-01T10:20:00.000Z", "c@2026-12-01T10:25:00.000Z",
    ]);
    expect(h.logs).toEqual([]);
  });
});

describe("runScheduler: defence in depth", () => {
  it("a job with an unreachable schedule is dropped with a log; the others still run", async () => {
    const [bad, good] = parseJobs([rawJob(every(60), "bad"), rawJob({ days: ALL, time: "10:00", tz: "UTC" }, "good")]);
    // force a schedule parse would reject (no 60-min slot in 09:10-09:50)
    const forced: Job = { ...bad, schedule: { ...bad.schedule, between: ["09:10", "09:50"] } };
    const h = harness(2, { good: 5 });
    h.setClock("2026-11-30T09:00:00Z");
    await runScheduler([forced, good], h.deps);
    expect(h.ran).toEqual(["good@2026-11-30T10:00:00.000Z", "good@2026-12-01T10:00:00.000Z"]);
    expect(h.logs).toEqual(["job bad: no next run, job disabled (no next run)"]);
  });
  it("with every job dropped the scheduler returns without running or sleeping", async () => {
    const [bad] = parseJobs([rawJob(every(60), "bad")]);
    const forced: Job = { ...bad, schedule: { ...bad.schedule, between: ["09:10", "09:50"] } };
    const h = harness(1, {});
    const sleep = vi.fn(h.deps.sleep);
    const run = vi.fn(h.deps.run);
    h.setClock("2026-11-30T09:00:00Z");
    await expect(runScheduler([forced], { ...h.deps, sleep, run })).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(h.logs).toEqual(["job bad: no next run, job disabled (no next run)"]);
  });
});

// ---------------------------------------------------------------- 4. byte-identity of time schedules
// Expected values generated from an origin/main build (nextRun x4 per job per instant); identical on this branch.
const PINS: Record<string, Record<string, string[]>> = {
  "2026-11-27T18:30:00.000Z": {
    "pre-market-brief": ["2026-11-30T03:15:00.000Z", "2026-12-01T03:15:00.000Z", "2026-12-02T03:15:00.000Z", "2026-12-03T03:15:00.000Z"],
    "eod-review": ["2026-11-30T10:15:00.000Z", "2026-12-01T10:15:00.000Z", "2026-12-02T10:15:00.000Z", "2026-12-03T10:15:00.000Z"],
    "weekly-backtest-refresh": ["2026-11-28T04:30:00.000Z", "2026-12-05T04:30:00.000Z", "2026-12-12T04:30:00.000Z", "2026-12-19T04:30:00.000Z"],
    "paper-crypto-gemini": ["2026-11-28T00:00:00.000Z", "2026-11-29T00:00:00.000Z", "2026-11-30T00:00:00.000Z", "2026-12-01T00:00:00.000Z"],
  },
  "2026-11-30T03:15:00.000Z": {
    "pre-market-brief": ["2026-12-01T03:15:00.000Z", "2026-12-02T03:15:00.000Z", "2026-12-03T03:15:00.000Z", "2026-12-04T03:15:00.000Z"],
    "eod-review": ["2026-11-30T10:15:00.000Z", "2026-12-01T10:15:00.000Z", "2026-12-02T10:15:00.000Z", "2026-12-03T10:15:00.000Z"],
    "weekly-backtest-refresh": ["2026-12-05T04:30:00.000Z", "2026-12-12T04:30:00.000Z", "2026-12-19T04:30:00.000Z", "2026-12-26T04:30:00.000Z"],
    "paper-crypto-gemini": ["2026-12-01T00:00:00.000Z", "2026-12-02T00:00:00.000Z", "2026-12-03T00:00:00.000Z", "2026-12-04T00:00:00.000Z"],
  },
  "2026-12-31T23:59:00.000Z": {
    "pre-market-brief": ["2027-01-01T03:15:00.000Z", "2027-01-04T03:15:00.000Z", "2027-01-05T03:15:00.000Z", "2027-01-06T03:15:00.000Z"],
    "eod-review": ["2027-01-01T10:15:00.000Z", "2027-01-04T10:15:00.000Z", "2027-01-05T10:15:00.000Z", "2027-01-06T10:15:00.000Z"],
    "weekly-backtest-refresh": ["2027-01-02T04:30:00.000Z", "2027-01-09T04:30:00.000Z", "2027-01-16T04:30:00.000Z", "2027-01-23T04:30:00.000Z"],
    "paper-crypto-gemini": ["2027-01-01T00:00:00.000Z", "2027-01-02T00:00:00.000Z", "2027-01-03T00:00:00.000Z", "2027-01-04T00:00:00.000Z"],
  },
};

describe("byte-identity: example time schedules", () => {
  const load = (f: string) => parseJobs(JSON.parse(readFileSync(path.join(ROOT, f), "utf8")));
  const jobs = [...load("jobs.example.json"), ...load("jobs.gemini-paper.example.json")];
  it("parsed time schedules keep exactly {days,time,tz}", () => {
    expect(jobs.map((j) => j.name)).toEqual(["pre-market-brief", "eod-review", "weekly-backtest-refresh", "paper-crypto-gemini"]);
    for (const j of jobs) expect(Object.keys(j.schedule)).toEqual(["days", "time", "tz"]);
  });
  it.each(Object.keys(PINS))("next runs from %s match origin/main", (at) => {
    const got: Record<string, string[]> = {};
    for (const j of jobs) got[j.name] = seq(j.schedule, at, 4);
    expect(got).toEqual(PINS[at]);
  });
});

// ---------------------------------------------------------------- 5. --dry-run text
describe("--dry-run for an interval job", () => {
  it("prints 'every 45 min between 09:15-15:30' and the first in-window slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T00:00:00Z")); // Saturday
    vi.stubEnv("MCP_TOKEN", "fake-tok-AAA111");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "tm274-")), "jobs.json");
    writeFileSync(file, JSON.stringify([
      rawJob({ days: ["Mon", "Tue"], everyMinutes: 45, between: ["09:15", "15:30"], tz: "Asia/Kolkata" }, "mkt"),
    ]));
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
    const exit = vi.fn();
    await main(["--jobs", file, "--dry-run", "mkt"], { exit, onSignal: () => {} });
    expect(exit).toHaveBeenCalledWith(0);
    const lines = out.join("\n").split("\n");
    expect(lines).toContain("schedule: Mon,Tue every 45 min between 09:15-15:30 Asia/Kolkata");
    expect(lines).toContain("next run: 2026-11-30 09:45 Asia/Kolkata | 2026-11-30T04:15:00.000Z");
    expect(out.join("\n")).not.toContain("fake-tok-AAA111");
    expect(runTask).not.toHaveBeenCalled();
  });
});
