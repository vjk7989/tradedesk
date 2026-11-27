import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as cp from "node:child_process";

const runTask = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => runTask(...a),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:child_process")>();
  return { ...m, spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn() };
});
const runScheduler = vi.fn();
vi.mock("../src/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/scheduler.js")>()),
  runScheduler: (...a: unknown[]) => runScheduler(...a),
}));

import { main } from "../src/main.js";

const SECRET_BODY = "BODY-SECRET-TEXT";
const report = (name: string, iso: string, status: string, dur?: number, err?: string) =>
  [`# ${name} - ${iso}`, "", `- status: ${status}`, ...(dur !== undefined ? [`- duration: ${dur} ms`] : []), ...(err ? [`- error: ${err}`] : []), "", "## Result", "", SECRET_BODY, ""].join("\n");

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "tm236-"));
  const out = path.join(root, "runs");
  const jobs = path.join(root, "jobs.json");
  const mk = (name: string) => ({
    name, backend: "claude", prompt: "p",
    schedule: { days: ["Mon"], time: "08:45", tz: "UTC" },
    mcp: { name: "t", url: "https://mcp.example.com/mcp", tokenEnv: "TM236_TOKEN" },
    outputDir: out,
  });
  writeFileSync(jobs, JSON.stringify([mk("alpha"), mk("beta")]));
  const put = (job: string, f: string, text: string) => {
    mkdirSync(path.join(out, job), { recursive: true });
    writeFileSync(path.join(out, job, f), text);
  };
  return { jobs, out, put };
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const lg = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const er = vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  const codes: number[] = [];
  await main(args, { exit: (c) => void codes.push(c), onSignal: () => {} });
  lg.mockRestore();
  er.mockRestore();
  return { out, err, codes };
}

afterEach(() => vi.clearAllMocks());

describe("--history", () => {
  it("lists newest first across jobs and -n files, header fields only", async () => {
    const { jobs, put, out } = setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    put("alpha", "2026-11-01.md", report("alpha", "2026-11-01T08:00:00.000Z", "ok", 1200));
    put("alpha", "2026-11-02.md", report("alpha", "2026-11-02T08:00:00.000Z", "error", 50, "boom"));
    put("alpha", "2026-11-02-1.md", report("alpha", "2026-11-02T09:00:00.000Z", "error", 7, "refused"));
    put("alpha", "2026-11-02-10.md", report("alpha", "2026-11-02T11:00:00.000Z", "ok"));
    put("alpha", "2026-11-02-2.md", report("alpha", "2026-11-02T10:00:00.000Z", "ok", 3));
    put("beta", "2026-11-02.md", report("beta", "2026-11-02T08:30:00.000Z", "ok", 9));
    const r = await run(["--jobs", jobs, "--history"]);
    expect(r.codes).toEqual([0]);
    const cols = r.out.map((l) => l.split("\t"));
    expect(cols.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "alpha 2026-11-02-10", "alpha 2026-11-02-2", "alpha 2026-11-02-1", "beta 2026-11-02", "alpha 2026-11-02", "alpha 2026-11-01",
    ]);
    expect(cols[0].slice(2, 4)).toEqual(["ok", "-"]);
    expect(cols[2].slice(2, 4)).toEqual(["refused", "7 ms"]);
    expect(cols[4].slice(2, 4)).toEqual(["failed", "50 ms"]);
    expect(cols[5][4]).toBe(path.join(out, "alpha", "2026-11-01.md"));
    const all = r.out.join("\n");
    expect(all).not.toContain(SECRET_BODY);
    expect(all).not.toContain("boom");
    expect(all).not.toContain("skipped");
    expect(runTask).not.toHaveBeenCalled();
    expect(runScheduler).not.toHaveBeenCalled();
    expect(cp.spawn).not.toHaveBeenCalled();
    expect(cp.execFile).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("limits to N in both forms and counts unreadable reports", async () => {
    const { jobs, put, out } = setup();
    put("alpha", "2026-11-01.md", report("alpha", "2026-11-01T08:00:00.000Z", "ok", 1));
    put("alpha", "2026-11-02.md", report("alpha", "2026-11-02T08:00:00.000Z", "ok", 2));
    put("alpha", "2026-11-03.md", "");
    put("alpha", "2026-11-04.md", "garbage\nno header");
    put("beta", "2026-11-05.md", report("beta", "2026-11-05T08:00:00.000Z", "weird", 2));
    mkdirSync(path.join(out, "beta", "2026-11-06.md"));
    put("beta", "notes.md", "ignored");
    for (const a of [["--history", "1"], ["--history=1"]]) {
      const r = await run(["--jobs", jobs, ...a]);
      expect(r.out).toHaveLength(2);
      expect(r.out[0].split("\t")[1]).toBe("2026-11-02");
      expect(r.out[1]).toBe("skipped 4 unreadable");
    }
    const r = await run(["--jobs", jobs, "--history", "5"]);
    expect(r.out).toHaveLength(3);
  });

  it("reports an empty history and tolerates a missing outputDir", async () => {
    const { jobs } = setup();
    const r = await run(["--jobs", jobs, "--history"]);
    expect(r.out).toEqual(["no reports found"]);
    expect(r.codes).toEqual([0]);
  });

  it("validates N like --next", async () => {
    const { jobs } = setup();
    for (const [a, msg] of [
      [["--history", "0"], "--history N must be a positive integer, got: 0"],
      [["--history", "abc"], "--history N must be a positive integer, got: abc"],
      [["--history=1.5"], "--history N must be a positive integer, got: 1.5"],
      [["--history="], "--history N must be a positive integer, got: "],
      [["--history", "201"], "--history N must be between 1 and 200"],
      [["--history=999"], "--history N must be between 1 and 200"],
    ] as [string[], string][]) {
      const r = await run(["--jobs", jobs, ...a]);
      expect(r.codes).toEqual([1]);
      expect(r.err).toEqual([msg]);
    }
    expect((await run(["--jobs", jobs, "--history", "200"])).codes).toEqual([0]);
  });

  it("never falls through to the scheduler, whatever the --history form", async () => {
    const { jobs } = setup();
    for (const a of [["--history"], ["--history=5"], ["--history5"], ["--history-x"], ["--history", "--foo"], ["--history=abc"]]) {
      await run(["--jobs", jobs, ...a]);
    }
    expect(runScheduler).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
    expect((await run(["--jobs", jobs, "--history5"])).codes).toEqual([1]);
  });

  it("is an error with --once, --check, --next or --dry-run", async () => {
    const { jobs } = setup();
    for (const other of [["--once", "alpha"], ["--once=alpha"], ["--check"], ["--next"], ["--next", "3"], ["--dry-run", "alpha"], ["--dry-run=alpha"]]) {
      const r = await run(["--jobs", jobs, "--history", ...other]);
      expect(r.codes).toEqual([1]);
      expect(r.err[0]).toMatch(/^--history cannot be combined with /);
      expect(r.out).toEqual([]);
    }
    expect(runTask).not.toHaveBeenCalled();
    expect(runScheduler).not.toHaveBeenCalled();
  });

  it("skips a report it cannot read", async () => {
    const { jobs, put, out } = setup();
    put("alpha", "2026-11-01.md", report("alpha", "2026-11-01T08:00:00.000Z", "ok", 1));
    put("alpha", "2026-11-02.md", report("alpha", "2026-11-02T08:00:00.000Z", "ok", 1));
    chmodSync(path.join(out, "alpha", "2026-11-02.md"), 0o000);
    const r = await run(["--jobs", jobs, "--history"]);
    if (process.getuid?.() === 0) expect(r.out).toHaveLength(2);
    else expect(r.out.map((l) => l.split("\t")[1] ?? l)).toEqual(["2026-11-01", "skipped 1 unreadable"]);
  });
});
