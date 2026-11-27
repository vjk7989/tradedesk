import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runTask = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => runTask(...a),
}));

import { main } from "../src/main.js";

const writeJobs = (dir: string) => {
  const file = path.join(dir, "jobs.json");
  writeFileSync(file, JSON.stringify([{
    name: "a", schedule: { days: ["Mon"], time: "08:45", tz: "Asia/Kolkata" }, backend: "claude", prompt: "p",
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN_TM2" },
    timeoutMs: 1234, outputDir: path.join(dir, "runs"),
  }]));
  return file;
};

const setup = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tm2-"));
  const handlers = new Map<string, () => void>();
  const onSignal = vi.fn((s: string, fn: () => void) => void handlers.set(s, fn));
  const exit = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { dir, file: writeJobs(dir), handlers, onSignal, exit };
};
// Monday 2025-01-06 03:15 UTC = 08:45 IST; start 5s before.
const startClock = () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-06T03:14:55Z"));
};
const reports = (dir: string) => (existsSync(path.join(dir, "runs", "a")) ? readdirSync(path.join(dir, "runs", "a")) : []);

afterEach(() => { vi.useRealTimers(); runTask.mockReset(); vi.restoreAllMocks(); });

describe("TM-2 signals", () => {
  it("signal while idle exits immediately and no job runs later", async () => {
    startClock();
    const t = setup();
    void main(["--jobs", t.file], { exit: t.exit, onSignal: t.onSignal });
    await vi.advanceTimersByTimeAsync(1000);
    t.handlers.get("SIGTERM")!();
    expect(t.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(runTask).not.toHaveBeenCalled();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("signal while a job runs waits for it, writes the report, then exits once", async () => {
    startClock();
    const t = setup();
    let resolve!: (v: unknown) => void;
    runTask.mockReturnValue(new Promise((r) => { resolve = r; }));
    void main(["--jobs", t.file], { exit: t.exit, onSignal: t.onSignal });
    await vi.advanceTimersByTimeAsync(6000);
    expect(runTask).toHaveBeenCalledTimes(1);
    t.handlers.get("SIGINT")!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.exit).not.toHaveBeenCalled();
    resolve({ ok: true, text: "done-text", exitCode: 0 });
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalled());
    expect(reports(t.dir)).toHaveLength(1);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("second signal during a running job exits immediately", async () => {
    startClock();
    const t = setup();
    runTask.mockReturnValue(new Promise(() => {}));
    void main(["--jobs", t.file], { exit: t.exit, onSignal: t.onSignal });
    await vi.advanceTimersByTimeAsync(6000);
    t.handlers.get("SIGINT")!();
    expect(t.exit).not.toHaveBeenCalled();
    t.handlers.get("SIGTERM")!();
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("--once: signal exits", async () => {
    const t = setup();
    runTask.mockReturnValue(new Promise(() => {}));
    void main(["--jobs", t.file, "--once", "a"], { exit: t.exit, onSignal: t.onSignal });
    await Promise.resolve();
    expect([...t.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    t.handlers.get("SIGINT")!();
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("--help registers no handlers", async () => {
    const t = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--help"], { exit: t.exit, onSignal: t.onSignal });
    expect(t.onSignal).not.toHaveBeenCalled();
  });

  it("importing main.ts registers no signal handlers", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    vi.resetModules();
    await import("../src/main.js");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});
