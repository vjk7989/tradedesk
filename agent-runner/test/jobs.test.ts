import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeJob, parseJobs, type Job, type Schedule } from "../src/jobs.js";
import { nextRun, runScheduler } from "../src/scheduler.js";

const sched = (over: Partial<Schedule> = {}): Schedule => ({
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"], time: "08:45", tz: "Asia/Kolkata", ...over,
});
const iso = (d: Date) => d.toISOString();
const rawJob = (over: Record<string, unknown> = {}) => ({
  name: "j1", schedule: sched(), backend: "claude", prompt: "p",
  mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" }, outputDir: "./out", ...over,
});

describe("nextRun", () => {
  // 08:45 IST = 03:15 UTC
  it("same day when still ahead", () => {
    expect(iso(nextRun(sched(), new Date("2026-01-07T02:00:00Z")))).toBe("2026-01-07T03:15:00.000Z"); // Wed
  });
  it("strictly after: exactly at the time rolls to next day", () => {
    expect(iso(nextRun(sched(), new Date("2026-01-07T03:15:00Z")))).toBe("2026-01-08T03:15:00.000Z");
  });
  it("Friday evening -> Monday", () => {
    expect(iso(nextRun(sched(), new Date("2026-01-09T10:00:00Z")))).toBe("2026-01-12T03:15:00.000Z");
  });
  it("weekend -> Monday", () => {
    expect(iso(nextRun(sched(), new Date("2026-01-10T05:00:00Z")))).toBe("2026-01-12T03:15:00.000Z");
  });
  it("IST midnight boundary: 23:59 IST Sunday vs 00:01 IST Monday", () => {
    // Sun 2026-01-11 23:59 IST = 18:29Z -> Monday 08:45 IST
    expect(iso(nextRun(sched(), new Date("2026-01-11T18:29:00Z")))).toBe("2026-01-12T03:15:00.000Z");
    // UTC still Sunday 18:31 = Monday 00:01 IST -> same Monday
    expect(iso(nextRun(sched(), new Date("2026-01-11T18:31:00Z")))).toBe("2026-01-12T03:15:00.000Z");
  });
  it("weekly Sat job and UTC tz", () => {
    expect(iso(nextRun(sched({ days: ["Sat"], time: "10:00" }), new Date("2026-01-10T04:00:00Z")))).toBe("2026-01-10T04:30:00.000Z");
    expect(iso(nextRun(sched({ days: ["Sat"], time: "10:00" }), new Date("2026-01-10T04:30:00Z")))).toBe("2026-01-17T04:30:00.000Z");
    expect(iso(nextRun(sched({ tz: "UTC", days: ["Mon"], time: "00:00" }), new Date("2026-01-11T23:59:00Z")))).toBe("2026-01-12T00:00:00.000Z");
  });
});

describe("parseJobs", () => {
  it("accepts a valid job", () => {
    expect(parseJobs([rawJob()])[0].name).toBe("j1");
  });
  it.each([
    ["not array", {}],
    ["bad tz", [rawJob({ schedule: { ...sched(), tz: "America/New_York" } })]],
    ["bad day", [rawJob({ schedule: { ...sched(), days: ["Funday"] } })]],
    ["empty days", [rawJob({ schedule: { ...sched(), days: [] } })]],
    ["bad time", [rawJob({ schedule: { ...sched(), time: "25:00" } })]],
    ["bad backend", [rawJob({ backend: "gpt" })]],
    ["bad name", [rawJob({ name: "../x" })]],
    ["empty prompt", [rawJob({ prompt: " " })]],
    ["bad mcp", [rawJob({ mcp: { name: "a", url: "ftp://x", tokenEnv: "T" } })]],
    ["duplicate", [rawJob(), rawJob()]],
    ["no outputDir", [rawJob({ outputDir: "" })]],
  ])("rejects %s", (_n, raw) => {
    expect(() => parseJobs(raw)).toThrow();
  });
});

describe("runScheduler", () => {
  it("runs a due job once and does not back-fill missed runs", async () => {
    const jobs = parseJobs([rawJob()]);
    // Start Wed 02:00Z; due Wed 03:15Z. The run "takes" until Fri 10:00Z (missed Thu, Fri).
    let clock = new Date("2026-01-07T02:00:00Z").getTime();
    const ran: string[] = [];
    let stop = false;
    await runScheduler(jobs, {
      now: () => new Date(clock),
      sleep: async (ms) => { clock += ms; },
      run: async (j) => {
        ran.push(new Date(clock).toISOString());
        clock = new Date("2026-01-09T10:00:00Z").getTime();
        if (ran.length === 2) stop = true;
      },
      stopped: () => stop,
    });
    expect(ran).toEqual(["2026-01-07T03:15:00.000Z", "2026-01-12T03:15:00.000Z"]);
  });
});

describe("executeJob", () => {
  it("writes the output file with redacted token", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jobs-"));
    const job: Job = { ...parseJobs([rawJob({ outputDir: dir })])[0] };
    const env = { MCP_TOKEN: "SUPERSECRETTOKEN123" };
    const run = async () => ({ ok: true, text: "result with SUPERSECRETTOKEN123 inside", exitCode: 0 });
    const f = await executeJob(job, { run, env, now: () => new Date("2026-01-07T03:15:00Z") });
    expect(f).toBe(path.join(dir, "j1", "2026-01-07.md"));
    const txt = readFileSync(f, "utf8");
    expect(txt).not.toContain("SUPERSECRETTOKEN123");
    expect(txt).toContain("[redacted]");
    expect(txt).toContain("status: ok");
    expect(txt).toContain("## Prompt");
    // second run same day gets a new file
    await executeJob(job, { run, env, now: () => new Date("2026-01-07T04:00:00Z") });
    expect(readdirSync(path.join(dir, "j1")).sort()).toEqual(["2026-01-07-1.md", "2026-01-07.md"]);
  });
  it("records errors from a throwing run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jobs-"));
    const job = parseJobs([rawJob({ outputDir: dir })])[0];
    const f = await executeJob(job, { run: async () => { throw new Error("boom"); }, env: {} });
    expect(readFileSync(f, "utf8")).toMatch(/status: error[\s\S]*error: boom/);
  });
});
