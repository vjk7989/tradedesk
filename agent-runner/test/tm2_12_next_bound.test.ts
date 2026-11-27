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

const writeJobs = () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tm212-")), "jobs.json");
  writeFileSync(file, JSON.stringify([{
    name: "a",
    schedule: { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], time: "08:45", tz: "Asia/Kolkata" },
    backend: "claude", prompt: "p",
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "TM212_TOKEN" },
    outputDir: "./runs",
  }]));
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

const lines = (out: string) => out.split("\n").filter((l) => l.startsWith("  "));

describe("--next upper bound", () => {
  it("100 works", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T10:00:00Z"));
    const r = await run(["--jobs", writeJobs(), "--next", "100"]);
    expect(lines(r.out)).toHaveLength(100);
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(runTask).not.toHaveBeenCalled();
  });
  it.each(["101", "1000000", "1e6", "Infinity", "99999999999999999999"])("N=%s -> bound error + exit 1", async (n) => {
    const r = await run(["--jobs", writeJobs(), "--next", n]);
    expect(r.out).toBe("--next N must be between 1 and 100");
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(runTask).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "abc", "1.5"])("N=%s keeps the old message", async (n) => {
    const r = await run(["--jobs", writeJobs(), "--next", n]);
    expect(r.out).toBe(`--next N must be a positive integer, got: ${n}`);
    expect(r.exit).toHaveBeenCalledWith(1);
  });
  it("--check unchanged", async () => {
    vi.stubEnv("TM212_TOKEN", "x");
    const r = await run(["--jobs", writeJobs(), "--check"]);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(r.out).toContain("TM212_TOKEN: set");
    expect(runTask).not.toHaveBeenCalled();
  });
  it("--next without N still defaults to 5", async () => {
    const r = await run(["--jobs", writeJobs(), "--next"]);
    expect(lines(r.out)).toHaveLength(5);
    expect(r.exit).toHaveBeenCalledWith(0);
  });
});
