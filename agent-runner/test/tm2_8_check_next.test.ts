import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runTask = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => runTask(...a),
}));

import { main } from "../src/main.js";

type J = { name: string; backend?: string; tz?: string; days?: string[]; time?: string; tokenEnv?: string };
const writeJobs = (jobs: J[]) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tm28-")), "jobs.json");
  writeFileSync(file, JSON.stringify(jobs.map((j) => ({
    name: j.name,
    schedule: { days: j.days ?? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], time: j.time ?? "08:45", tz: j.tz ?? "Asia/Kolkata" },
    backend: j.backend ?? "claude", prompt: "p",
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: j.tokenEnv ?? "TM28_TOKEN" },
    outputDir: "./runs",
  }))));
  return file;
};

function run(args: string[]) {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
  const exit = vi.fn();
  const onSignal = vi.fn();
  return main(args, { exit, onSignal }).then(() => ({ out: out.join("\n"), exit, onSignal }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  runTask.mockReset();
});

describe("--check", () => {
  it("all set -> exit 0, never prints values, CLI backend shows -", async () => {
    vi.stubEnv("TM28_TOKEN", "tok-SECRET-111");
    vi.stubEnv("ANTHROPIC_API_KEY", "key-SECRET-222");
    const file = writeJobs([{ name: "a", backend: "api" }, { name: "b", backend: "claude" }]);
    const r = await run(["--jobs", file, "--check"]);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(r.out).not.toContain("SECRET");
    expect(r.out).toContain("TM28_TOKEN: set");
    expect(r.out).toContain("ANTHROPIC_API_KEY: set");
    const b = r.out.split("\n").find((l) => l.startsWith("b\t"))!;
    expect(b.endsWith("\t-")).toBe(true);
    expect(runTask).not.toHaveBeenCalled();
    expect(r.onSignal).not.toHaveBeenCalled();
  });
  it("missing token env -> exit 1", async () => {
    vi.stubEnv("TM28_TOKEN", "");
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("TM28_TOKEN: missing");
  });
  it("whitespace token counts as missing", async () => {
    vi.stubEnv("TM28_TOKEN", "   ");
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
  });
  it("missing key env -> exit 1", async () => {
    vi.stubEnv("TM28_TOKEN", "tok-SECRET-111");
    vi.stubEnv("OPENAI_API_KEY", "");
    const r = await run(["--jobs", writeJobs([{ name: "a", backend: "api-openai" }]), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("OPENAI_API_KEY: missing");
    expect(r.out).not.toContain("SECRET");
  });
  it("invalid jobs file -> exit 1 with parse message", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "tm28-")), "jobs.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }));
    const r = await run(["--jobs", file, "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("jobs must be an array");
  });
  it("missing file -> exit 1", async () => {
    const r = await run(["--jobs", "/does/not/exist.json", "--check"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toMatch(/ENOENT|no such file/);
  });
});

describe("--next", () => {
  const lines = (out: string) => out.split("\n").filter((l) => l.startsWith("  "));
  it("defaults to 5, also when followed by another flag", async () => {
    const file = writeJobs([{ name: "a" }]);
    let r = await run(["--jobs", file, "--next"]);
    expect(lines(r.out)).toHaveLength(5);
    expect(r.exit).toHaveBeenCalledWith(0);
    r = await run(["--next", "--jobs", file]);
    expect(lines(r.out)).toHaveLength(5);
  });
  it("N=3", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }, { name: "b" }]), "--next", "3"]);
    expect(lines(r.out)).toHaveLength(6);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(runTask).not.toHaveBeenCalled();
    expect(r.onSignal).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "abc", "1.5"])("N=%s -> error + exit 1", async (n) => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--next", n]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("positive integer");
    expect(lines(r.out)).toHaveLength(0);
  });
  it("Mon-Fri 08:45 IST asked Friday after 08:45 IST -> Monday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T04:00:00Z")); // Fri 09:30 IST
    const r = await run(["--jobs", writeJobs([{ name: "a", days: ["Mon", "Tue", "Wed", "Thu", "Fri"] }]), "--next", "2"]);
    expect(lines(r.out)[0]).toBe("  2026-11-30 08:45 Asia/Kolkata  2026-11-30T03:15:00.000Z");
    expect(lines(r.out)[1]).toContain("2026-12-01 08:45 Asia/Kolkata");
  });
  it("IST midnight boundary: 00:10 IST asked at 00:05 IST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T18:35:00Z")); // Sat 00:05 IST
    const r = await run(["--jobs", writeJobs([{ name: "a", time: "00:10" }]), "--next", "1"]);
    expect(lines(r.out)[0]).toBe("  2026-11-28 00:10 Asia/Kolkata  2026-11-27T18:40:00.000Z");
  });
  it("UTC job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T10:00:00Z"));
    const r = await run(["--jobs", writeJobs([{ name: "a", tz: "UTC", time: "09:00" }]), "--next", "1"]);
    expect(lines(r.out)[0]).toBe("  2026-11-28 09:00 UTC  2026-11-28T09:00:00.000Z");
  });
  it("invalid jobs file -> exit 1 with parse message", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "tm28-")), "jobs.json");
    writeFileSync(file, "[1]");
    const r = await run(["--jobs", file, "--next"]);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.out).toContain("jobs[0]: must be an object");
  });
});

describe("misc", () => {
  it("--check with --next is rejected", async () => {
    const r = await run(["--jobs", writeJobs([{ name: "a" }]), "--check", "--next"]);
    expect(r.exit).toHaveBeenCalledWith(1);
  });
  it("--help still matches", async () => {
    const r = await run(["--help"]);
    expect(r.out).toMatch(/--jobs .*--once/);
  });
});
