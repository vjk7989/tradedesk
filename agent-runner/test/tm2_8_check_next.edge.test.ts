import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

type J = { name: string; backend?: string; tz?: string; days?: string[]; time?: string; tokenEnv?: string };
const tmpDir = () => mkdtempSync(path.join(tmpdir(), "tm28e-"));
const writeRaw = (content: string) => {
  const file = path.join(tmpDir(), "jobs.json");
  writeFileSync(file, content);
  return file;
};
const writeJobs = (jobs: J[]) =>
  writeRaw(JSON.stringify(jobs.map((j) => ({
    name: j.name,
    schedule: { days: j.days ?? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], time: j.time ?? "08:45", tz: j.tz ?? "Asia/Kolkata" },
    backend: j.backend ?? "claude", prompt: "p",
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: j.tokenEnv ?? "TM28E_TOKEN" },
    outputDir: "./runs-tm28e",
  }))));

/** Captures console.log/error and raw stdout/stderr writes separately. */
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
  return { out: stdout.join("\n"), err: stderr.join("\n"), all: [...stdout, ...stderr].join("\n"), exit, onSignal, threw };
}
const lines = (out: string) => out.split("\n").filter((l) => l.startsWith("  "));
const ALL_ENV = ["TM28E_TOKEN", "TM28E_T2", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  runTask.mockReset();
  executeJob.mockReset();
  spawned.mockReset();
});

const nothingRan = (r: Awaited<ReturnType<typeof run>>) => {
  expect(runTask).not.toHaveBeenCalled();
  expect(executeJob).not.toHaveBeenCalled();
  expect(spawned).not.toHaveBeenCalled();
  expect(r.onSignal).not.toHaveBeenCalled();
  expect(r.all).not.toContain("scheduler started");
};

describe("TM2-8 edge: --check never prints secret values", () => {
  const tricky = [
    "plain-SECRET-abc123",
    "re.*+?^${}()|[]\\SECRET",
    '{"a":"SECRET","b":[1,2]}\\u0000',
    "line1-SECRET\nline2-SECRET\r\nline3",
    "  padded-SECRET  ",
    "tab\tSECRET\tval",
    "üñí©ødé-SECRET-✓",
  ];
  it.each(tricky)("value %j is absent from stdout and stderr (all set -> exit 0)", async (v) => {
    for (const n of ALL_ENV) vi.stubEnv(n, v);
    const file = writeJobs([
      { name: "a", backend: "api" }, { name: "b", backend: "api-openai", tokenEnv: "TM28E_T2" }, { name: "c", backend: "claude" },
    ]);
    const r = await run(["--jobs", file, "--check"]);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(0);
    for (const hay of [r.out, r.err]) {
      expect(hay).not.toContain(v);
      expect(hay).not.toContain(v.trim());
      expect(hay).not.toContain("SECRET");
      for (const piece of v.split(/[\r\n]+/).filter((p) => p.trim().length > 3)) expect(hay).not.toContain(piece.trim());
      expect(hay).not.toContain(JSON.stringify(v));
    }
    nothingRan(r);
  });

  it("values are not printed on the failure path either (some missing -> exit 1)", async () => {
    vi.stubEnv("TM28E_TOKEN", "tok-SECRET-\n$1");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.all).not.toContain("SECRET");
    expect(r.out).toContain("TM28E_TOKEN: set");
    expect(r.out).toContain("ANTHROPIC_API_KEY: missing");
  });
});

describe("TM2-8 edge: --check backend key mapping", () => {
  it.each([
    ["api", "ANTHROPIC_API_KEY"],
    ["api-openai", "OPENAI_API_KEY"],
  ])("%s -> %s (set -> 0, missing -> 1)", async (backend, keyEnv) => {
    vi.stubEnv("TM28E_TOKEN", "x");
    for (const n of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) vi.stubEnv(n, n === keyEnv ? "k" : "");
    let r = await run(["--jobs", writeJobs([{ name: "a", backend }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    const row = r.out.split("\n").find((l) => l.startsWith("a\t"))!;
    expect(row).toBe(`a\t${backend}\tTM28E_TOKEN: set\t${keyEnv}: set`);
    for (const other of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"].filter((n) => n !== keyEnv)) {
      expect(row).not.toContain(other);
    }
    vi.stubEnv(keyEnv, "");
    r = await run(["--jobs", writeJobs([{ name: "a", backend }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain(`${keyEnv}: missing`);
  });

  it.each(["claude", "codex", "gemini"])("CLI backend %s needs no key: all API keys unset still exits 0, column is -", async (backend) => {
    vi.stubEnv("TM28E_TOKEN", "x");
    for (const n of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) vi.stubEnv(n, "");
    const r = await run(["--jobs", writeJobs([{ name: "a", backend }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(r.out.split("\n").find((l) => l.startsWith("a\t"))).toBe(`a\t${backend}\tTM28E_TOKEN: set\t-`);
  });

  it("api-gemini: rejected by parseJobs on this base (dormant), else maps to GEMINI_API_KEY", async () => {
    vi.stubEnv("TM28E_TOKEN", "x");
    vi.stubEnv("GEMINI_API_KEY", "");
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api-gemini" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    if (r.err.includes("backend must")) expect(r.out).not.toContain("GEMINI_API_KEY");
    else expect(r.out).toContain("GEMINI_API_KEY: missing");
  });

  it("header row printed once, one row per job, in file order", async () => {
    vi.stubEnv("TM28E_TOKEN", "x");
    const r = await run(["--jobs", writeJobs([{ name: "z" }, { name: "a" }, { name: "m" }]), "--check"]);
    const rows = r.out.split("\n");
    expect(rows[0]).toBe("job\tbackend\tmcp token env\tapi key env");
    expect(rows.slice(1).map((l) => l.split("\t")[0])).toEqual(["z", "a", "m"]);
  });
});

describe("TM2-8 edge: --check set/missing", () => {
  it("mix of set and missing across jobs -> exit 1 exactly once, each row correct", async () => {
    vi.stubEnv("TM28E_TOKEN", "x");
    vi.stubEnv("TM28E_T2", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    const r = await run(["--jobs", writeJobs([{ name: "ok", backend: "api" }, { name: "bad", tokenEnv: "TM28E_T2" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("ok\tapi\tTM28E_TOKEN: set\tANTHROPIC_API_KEY: set");
    expect(r.out).toContain("bad\tclaude\tTM28E_T2: missing\t-");
  });

  it("missing job listed first still prints every row (no early exit)", async () => {
    vi.stubEnv("TM28E_T2", "");
    vi.stubEnv("TM28E_TOKEN", "x");
    const r = await run(["--jobs", writeJobs([{ name: "bad", tokenEnv: "TM28E_T2" }, { name: "ok" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("ok\tclaude\tTM28E_TOKEN: set");
  });

  it("empty-string env is missing; undefined env is missing; single char is set", async () => {
    vi.stubEnv("TM28E_TOKEN", "");
    let r = await run(["--jobs", writeJobs([{ name: "a" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("TM28E_TOKEN: missing");
    vi.stubEnv("TM28E_TOKEN", undefined as unknown as string);
    delete process.env.TM28E_TOKEN;
    r = await run(["--jobs", writeJobs([{ name: "a" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    vi.stubEnv("TM28E_TOKEN", "0");
    r = await run(["--jobs", writeJobs([{ name: "a" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(0);
  });

  it("empty jobs array: header only, exit 0", async () => {
    const r = await run(["--jobs", writeRaw("[]"), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(r.out.split("\n")).toHaveLength(1);
  });
});

describe("TM2-8 edge: bad jobs file -> exit 1 + parse message", () => {
  const cases: [string, () => string, RegExp][] = [
    ["missing file", () => path.join(tmpDir(), "nope.json"), /ENOENT|no such file/],
    ["empty file", () => writeRaw(""), /JSON|Unexpected end/i],
    ["not JSON", () => writeRaw("{jobs: oops"), /JSON|Unexpected|Expected/i],
    ["JSON null", () => writeRaw("null"), /jobs must be an array/],
    ["schema: bad tz (America/New_York)", () => writeJobs([{ name: "a", tz: "America/New_York" }]), /schedule\.tz must be/],
    ["schema: bad time 24:00", () => writeJobs([{ name: "a", time: "24:00" }]), /schedule\.time must be HH:MM/],
    ["schema: no days", () => writeJobs([{ name: "a", days: [] }]), /schedule\.days/],
    ["schema: bad backend", () => writeJobs([{ name: "a", backend: "gpt" }]), /backend must be/],
    ["schema: duplicate name", () => writeJobs([{ name: "a" }, { name: "a" }]), /jobs\[1\]: duplicate name/],
  ];
  for (const flag of [["--check"], ["--next"], ["--next", "2"]]) {
    it.each(cases)(`${flag.join(" ")}: %s`, async (_n, mk, msg) => {
      vi.stubEnv("TM28E_TOKEN", "x");
      const r = await run(["--jobs", mk(), ...flag]);
      expect(r.threw).toBeUndefined();
      expect(r.exit).toHaveBeenCalledTimes(1);
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(r.err).toMatch(msg);
      expect(lines(r.out)).toHaveLength(0);
      nothingRan(r);
    });
  }
  it("Windows-style path with backslashes to a missing file -> exit 1, not a throw", async () => {
    const r = await run(["--jobs", "C:\\definitely\\not\\here\\jobs.json", "--check"]);
    expect(r.threw).toBeUndefined();
    expect(r.exit).toHaveBeenCalledWith(1);
  });
});

describe("TM2-8 edge: --next N parsing", () => {
  it("default is 5 per job (2 jobs -> 10 lines)", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }, { name: "b" }]), "--next"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(lines(r.out)).toHaveLength(10);
  });
  it("trailing --next with no value -> default 5", async () => {
    const file = writeJobs([{ name: "a" }]);
    const r = await run(["--jobs", file, "--next"]);
    expect(lines(r.out)).toHaveLength(5);
  });
  it.each(["0", "-1", "-0", "abc", "1.5", "", " 3", "+3", "0x10", "NaN", "3abc"])(
    "N=%j -> clear error, exit 1, nothing printed",
    async (n) => {
      const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--next", n]);
      expect(r.exit).toHaveBeenCalledTimes(1);
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(r.err).toContain("--next N must be a positive integer");
      expect(lines(r.out)).toHaveLength(0);
      nothingRan(r);
    },
  );
  // TM2-12: "1e3" and "Infinity" are above the 1..100 bound and now get the bound message.
  it.each(["1e3", "Infinity"])(
    "N=%j -> bound error (1..100), exit 1, nothing printed",
    async (n) => {
      const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--next", n]);
      expect(r.exit).toHaveBeenCalledTimes(1);
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(r.err).toContain("--next N must be between 1 and 100");
      expect(lines(r.out)).toHaveLength(0);
      nothingRan(r);
    },
  );
  it("N=1 (lower bound) prints exactly 1 line per job", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--next", "1"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(lines(r.out)).toHaveLength(1);
  });
  it("leading zeros '007' -> 7", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--next", "007"]);
    expect(lines(r.out)).toHaveLength(7);
  });
  it("large N (1000): rejected by the TM2-12 upper bound -> bound error, exit 1, nothing printed", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--next", "1000"]);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.err).toBe("--next N must be between 1 and 100");
    expect(lines(r.out)).toHaveLength(0);
    nothingRan(r);
  });
});

describe("TM2-8 edge: --next times (fake clock)", () => {
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  it("weekend roll: Mon-Fri 08:45 IST from Fri 09:30 IST -> Mon..Fri next week, no Sat/Sun", async () => {
    at("2026-11-27T04:00:00Z");
    const r = await run(["--jobs", writeJobs([{ name: "a", days: WEEKDAYS }]), "--next", "5"]);
    expect(lines(r.out)).toEqual([
      "  2026-11-30 08:45 Asia/Kolkata  2026-11-30T03:15:00.000Z",
      "  2026-12-01 08:45 Asia/Kolkata  2026-12-01T03:15:00.000Z",
      "  2026-12-02 08:45 Asia/Kolkata  2026-12-02T03:15:00.000Z",
      "  2026-12-03 08:45 Asia/Kolkata  2026-12-03T03:15:00.000Z",
      "  2026-12-04 08:45 Asia/Kolkata  2026-12-04T03:15:00.000Z",
    ]);
  });

  it("weekend roll from Sat and from Sun both land on Monday", async () => {
    for (const iso of ["2026-11-28T06:00:00Z", "2026-11-29T17:00:00Z"]) {
      at(iso);
      const r = await run(["--jobs", writeJobs([{ name: "a", days: WEEKDAYS }]), "--next", "1"]);
      expect(lines(r.out)[0]).toBe("  2026-11-30 08:45 Asia/Kolkata  2026-11-30T03:15:00.000Z");
      vi.useRealTimers();
    }
  });

  it("exactly at the scheduled instant -> next occurrence (strictly after)", async () => {
    at("2026-11-27T03:15:00.000Z"); // Fri 08:45:00 IST
    const r = await run(["--jobs", writeJobs([{ name: "a", days: WEEKDAYS }]), "--next", "1"]);
    expect(lines(r.out)[0]).toBe("  2026-11-30 08:45 Asia/Kolkata  2026-11-30T03:15:00.000Z");
  });

  it("1 ms before the scheduled instant -> that same instant", async () => {
    at("2026-11-27T03:14:59.999Z");
    const r = await run(["--jobs", writeJobs([{ name: "a", days: WEEKDAYS }]), "--next", "1"]);
    expect(lines(r.out)[0]).toBe("  2026-11-27 08:45 Asia/Kolkata  2026-11-27T03:15:00.000Z");
  });

  it("IST midnight: 00:00 IST job asked at Fri 23:59:59 IST -> Sat 00:00 IST = Fri 18:30Z (IST date differs from UTC date)", async () => {
    at("2026-11-27T18:29:59Z");
    const r = await run(["--jobs", writeJobs([{ name: "a", time: "00:00" }]), "--next", "2"]);
    expect(lines(r.out)).toEqual([
      "  2026-11-28 00:00 Asia/Kolkata  2026-11-27T18:30:00.000Z",
      "  2026-11-29 00:00 Asia/Kolkata  2026-11-28T18:30:00.000Z",
    ]);
  });

  it("IST midnight + weekend: Mon-Fri 00:00 IST asked Fri 00:01 IST -> Mon 00:00 IST = Sun 18:30Z", async () => {
    at("2026-11-26T18:31:00Z"); // Fri 00:01 IST
    const r = await run(["--jobs", writeJobs([{ name: "a", time: "00:00", days: WEEKDAYS }]), "--next", "1"]);
    expect(lines(r.out)[0]).toBe("  2026-11-30 00:00 Asia/Kolkata  2026-11-29T18:30:00.000Z");
  });

  it("IST 23:59 job: IST and UTC dates agree, offset is exactly 5:30", async () => {
    at("2026-11-27T00:00:00Z");
    const r = await run(["--jobs", writeJobs([{ name: "a", time: "23:59" }]), "--next", "1"]);
    expect(lines(r.out)[0]).toBe("  2026-11-27 23:59 Asia/Kolkata  2026-11-27T18:29:00.000Z");
  });

  it("DST-free: IST 08:45 maps to 03:15Z on both sides of the US and EU DST changes", async () => {
    at("2026-03-06T00:00:00Z"); // US DST starts 2026-03-08, EU 2026-03-29
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--next", "30"]);
    for (const l of lines(r.out)) expect(l).toMatch(/08:45 Asia\/Kolkata  \d{4}-\d\d-\d\dT03:15:00\.000Z$/);
  });

  it("non-IST job (UTC) across the US DST change keeps 09:00Z with no shift", async () => {
    at("2026-03-07T10:00:00Z");
    const r = await run(["--jobs", writeJobs([{ name: "a", tz: "UTC", time: "09:00" }]), "--next", "3"]);
    expect(lines(r.out)).toEqual([
      "  2026-03-08 09:00 UTC  2026-03-08T09:00:00.000Z",
      "  2026-03-09 09:00 UTC  2026-03-09T09:00:00.000Z",
      "  2026-03-10 09:00 UTC  2026-03-10T09:00:00.000Z",
    ]);
  });

  it("America/New_York job tz is not supported: --next rejects with the tz parse message", async () => {
    at("2026-03-07T10:00:00Z");
    const r = await run(["--jobs", writeJobs([{ name: "a", tz: "America/New_York" }]), "--next", "3"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.err).toContain('schedule.tz must be "Asia/Kolkata" or "UTC"');
  });

  it("mixed tz jobs each print in their own tz, job name header precedes its lines", async () => {
    at("2026-11-27T04:00:00Z");
    const r = await run(["--jobs", writeJobs([{ name: "ist" }, { name: "utc", tz: "UTC", time: "08:45" }]), "--next", "1"]);
    expect(r.out.split("\n")).toEqual([
      "ist", "  2026-11-28 08:45 Asia/Kolkata  2026-11-28T03:15:00.000Z",
      "utc", "  2026-11-27 08:45 UTC  2026-11-27T08:45:00.000Z",
    ]);
  });
});

describe("TM2-8 edge: side effects and flag interplay", () => {
  it("--next and --check run nothing and create no output dir", async () => {
    vi.stubEnv("TM28E_TOKEN", "x");
    const file = writeJobs([{ name: "a" }]);
    const cwd = process.cwd();
    for (const f of [["--check"], ["--next"], ["--next", "3"]]) {
      const r = await run(["--jobs", file, ...f]);
      nothingRan(r);
    }
    expect(existsSync(path.join(cwd, "runs-tm28e"))).toBe(false);
  });

  it.each([
    [["--check", "--next"]],
    [["--next", "--check"]],
    [["--next", "3", "--check"]],
    [["--check", "--next", "0"]],
  ])("%j together -> rejected, exit 1 before reading the file", async (flags) => {
    const r = await run(["--jobs", path.join(tmpDir(), "missing.json"), ...flags]);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.err).toContain("--check and --next cannot be combined");
    expect(r.err).not.toMatch(/ENOENT/);
    nothingRan(r);
  });

  it("--next with --once: --next wins, the job is not run", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--once", "a", "--next", "1"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(lines(r.out)).toHaveLength(1);
    nothingRan(r);
  });

  it("--jobs defaults to ./jobs.json for --check (missing in a temp cwd -> exit 1)", async () => {
    const cwd = process.cwd();
    process.chdir(tmpDir());
    try {
      const r = await run(["--check"]);
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(r.err).toMatch(/jobs\.json/);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("TM2-8 edge: --help unchanged", () => {
  it.each([[["--help"]], [["-h"]], [["--help", "--check"]], [["--next", "0", "-h"]], [["--jobs", "/nope.json", "--check", "--next", "--help"]]])(
    "%j prints usage only, no exit call, nothing read or run",
    async (args) => {
      const r = await run(args);
      expect(r.threw).toBeUndefined();
      expect(r.exit).not.toHaveBeenCalled();
      expect(r.out).toMatch(/^agent-runner: node dist\/main\.js --jobs jobs\.json \[--once <name>\]/);
      expect(r.out.split("\n")).toHaveLength(1);
      expect(r.err).toBe("");
      nothingRan(r);
    },
  );
});
