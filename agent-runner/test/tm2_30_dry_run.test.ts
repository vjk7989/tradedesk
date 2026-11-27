import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
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

import { main } from "../src/main.js";

const FAKE_TOKEN = "fake-tok-AAA111";
const FAKE_KEY = "fake-key-BBB222";
const writeJobs = (prompt: string, backend = "claude") => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tm230-")), "jobs.json");
  writeFileSync(file, JSON.stringify([
    {
      name: "alpha", backend, prompt, timeoutMs: 1234,
      schedule: { days: ["Mon"], time: "08:45", tz: "Asia/Kolkata" },
      mcp: { name: "t", url: "https://mcp.example.com/mcp", tokenEnv: "TM230_TOKEN" },
      outputDir: "./runs",
    },
    {
      name: "beta", backend: "claude", prompt: "p",
      schedule: { days: ["Sat"], time: "10:00", tz: "UTC" },
      mcp: { name: "t", url: "https://mcp.example.com/mcp", tokenEnv: "TM230_TOKEN" },
      outputDir: "./runs",
    },
  ]));
  return file;
};

async function run(args: string[]) {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
  const exit = vi.fn();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await main(args, { exit, onSignal: () => {} });
  return { out: out.join("\n"), exit, fetchSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runTask.mockReset();
});

describe("--dry-run", () => {
  it("prints the job, exits 0, spawns nothing, fetches nothing", async () => {
    vi.stubEnv("TM230_TOKEN", FAKE_TOKEN);
    const f = writeJobs("hello verbatim prompt");
    const { out, exit, fetchSpy } = await run(["--jobs", f, "--dry-run", "alpha"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(out).toContain("backend: claude");
    expect(out).toContain("https://mcp.example.com/mcp");
    expect(out).toContain("TM230_TOKEN (set)");
    expect(out).toContain("1234 ms");
    expect(out).toContain("Mon 08:45 Asia/Kolkata");
    expect(out).toContain("next run:");
    expect(out).toContain("hello verbatim prompt");
    expect(out).not.toContain(FAKE_TOKEN);
    expect(runTask).not.toHaveBeenCalled();
    expect(vi.mocked(cp.spawn)).not.toHaveBeenCalled();
    expect(vi.mocked(cp.execFile)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports missing token", async () => {
    vi.stubEnv("TM230_TOKEN", "");
    const { out } = await run(["--jobs", writeJobs("p"), "--dry-run", "alpha"]);
    expect(out).toContain("TM230_TOKEN (missing)");
  });

  it("redacts env values found in the prompt", async () => {
    vi.stubEnv("TM230_TOKEN", FAKE_TOKEN);
    vi.stubEnv("OPENAI_API_KEY", FAKE_KEY);
    const f = writeJobs(`use ${FAKE_TOKEN} and ${FAKE_KEY} twice ${FAKE_TOKEN}`, "api-openai");
    const { out } = await run(["--jobs", f, "--dry-run", "alpha"]);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain("use [redacted] and [redacted] twice [redacted]");
  });

  it("unknown name exits 1 and lists valid names", async () => {
    const { out, exit } = await run(["--jobs", writeJobs("p"), "--dry-run", "nope"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(out).toContain("no such job: nope");
    expect(out).toContain("alpha, beta");
  });

  it.each(["--once", "--check", "--next"])("errors when combined with %s", async (flag) => {
    const args = ["--jobs", writeJobs("p"), "--dry-run", "alpha", flag];
    if (flag === "--once") args.push("alpha");
    const { out, exit } = await run(args);
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
    expect(out).toContain(`--dry-run cannot be combined with ${flag}`);
    expect(runTask).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    const { out, exit } = await run(["--jobs", writeJobs("p"), "--dry-run"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(out).toContain("requires a job name");
  });
});
