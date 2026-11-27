import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeJob, parseJobs, JobsError, type Job, type Schedule } from "../src/jobs.js";
import { nextRun, runScheduler } from "../src/scheduler.js";

const sched = (over: Partial<Schedule> = {}): Schedule => ({
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"], time: "08:45", tz: "Asia/Kolkata", ...over,
});
const iso = (d: Date) => d.toISOString();
const rawJob = (over: Record<string, unknown> = {}) => ({
  name: "j1", schedule: sched(), backend: "claude", prompt: "p",
  mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" }, outputDir: "./out", ...over,
});
const withSched = (s: Record<string, unknown>) => [rawJob({ schedule: { ...sched(), ...s } })];
const tmp = () => mkdtempSync(path.join(tmpdir(), "jobs-edge-"));
const job = (over: Partial<Job> = {}): Job => ({ ...parseJobs([rawJob()])[0], ...over });
const okRun = async () => ({ ok: true, text: "", exitCode: 0 });

describe("parseJobs edges", () => {
  it.each(["24:00", "9:15", "09:60", "-1:00", " 08:45", "08:45 ", "", "0845"])("rejects time %j", (time) => {
    expect(() => parseJobs(withSched({ time }))).toThrow(JobsError);
  });
  it.each(["00:00", "23:59"])("accepts boundary time %s", (time) => {
    expect(parseJobs(withSched({ time }))[0].schedule.time).toBe(time);
  });
  it.each([[["mon"]], [[]], [null], ["Mon"], [["Mon", "Funday"]]])("rejects days %j", (days) => {
    expect(() => parseJobs(withSched({ days }))).toThrow(JobsError);
  });
  it("duplicate days accepted and harmless for nextRun", () => {
    const j = parseJobs(withSched({ days: ["Mon", "Mon"] }))[0];
    expect(iso(nextRun(j.schedule, new Date("2026-01-12T03:15:00Z")))).toBe("2026-01-19T03:15:00.000Z");
  });
  it.each(["IST", "Asia/Calcutta", "+05:30", "utc", undefined])("rejects tz %j", (tz) => {
    expect(() => parseJobs(withSched({ tz }))).toThrow(JobsError);
  });
  it.each(["a/b", "..", "../x", "a\\b", "C:x", "", " a", "a.b"])("rejects name %j", (name) => {
    expect(() => parseJobs([rawJob({ name })])).toThrow(JobsError);
  });
  it("rejects duplicate names, accepts distinct ones", () => {
    expect(() => parseJobs([rawJob({ name: "a" }), rawJob({ name: "b" }), rawJob({ name: "a" })])).toThrow(/duplicate/);
    expect(parseJobs([rawJob({ name: "a" }), rawJob({ name: "A" })])).toHaveLength(2);
  });
  it.each([0, -1, "100", NaN])("rejects timeoutMs %j", (timeoutMs) => {
    expect(() => parseJobs([rawJob({ timeoutMs })])).toThrow(JobsError);
  });
  it.each(["claude", "codex", "gemini", "api"])("accepts backend %s", (backend) => {
    expect(parseJobs([rawJob({ backend })])[0].backend).toBe(backend);
  });
  it.each([null, 5, "x", [null], [[]]])("rejects junk %j", (raw) => {
    expect(() => parseJobs(raw)).toThrow(JobsError);
  });
  it("rejects non-string outputDir", () => {
    expect(() => parseJobs([rawJob({ outputDir: 5 })])).toThrow(JobsError);
  });
  it("empty array parses to []", () => expect(parseJobs([])).toEqual([]));
});

describe("nextRun edges", () => {
  it("now exactly at instant -> next occurrence, not now", () => {
    const s = sched({ days: ["Mon"] });
    const now = new Date("2026-01-12T03:15:00Z");
    expect(iso(nextRun(s, now))).toBe("2026-01-19T03:15:00.000Z");
    expect(iso(nextRun(s, new Date(now.getTime() - 1)))).toBe("2026-01-12T03:15:00.000Z");
  });
  it("08:45 IST Monday = 03:15 UTC Monday", () => {
    expect(iso(nextRun(sched({ days: ["Mon"] }), new Date("2026-01-11T12:00:00Z")))).toBe("2026-01-12T03:15:00.000Z");
  });
  it("00:30 IST Tue = Mon 19:00 UTC", () => {
    expect(iso(nextRun(sched({ days: ["Tue"], time: "00:30" }), new Date("2026-01-12T00:00:00Z")))).toBe("2026-01-12T19:00:00.000Z");
  });
  it("only day is today but time passed -> next week", () => {
    expect(iso(nextRun(sched({ days: ["Wed"] }), new Date("2026-01-07T10:00:00Z")))).toBe("2026-01-14T03:15:00.000Z");
  });
  it("is pure (does not mutate now)", () => {
    const now = new Date("2026-01-07T10:00:00Z");
    nextRun(sched(), now);
    expect(iso(now)).toBe("2026-01-07T10:00:00.000Z");
  });
});

function fakeClock(start: string) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; },
    sleep: async (ms: number) => { t += ms; },
  };
}

describe("runScheduler edges", () => {
  it("long-running job (2 days) -> no catch-up storm, next computed from new now", async () => {
    const c = fakeClock("2026-01-12T00:00:00Z"); // Mon
    const runs: string[] = [];
    await runScheduler([job()], {
      now: c.now, sleep: c.sleep,
      run: async () => { runs.push(iso(c.now())); if (runs.length === 1) c.advance(2 * 86400000); },
      stopped: () => runs.length >= 2,
    });
    expect(runs).toEqual(["2026-01-12T03:15:00.000Z", "2026-01-15T03:15:00.000Z"]);
  });
  it("continues after sync throw and after rejection", async () => {
    const c = fakeClock("2026-01-12T00:00:00Z");
    const runs: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScheduler([job()], {
      now: c.now, sleep: c.sleep,
      run: ((_j: Job) => {
        runs.push(iso(c.now()));
        if (runs.length === 1) throw new Error("sync boom");
        if (runs.length === 2) return Promise.reject(new Error("async boom"));
        return Promise.resolve();
      }) as (j: Job) => Promise<void>,
      stopped: () => runs.length >= 3,
    });
    expect(runs).toEqual(["2026-01-12T03:15:00.000Z", "2026-01-13T03:15:00.000Z", "2026-01-14T03:15:00.000Z"]);
    expect(err.mock.calls.map((a) => a.join(" ")).join("\n")).toMatch(/sync boom[\s\S]*async boom/);
    err.mockRestore();
  });
  it("two jobs due same minute run sequentially in deterministic (list) order", async () => {
    for (const order of [["a", "b"], ["b", "a"]]) {
      const c = fakeClock("2026-01-12T00:00:00Z");
      const log: string[] = [];
      let active = 0;
      let maxActive = 0;
      await runScheduler(order.map((name) => job({ name })), {
        now: c.now, sleep: c.sleep,
        run: async (j) => {
          active++; maxActive = Math.max(maxActive, active);
          log.push(j.name);
          await Promise.resolve(); c.advance(1000); active--;
        },
        stopped: () => log.length >= 2,
      });
      expect(maxActive).toBe(1);
      expect(log).toEqual(order);
    }
  });
  it("empty job list returns immediately", async () => {
    await expect(runScheduler([], { now: () => new Date(), sleep: async () => {}, run: async () => {} })).resolves.toBeUndefined();
  });
  it("unwritable outputDir -> scheduler continues, error logged", async () => {
    const d = tmp();
    const file = path.join(d, "afile");
    writeFileSync(file, "x");
    const c = fakeClock("2026-01-12T00:00:00Z");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    await runScheduler([job({ outputDir: file })], {
      now: c.now, sleep: c.sleep,
      run: async (j) => { calls++; await executeJob(j, { run: okRun, now: c.now, env: {} }); },
      stopped: () => calls >= 2,
    });
    expect(calls).toBe(2);
    expect(err.mock.calls.filter((a) => String(a[0]).includes("job j1 failed"))).toHaveLength(2);
    err.mockRestore();
  });
});

describe("executeJob edges", () => {
  it("output file date uses the job's tz date: 00:30 IST Tue -> Tue file", async () => {
    const d = tmp();
    const f = await executeJob(job({ outputDir: d, schedule: sched({ time: "00:30" }) }), {
      run: okRun, now: () => new Date("2026-01-12T19:00:00Z"), env: {},
    });
    expect(path.basename(f)).toBe("2026-01-13.md");
  });
  it("output file date for a UTC job at the same instant stays the UTC date", async () => {
    const d = tmp();
    const f = await executeJob(job({ outputDir: d, schedule: sched({ tz: "UTC", time: "19:00" }) }), {
      run: okRun, now: () => new Date("2026-01-12T19:00:00Z"), env: {},
    });
    expect(path.basename(f)).toBe("2026-01-12.md");
  });
  it("same-day suffixes -1, -2", async () => {
    const d = tmp();
    const deps = { run: okRun, now: () => new Date("2026-01-12T05:00:00Z"), env: {} };
    const files: string[] = [];
    for (let i = 0; i < 3; i++) files.push(path.basename(await executeJob(job({ outputDir: d }), deps)));
    expect(files).toEqual(["2026-01-12.md", "2026-01-12-1.md", "2026-01-12-2.md"]);
  });
  it("output path stays inside outputDir/<name>", async () => {
    const d = tmp();
    const f = await executeJob(job({ outputDir: d }), { run: okRun, env: {} });
    expect(path.relative(d, f).startsWith("..")).toBe(false);
    expect(path.dirname(f)).toBe(path.join(d, "j1"));
  });
  it("token redacted in prompt, result text and error", async () => {
    const d = tmp();
    const tok = "s3cr3t-TOKEN";
    const f = await executeJob(job({ outputDir: d, prompt: `use ${tok}` }), {
      run: async () => ({ ok: false, text: `got ${tok}`, error: `fail ${tok}`, exitCode: 1 }), env: { MCP_TOKEN: tok },
    });
    const body = readFileSync(f, "utf8");
    expect(body).not.toContain(tok);
    expect(body.match(/\[redacted\]/g)).toHaveLength(3);
    expect(body).toMatch(/status: error/);
  });
  it("token in rejected error redacted and recorded", async () => {
    const d = tmp();
    const f = await executeJob(job({ outputDir: d }), {
      run: async () => { throw new Error("bad tok-XYZ"); }, env: { MCP_TOKEN: "tok-XYZ" },
    });
    const body = readFileSync(f, "utf8");
    expect(body).toContain("- error: bad [redacted]");
    expect(body).not.toContain("tok-XYZ");
  });
  it("sync throw from run is recorded, not propagated", async () => {
    const d = tmp();
    const f = await executeJob(job({ outputDir: d }), { run: (() => { throw new Error("sync"); }) as any, env: {} });
    expect(readFileSync(f, "utf8")).toContain("- error: sync");
  });
  it("empty token env value does not redact anything", async () => {
    const d = tmp();
    const f = await executeJob(job({ outputDir: d }), { run: async () => ({ ok: true, text: "hello", exitCode: 0 }), env: { MCP_TOKEN: "" } });
    expect(readFileSync(f, "utf8")).toContain("hello");
  });
});

describe("jobs.example.json", () => {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "..", "jobs.example.json"), "utf8"));
  it("parses", () => expect(parseJobs(raw).length).toBeGreaterThan(0));
  it("every prompt forbids trade.*", () => {
    for (const j of raw) expect(j.prompt.toLowerCase()).toContain("do not call trade");
  });
  it("eod/premarket prompts have no backtest or order-placing verbs", () => {
    const targets = raw.filter((x: any) => /eod|pre-market|premarket/.test(x.name));
    expect(targets.length).toBe(2);
    for (const j of targets) {
      const p = j.prompt.replace(/never place, modify or cancel orders\.?/i, "").replace(/do not call trade\.\*;?/i, "");
      expect(p).not.toMatch(/backtest|trade\.|\bplace\b|\bbuy\b|\bsell\b|submit/i);
    }
  });
});
