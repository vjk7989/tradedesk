// TM2-36 independent edge tests: `--history [N]` lists recent runs from report headers and runs nothing.
// All tokens, keys and secrets below are fake.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const fx = vi.hoisted(() => ({
  reads: [] as { file: string; bytes: number }[],
  opens: [] as string[],
  spawn: vi.fn(),
  runScheduler: vi.fn(),
  runTask: vi.fn(),
}));

vi.mock("../src/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/scheduler.js")>()),
  runScheduler: (...a: unknown[]) => fx.runScheduler(...a),
}));
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => fx.runTask(...a),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  const spawn = (...a: unknown[]) => {
    fx.spawn(...a);
    throw new Error("unexpected spawn");
  };
  return { ...orig, spawn, default: { ...orig, spawn } };
});
// Read spy: records how many bytes each readFileSync returned, per path.
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((p: any, o?: any) => {
    const r = orig.readFileSync(p, o);
    fx.reads.push({ file: String(p), bytes: typeof r === "string" ? Buffer.byteLength(r) : r.length });
    return r;
  }) as typeof orig.readFileSync;
  const fds = new Map<number, string>();
  const openSync = ((p: any, ...rest: any[]) => {
    fx.opens.push(String(p));
    const fd = (orig.openSync as any)(p, ...rest);
    fds.set(fd, String(p));
    return fd;
  }) as typeof orig.openSync;
  const readSync = ((fd: number, ...rest: any[]) => {
    const got = (orig.readSync as any)(fd, ...rest);
    fx.reads.push({ file: fds.get(fd) ?? `fd:${fd}`, bytes: got });
    return got;
  }) as typeof orig.readSync;
  const t = { readFileSync, openSync, readSync };
  return { ...orig, ...t, default: { ...orig, ...t } };
});

import { main } from "../src/main.js";
import { collectHistory, formatHistory, parseReportHeader } from "../src/history.js";
import { executeJob, parseJobs, type Job } from "../src/jobs.js";

// ---- helpers ----
const tmp = () => mkdtempSync(path.join(tmpdir(), "tm236e-"));
const report = (job: string, iso: string, status = "ok", extra: string[] = [], body = "body text") =>
  [`# ${job} - ${iso}`, "", `- status: ${status}`, "- duration: 1234 ms", ...extra, "", "## Prompt", "", "p", "", "## Result", "", body, ""].join("\n");

type JS = { name: string; outputDir: string; tokenEnv?: string };
function writeJobs(dir: string, jobs: JS[]) {
  const file = path.join(dir, "jobs.json");
  writeFileSync(
    file,
    JSON.stringify(
      jobs.map((j) => ({
        name: j.name,
        schedule: { days: ["Mon"], time: "08:45", tz: "UTC" },
        backend: "api",
        prompt: "p",
        mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: j.tokenEnv ?? "TM236E_TOKEN" },
        outputDir: j.outputDir,
      })),
    ),
  );
  return file;
}
function put(outDir: string, job: string, file: string, content: string | Buffer) {
  mkdirSync(path.join(outDir, job), { recursive: true });
  writeFileSync(path.join(outDir, job, file), content);
}
/** A workspace with one job "alpha" and three reports. */
function fixture() {
  const d = tmp();
  const out = path.join(d, "runs");
  put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T03:15:00.000Z"));
  put(out, "alpha", "2026-11-02.md", report("alpha", "2026-11-02T03:15:00.000Z", "error", ["- error: refused"]));
  put(out, "alpha", "2026-11-03.md", report("alpha", "2026-11-03T03:15:00.000Z", "error", ["- error: timeout"]));
  return { d, out, jobs: writeJobs(d, [{ name: "alpha", outputDir: out }]) };
}

async function run(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("unexpected fetch");
  });
  const exit = vi.fn();
  const onSignal = vi.fn();
  let threw: unknown;
  try {
    await main(args, { exit, onSignal });
  } catch (e) {
    threw = e;
  }
  return { out: stdout, err: stderr.join("\n"), all: [...stdout, ...stderr].join("\n"), exit, onSignal, threw, fetchSpy };
}
type R = Awaited<ReturnType<typeof run>>;
const nothingRan = (r: R) => {
  expect(fx.runScheduler).not.toHaveBeenCalled();
  expect(fx.runTask).not.toHaveBeenCalled();
  expect(fx.spawn).not.toHaveBeenCalled();
  expect(r.fetchSpy).not.toHaveBeenCalled();
  expect(r.onSignal).not.toHaveBeenCalled();
};
const exitedWith = (r: R, code: number) => {
  expect(r.threw).toBeUndefined();
  expect(r.exit).toHaveBeenCalledTimes(1);
  expect(r.exit).toHaveBeenCalledWith(code);
};
const rowLines = (r: R) => r.out.filter((l) => l.includes("\t"));

beforeEach(() => {
  fx.reads.length = 0;
  fx.opens.length = 0;
  fx.runScheduler.mockReset();
  fx.runTask.mockReset();
  fx.spawn.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------- arg forms
describe("arg forms never reach the scheduler", () => {
  it.each([
    [["--history"], 3],
    [["--history", "2"], 2],
    [["--history=2"], 2],
    [["--history", "007"], 3],
    [["--history", "1"], 1],
    [["--history", "200"], 3],
  ])("%j is accepted and lists %i rows", async (flag, rows) => {
    const { jobs } = fixture();
    const r = await run(["--jobs", jobs, ...flag]);
    nothingRan(r);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(rows);
  });

  it("--history followed by another flag uses the default N and keeps the other flag's value", async () => {
    const { jobs } = fixture();
    const r = await run(["--history", "--jobs", jobs]);
    nothingRan(r);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(3);
  });

  it("default N is 20", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    for (let i = 1; i <= 25; i++) {
      const day = String(i).padStart(2, "0");
      put(out, "alpha", `2026-10-${day}.md`, report("alpha", `2026-10-${day}T00:00:00.000Z`));
    }
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(20);
    expect(rowLines(r)[0]).toContain("2026-10-25");
  });

  it.each([
    [["--history="]],
    [["--history=abc"]],
    [["--history5"]],
    [["--history", "-1"]],
    [["--history", "0"]],
    [["--history", "201"]],
    [["--history", "1e2"]],
    [["--history=0"]],
    [["--history=201"]],
    [["--history", "2.5"]],
    [["--history", " 5"]],
    [["--history", "0x10"]],
  ])("%j is rejected with exit 1 and prints no rows", async (flag) => {
    const { jobs } = fixture();
    const r = await run(["--jobs", jobs, ...flag]);
    nothingRan(r);
    exitedWith(r, 1);
    expect(rowLines(r)).toHaveLength(0);
    expect(r.err).not.toBe("");
  });

  it("201 gets the range message, like --next", async () => {
    const { jobs } = fixture();
    const r = await run(["--jobs", jobs, "--history", "201"]);
    expect(r.err).toContain("between 1 and 200");
  });
});

// ---------------------------------------------------------------- conflicts
describe("conflicts", () => {
  const combos: string[][] = [
    ["--once", "alpha"],
    ["--once=alpha"],
    ["--check"],
    ["--next"],
    ["--next", "3"],
    ["--next=3"],
    ["--dry-run", "alpha"],
    ["--dry-run=alpha"],
  ];
  for (const other of combos) {
    for (const hist of [["--history"], ["--history", "3"], ["--history=3"]]) {
      it(`${hist.join(" ")} + ${other.join(" ")} (both orders) is exit 1 and runs nothing`, async () => {
        const { jobs } = fixture();
        for (const args of [[...hist, ...other], [...other, ...hist]]) {
          const r = await run(["--jobs", jobs, ...args]);
          nothingRan(r);
          expect(fx.spawn).not.toHaveBeenCalled();
          exitedWith(r, 1);
          expect(rowLines(r)).toHaveLength(0);
          expect(r.err).toMatch(/cannot be combined/);
          vi.restoreAllMocks();
        }
      });
    }
  }
});

// ---------------------------------------------------------------- reports
describe("reports", () => {
  it("empty, truncated-header, binary garbage and directory-named-like-a-report are skipped and counted", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T00:00:00.000Z"));
    put(out, "alpha", "2026-11-02.md", "");
    put(out, "alpha", "2026-11-03.md", "# alpha - 2026-11-03T00:00:00.000Z\n");
    put(out, "alpha", "2026-11-04.md", "# alpha - 2026-11-04T00:00:00.000Z\n\n- stat");
    put(out, "alpha", "2026-11-05.md", Buffer.from([0x00, 0xff, 0xfe, 0x23, 0x20, 0x80, 0x0a, 0x0a, 0xc3, 0x28]));
    put(out, "alpha", "2026-11-06.md", "# alpha - not-a-date\n\n- status: ok\n");
    put(out, "alpha", "2026-11-07.md", "# alpha - 2026-13-45T99:99:99.000Z\n\n- status: ok\n");
    mkdirSync(path.join(out, "alpha", "2026-11-08.md"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    nothingRan(r);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(1);
    expect(r.out).toContain("skipped 7 unreadable");
  });

  it("a huge report is not read in full (read spy)", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const big = report("alpha", "2026-11-01T00:00:00.000Z", "ok", [], "x".repeat(32 * 1024 * 1024));
    put(out, "alpha", "2026-11-01.md", big);
    const t0 = Date.now();
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    const ms = Date.now() - t0;
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(1);
    const reportReads = fx.reads.filter((x) => x.file.endsWith(".md"));
    // Was a bug in round 0 (readFileSync of the whole report); fixed by the bounded 4 KiB head read.
    const maxBytes = reportReads.reduce((a, x) => a + x.bytes, 0);
    expect(maxBytes, `read ${maxBytes} bytes of a 32 MiB report in ${ms} ms`).toBeLessThan(1024 * 1024);
  });

  it("missing outputDir: no rows, 'no reports found', exit 0", async () => {
    const d = tmp();
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: path.join(d, "nope") }]), "--history"]);
    nothingRan(r);
    exitedWith(r, 0);
    expect(r.out).toEqual(["no reports found"]);
  });

  it("outputDir that is a file: no rows, exit 0, no throw", async () => {
    const d = tmp();
    const f = path.join(d, "runs");
    writeFileSync(f, "i am a file");
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: f }]), "--history"]);
    nothingRan(r);
    exitedWith(r, 0);
    expect(r.out).toEqual(["no reports found"]);
  });

  it("job dir that is a file: no rows, exit 0", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    mkdirSync(out);
    writeFileSync(path.join(out, "alpha"), "x");
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(r.out).toEqual(["no reports found"]);
  });

  it("a report symlink pointing outside outputDir is NOT followed, is counted, and its target is never opened", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const outside = path.join(tmp(), "elsewhere.md");
    writeFileSync(outside, report("alpha", "2026-11-09T00:00:00.000Z", "ok", [], "OUTSIDE_BODY_fake"));
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T00:00:00.000Z"));
    symlinkSync(outside, path.join(out, "alpha", "2026-11-09.md"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(1);
    expect(rowLines(r)[0].split("\t")[1]).toBe("2026-11-01");
    expect(r.out).toContain("skipped 1 unreadable");
    expect(r.all).not.toContain(outside);
    expect(r.all).not.toContain("OUTSIDE_BODY_fake");
    const target = realpathSync(outside);
    expect(fx.opens.filter((p) => p === outside || p === target || p.endsWith("2026-11-09.md"))).toEqual([]);
    expect(fx.reads.filter((x) => x.file === outside || x.file === target || x.file.endsWith("2026-11-09.md"))).toEqual([]);
  });

  it("a symlinked directory entry named like a report is skipped and counted", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    mkdirSync(path.join(out, "alpha"), { recursive: true });
    symlinkSync(tmp(), path.join(out, "alpha", "2026-11-09.md"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(r.out).toEqual(["no reports found", "skipped 1 unreadable"]);
  });

  const hasMkfifo = (() => {
    try {
      execFileSync("mkfifo", ["--version"], { stdio: "ignore" });
      return process.platform !== "win32";
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasMkfifo)("a FIFO named like a report is skipped and counted without hanging (skipped where mkfifo is unavailable)", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T00:00:00.000Z"));
    const fifo = path.join(out, "alpha", "2026-11-02.md");
    execFileSync("mkfifo", [fifo]);
    const t0 = Date.now();
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    expect(Date.now() - t0).toBeLessThan(2000);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(1);
    expect(r.out).toContain("skipped 1 unreadable");
    expect(fx.opens).not.toContain(fifo);
  }, 5000);

  // HEAD_BYTES is 4096 in history.ts. `pad` builds extra header lines so the header block ends at a chosen byte.
  const headerOf = (len: number, extra: string[] = []) => {
    const base = ["# alpha - 2026-11-01T00:00:00.000Z", "", "- status: ok", "- duration: 7 ms", ...extra].join("\n") + "\n";
    const fillLen = len - Buffer.byteLength(base) - 1; // "- x: " + filler + "\n"; then the blank line "\n" is NOT counted in len
    return base + "- x: " + "a".repeat(fillLen - 5) + "\n";
  };
  it("a header block longer than 4 KiB is skipped and counted", () => {
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", headerOf(6000) + "\n## Prompt\n\np\n");
    const job = { name: "alpha", outputDir: out } as Job;
    expect(collectHistory([job], 20)).toEqual({ rows: [], skipped: 1 });
  });
  it("a header block with no blank line at all, longer than 4 KiB, is skipped", () => {
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", headerOf(9000) + "- y: " + "b".repeat(9000));
    expect(collectHistory([{ name: "alpha", outputDir: out } as Job], 20)).toEqual({ rows: [], skipped: 1 });
  });
  it("boundary: header plus its blank line ending exactly at byte 4096 (file longer) is accepted", () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const h = headerOf(4095); // 4095 bytes + "\n" blank line = 4096
    expect(Buffer.byteLength(h + "\n")).toBe(4096);
    put(out, "alpha", "2026-11-01.md", h + "\n" + "## Prompt\n\n" + "p".repeat(10000));
    const { rows, skipped } = collectHistory([{ name: "alpha", outputDir: out } as Job], 20);
    expect(skipped).toBe(0);
    expect(rows.map((x) => `${x.status} ${x.durationMs}`)).toEqual(["ok 7"]);
  });
  it("boundary: a whole report of exactly 4096 bytes is accepted", () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const h = headerOf(4094) + "\n";
    const content = h + "z".repeat(4096 - Buffer.byteLength(h) - 1) + "\n";
    expect(Buffer.byteLength(content)).toBe(4096);
    put(out, "alpha", "2026-11-01.md", content);
    const { rows, skipped } = collectHistory([{ name: "alpha", outputDir: out } as Job], 20);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
  });
  it("boundary: blank line one byte past 4096 is skipped", () => {
    const d = tmp();
    const out = path.join(d, "runs");
    // header lines occupy 4096 bytes but the last line's newline is the 4097th byte; blank line after that.
    const h = headerOf(4097);
    put(out, "alpha", "2026-11-01.md", h + "\n## Prompt\n");
    expect(collectHistory([{ name: "alpha", outputDir: out } as Job], 20)).toEqual({ rows: [], skipped: 1 });
  });
  it("DOCUMENTED boundary: header whose last line's newline is byte 4096 and blank line is byte 4097 is accepted (trailing split '' reads as the blank line)", () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const h = headerOf(4096);
    expect(Buffer.byteLength(h)).toBe(4096);
    put(out, "alpha", "2026-11-01.md", h + "- error: refused\n\n## Prompt\n");
    const { rows, skipped } = collectHistory([{ name: "alpha", outputDir: out } as Job], 20);
    // Off by one: the cut drops the "- error: refused" line, so a refusal would show as "ok"/"failed" per its status.
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it("DOCUMENTED: a symlink to a file outside without a report header is just skipped", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const outside = path.join(tmp(), "passwd-like");
    writeFileSync(outside, "root:x:0:0:FAKE_SECRET_LINE\n");
    mkdirSync(path.join(out, "alpha"), { recursive: true });
    symlinkSync(outside, path.join(out, "alpha", "2026-11-09.md"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(r.all).not.toContain("FAKE_SECRET_LINE");
    expect(r.out).toContain("skipped 1 unreadable");
  });

  it("unexpected file names are ignored (not listed, not counted)", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const valid = report("alpha", "2026-11-01T00:00:00.000Z");
    put(out, "alpha", "2026-11-01.md", valid);
    for (const f of ["notes.md", "2026-11-01.md.bak", "2026-11-01.txt", "2026-1-1.md", "x2026-11-01.md", "2026-11-01-a.md", "2026-11-01-.md", ".2026-11-01.md", "2026-11-01.MD"]) {
      put(out, "alpha", f, valid);
    }
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(1);
    expect(rowLines(r)[0].split("\t")[1]).toBe("2026-11-01");
    expect(r.out.join("\n")).not.toContain("skipped");
  });

  it("same-day -n ordering is numeric: -10 before -9 before -2 before the plain file", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const iso = "2026-11-05T03:15:00.000Z"; // identical header times force the -n tiebreak
    for (const s of ["", "-1", "-2", "-9", "-10", "-11"]) put(out, "alpha", `2026-11-05${s}.md`, report("alpha", iso));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    expect(rowLines(r).map((l) => l.split("\t")[1])).toEqual([
      "2026-11-05-11", "2026-11-05-10", "2026-11-05-9", "2026-11-05-2", "2026-11-05-1", "2026-11-05",
    ]);
  });

  it("same-day -n with increasing header times stays newest first", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-05.md", report("alpha", "2026-11-05T01:00:00.000Z"));
    put(out, "alpha", "2026-11-05-2.md", report("alpha", "2026-11-05T03:00:00.000Z"));
    put(out, "alpha", "2026-11-05-10.md", report("alpha", "2026-11-05T11:00:00.000Z"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    expect(rowLines(r).map((l) => l.split("\t")[1])).toEqual(["2026-11-05-10", "2026-11-05-2", "2026-11-05"]);
  });

  it("cross-job ordering is by header timestamp, interleaved, newest first, and N cuts across jobs", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T05:00:00.000Z"));
    put(out, "beta", "2026-11-01.md", report("beta", "2026-11-01T06:00:00.000Z"));
    put(out, "alpha", "2026-11-02.md", report("alpha", "2026-11-02T01:00:00.000Z"));
    put(out, "beta", "2026-10-31.md", report("beta", "2026-10-31T23:00:00.000Z"));
    const jobs = writeJobs(d, [{ name: "alpha", outputDir: out }, { name: "beta", outputDir: out }]);
    const r = await run(["--jobs", jobs, "--history"]);
    expect(rowLines(r).map((l) => l.split("\t").slice(0, 2).join(" "))).toEqual([
      "alpha 2026-11-02", "beta 2026-11-01", "alpha 2026-11-01", "beta 2026-10-31",
    ]);
    const r2 = await run(["--jobs", jobs, "--history", "2"]);
    expect(rowLines(r2).map((l) => l.split("\t")[0])).toEqual(["alpha", "beta"]);
  });

  it("identical timestamps across jobs give a stable, deterministic order", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const iso = "2026-11-01T05:00:00.000Z";
    put(out, "beta", "2026-11-01.md", report("beta", iso));
    put(out, "alpha", "2026-11-01.md", report("alpha", iso));
    const a = await run(["--jobs", writeJobs(d, [{ name: "beta", outputDir: out }, { name: "alpha", outputDir: out }]), "--history"]);
    const b = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }, { name: "beta", outputDir: out }]), "--history"]);
    expect(rowLines(a)).toHaveLength(2);
    expect(rowLines(a)).toEqual(rowLines(b));
  });
});

// ---------------------------------------------------------------- secrecy
describe("secrecy", () => {
  it("report bodies, prompts, error text and fake tokens never appear", async () => {
    const d = tmp();
    const out = path.join(d, "runs");
    const tok = "fake-tok-ABCDEF0123456789";
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T00:00:00.000Z", "error", [`- error: upstream said ${tok} EXPLODED_ERR_TEXT`], `Result has ${tok} and BODY_MARKER_fake`));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(1);
    for (const s of [tok, "EXPLODED_ERR_TEXT", "BODY_MARKER_fake", "upstream said"]) expect(r.all).not.toContain(s);
  });

  it("a fake secret inside header fields (status/duration/title) is never printed", async () => {
    // main.ts has a redactor (TM2-30) but --history does not use it; it prints only job/stem/status/duration/path,
    // and status/duration are regex-limited, so header values cannot carry a secret through.
    const secret = "sk-fake-HEADER-9f8e7d6c";
    vi.stubEnv("ANTHROPIC_API_KEY", secret);
    vi.stubEnv("TM236E_TOKEN", "fake-mcp-token-777");
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", [`# ${secret} - 2026-11-01T00:00:00.000Z`, "", `- status: ok ${secret}`, `- status: ok`, `- duration: ${secret} ms`, "- duration: fake-mcp-token-777", ""].join("\n"));
    put(out, "alpha", "2026-11-02.md", [`# alpha - 2026-11-02T00:00:00.000Z`, "", `- status: ${secret}`, ""].join("\n"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(r.all).not.toContain(secret);
    expect(r.all).not.toContain("fake-mcp-token-777");
    expect(rowLines(r)).toHaveLength(1);
    expect(rowLines(r)[0].split("\t").slice(2, 4)).toEqual(["ok", "-"]);
    expect(r.out).toContain("skipped 1 unreadable");
  });

  it("a job name equal to a set secret value is not printed verbatim", async () => {
    // BUG (TM2-36): --history prints job names (and paths containing them) unredacted, whereas --dry-run's
    // "no such job" path runs job names through redactor(). A name matching [A-Za-z0-9_-]+ can equal a key.
    const secret = "sk-fake-JOBNAME-abc123";
    vi.stubEnv("ANTHROPIC_API_KEY", secret);
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, secret, "2026-11-01.md", report(secret, "2026-11-01T00:00:00.000Z"));
    const r = await run(["--jobs", writeJobs(d, [{ name: secret, outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(r.out.length).toBeGreaterThan(0);
    expect(r.all).not.toContain(secret);
  });
});

describe("redaction of name and path columns", () => {
  it("a secret inside outputDir is redacted in the path column, other columns intact", async () => {
    const secret = "fake-mcp-PATHSECRET-42";
    vi.stubEnv("TM236E_TOKEN", secret);
    const d = tmp();
    const out = path.join(d, `runs-${secret}`);
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T00:00:00.000Z"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(r.all).not.toContain(secret);
    const c = rowLines(r)[0].split("\t");
    expect(c.slice(0, 4)).toEqual(["alpha", "2026-11-01", "ok", "1234 ms"]);
    expect(c[4]).toContain("[redacted]");
  });

  it("job name equal to a secret: both the name and path columns are redacted", async () => {
    const secret = "sk-fake-JOBNAME-xyz789";
    vi.stubEnv("OPENAI_API_KEY", secret);
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, secret, "2026-11-01.md", report(secret, "2026-11-01T00:00:00.000Z"));
    const r = await run(["--jobs", writeJobs(d, [{ name: secret, outputDir: out }]), "--history"]);
    const c = rowLines(r)[0].split("\t");
    expect(c[0]).toBe("[redacted]");
    expect(c[4]).toBe(path.join(out, "[redacted]", "2026-11-01.md"));
  });

  it("short secret (< 4 chars) set: name and path columns are withheld, stem/status/duration kept", async () => {
    vi.stubEnv("GEMINI_API_KEY", "ab");
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T00:00:00.000Z"));
    put(out, "alpha", "2026-11-02.md", "");
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    const c = rowLines(r)[0].split("\t");
    expect(c).toHaveLength(5);
    expect(c[0]).toMatch(/^\[withheld/);
    expect(c[4]).toMatch(/^\[withheld/);
    expect(c.slice(1, 4)).toEqual(["2026-11-01", "ok", "1234 ms"]);
    expect(r.all).not.toContain(out);
    expect(r.out[r.out.length - 1]).toBe("skipped 1 unreadable");
  });

  it("a short secret in a job mcp tokenEnv also triggers withholding", async () => {
    vi.stubEnv("TM236E_TOKEN", "q1");
    const d = tmp();
    const out = path.join(d, "runs");
    put(out, "alpha", "2026-11-01.md", report("alpha", "2026-11-01T00:00:00.000Z"));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    expect(rowLines(r)[0].split("\t")[0]).toMatch(/^\[withheld/);
  });
});

// ---------------------------------------------------------------- status mapping
describe("status mapping", () => {
  it("ok / refused / failed are mapped; an unknown status is skipped and counted", async () => {
    const { d, out } = fixture();
    put(out, "alpha", "2026-11-04.md", report("alpha", "2026-11-04T03:15:00.000Z", "skipped"));
    put(out, "alpha", "2026-11-05.md", report("alpha", "2026-11-05T03:15:00.000Z", "OK"));
    put(out, "alpha", "2026-11-06.md", report("alpha", "2026-11-06T03:15:00.000Z", "error", ["- error: refused by policy"]));
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    exitedWith(r, 0);
    expect(rowLines(r).map((l) => l.split("\t").slice(1, 3).join(" "))).toEqual([
      "2026-11-06 failed", "2026-11-03 failed", "2026-11-02 refused", "2026-11-01 ok",
    ]);
    expect(r.out[r.out.length - 1]).toBe("skipped 2 unreadable");
  });

  it("status from the real writer: refused round-trips through executeJob", async () => {
    const d = tmp();
    const [job] = parseJobs(JSON.parse(JSON.stringify([{ name: "alpha", schedule: { days: ["Mon"], time: "08:45", tz: "UTC" }, backend: "api", prompt: "p", mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "TM236E_TOKEN" }, outputDir: path.join(d, "runs") }])));
    let t = Date.parse("2026-11-01T00:00:00.000Z");
    const now = () => new Date((t += 1000));
    await executeJob(job, { run: async () => ({ ok: true, text: "fine", exitCode: 0 }), now, env: {} });
    await executeJob(job, { run: async () => ({ ok: false, text: "", error: "refused", exitCode: null }), now, env: {} });
    await executeJob(job, { run: async () => ({ ok: false, text: "", error: "timeout", exitCode: null }), now, env: {} });
    const { rows, skipped } = collectHistory([job], 20);
    expect(skipped).toBe(0);
    expect(rows.map((x) => `${x.stem} ${x.status} ${x.durationMs}`)).toEqual([
      "2026-11-01-2 failed 1000", "2026-11-01-1 refused 1000", "2026-11-01 ok 1000",
    ]);
  });

  it("a failed run whose multi-line error (CLI stderr tail) contains '- status: ok' is still reported as failed", async () => {
    // BUG (TM2-36): cli.ts writes up to 20 non-empty stderr lines as `- error: ...`. parseReportHeader keeps
    // scanning until the first blank line and lets a later `- status:` / `- duration:` line override the real one.
    const d = tmp();
    const [job] = parseJobs([{ name: "alpha", schedule: { days: ["Mon"], time: "08:45", tz: "UTC" }, backend: "claude", prompt: "p", mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "TM236E_TOKEN" }, outputDir: path.join(d, "runs") }]);
    let t = Date.parse("2026-11-01T00:00:00.000Z");
    const now = () => new Date((t += 5000));
    await executeJob(job, {
      run: async () => ({ ok: false, text: "", error: "tool crashed\n- status: ok\n- duration: 1 ms", exitCode: 2 }),
      now,
      env: {},
    });
    const { rows } = collectHistory([job], 20);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].durationMs).toBe(5000);
  });

  it.each([
    ["one spoofed status", ["- error: boom", "- status: ok"], "failed", 1234],
    ["status and duration", ["- error: boom", "- duration: 1 ms", "- status: ok"], "failed", 1234],
    ["several of each", ["- error: x", "- status: ok", "- status: ok", "- duration: 1 ms", "- duration: 2 ms", "- status: error", "- error: refused"], "failed", 1234],
    ["refused then spoof", ["- error: refused", "- status: ok", "- duration: 9 ms"], "refused", 1234],
  ])("lines after '- error:' are ignored: %s", (_n, extra, status, dur) => {
    const h = parseReportHeader(report("alpha", "2026-11-01T00:00:00.000Z", "error", extra as string[]));
    expect(h).toMatchObject({ status, durationMs: dur });
  });

  it("an ok status line after '- error:' does not rescue a header with no status before it", () => {
    const text = ["# alpha - 2026-11-01T00:00:00.000Z", "", "- error: boom", "- status: ok", ""].join("\n");
    expect(parseReportHeader(text)).toBeNull();
  });

  it("a first status wins over a later duplicate before any error line", () => {
    const text = ["# alpha - 2026-11-01T00:00:00.000Z", "", "- status: error", "- status: ok", "- duration: 3 ms", "- duration: 1 ms", ""].join("\n");
    expect(parseReportHeader(text)).toMatchObject({ status: "failed", durationMs: 3 });
  });

  it("parseReportHeader ignores status lines in the body (after the first blank line)", () => {
    const text = ["# alpha - 2026-11-01T00:00:00.000Z", "", "- status: error", "", "- status: ok"].join("\n");
    expect(parseReportHeader(text)?.status).toBe("failed");
  });

  it("CRLF reports parse", () => {
    const text = report("alpha", "2026-11-01T00:00:00.000Z").replace(/\n/g, "\r\n");
    expect(parseReportHeader(text)).toMatchObject({ status: "ok", durationMs: 1234 });
  });
});

// ---------------------------------------------------------------- exit codes & output format
describe("exit codes and output format", () => {
  it("tab-separated: job, date[-n], status, duration, path; one line per run; skipped line last", async () => {
    const { d, out } = fixture();
    put(out, "alpha", "2026-11-03-1.md", [`# alpha - 2026-11-03T09:00:00.000Z`, "", "- status: ok", ""].join("\n"));
    put(out, "alpha", "2026-11-04.md", "garbage");
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }]), "--history"]);
    nothingRan(r);
    exitedWith(r, 0);
    expect(r.out).toHaveLength(5);
    const rows = r.out.slice(0, 4).map((l) => l.split("\t"));
    for (const c of rows) expect(c).toHaveLength(5);
    expect(rows[0]).toEqual(["alpha", "2026-11-03-1", "ok", "-", path.join(out, "alpha", "2026-11-03-1.md")]);
    expect(rows[1]).toEqual(["alpha", "2026-11-03", "failed", "1234 ms", path.join(out, "alpha", "2026-11-03.md")]);
    expect(r.out[4]).toBe("skipped 1 unreadable");
    expect(r.err).toBe("");
  });

  it("skipped count is reported even when N hides rows, and counts all jobs", async () => {
    const { d, out } = fixture();
    put(out, "beta", "2026-11-01.md", "");
    const r = await run(["--jobs", writeJobs(d, [{ name: "alpha", outputDir: out }, { name: "beta", outputDir: out }]), "--history", "1"]);
    exitedWith(r, 0);
    expect(rowLines(r)).toHaveLength(1);
    expect(r.out[r.out.length - 1]).toBe("skipped 1 unreadable");
  });

  it("only-unreadable reports: 'no reports found' then the skipped line", () => {
    expect(formatHistory([], 3)).toEqual(["no reports found", "skipped 3 unreadable"]);
  });

  it("missing or invalid jobs file is exit 1 and runs nothing", async () => {
    const d = tmp();
    const r1 = await run(["--jobs", path.join(d, "absent.json"), "--history"]);
    nothingRan(r1);
    exitedWith(r1, 1);
    vi.restoreAllMocks();
    const bad = path.join(d, "bad.json");
    writeFileSync(bad, "{not json");
    const r2 = await run(["--jobs", bad, "--history"]);
    exitedWith(r2, 1);
  });

  it("duplicate outputDir/name dirs are read once", () => {
    const { out } = fixture();
    const job = { name: "alpha", outputDir: out } as Job;
    const { rows } = collectHistory([job, { ...job, outputDir: out + "/" }, job], 50);
    // `out` and `out/` join to the same dir.
    expect(rows).toHaveLength(3);
  });
});
