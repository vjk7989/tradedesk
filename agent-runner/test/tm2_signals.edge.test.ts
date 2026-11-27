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

type JobSpec = { name: string; time: string; timeoutMs?: number };
const writeJobs = (dir: string, specs: JobSpec[]) => {
  const file = path.join(dir, "jobs.json");
  writeFileSync(file, JSON.stringify(specs.map((s) => ({
    name: s.name, schedule: { days: ["Mon"], time: s.time, tz: "Asia/Kolkata" }, backend: "claude", prompt: `p ${s.name}`,
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN_TM2_EDGE" },
    timeoutMs: s.timeoutMs ?? 1234, outputDir: path.join(dir, "runs"),
  }))));
  return file;
};
const reports = (dir: string, name: string) =>
  existsSync(path.join(dir, "runs", name)) ? readdirSync(path.join(dir, "runs", name)) : [];

const setup = (specs: JobSpec[] = [{ name: "a", time: "08:45" }]) => {
  const dir = mkdtempSync(path.join(tmpdir(), "tm2-edge-"));
  const handlers = new Map<string, Array<() => void>>();
  const onSignal = vi.fn((s: string, fn: () => void) => void handlers.set(s, [...(handlers.get(s) ?? []), fn]));
  const fire = (s: string) => { for (const fn of handlers.get(s) ?? []) fn(); };
  const reportsAtExit: number[] = [];
  const exit = vi.fn((_c: number) => void reportsAtExit.push(reports(dir, "a").length));
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { dir, file: writeJobs(dir, specs), handlers, onSignal, fire, exit, reportsAtExit, deps: { exit, onSignal } };
};
// Monday 2025-01-06 03:15 UTC = 08:45 IST; start 5s before.
const startClock = () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-06T03:14:55Z"));
};
const ok = { ok: true, text: "done", exitCode: 0 };
const deferred = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

afterEach(() => { vi.useRealTimers(); runTask.mockReset(); vi.restoreAllMocks(); });

describe("TM-2 signals: edges", () => {
  it.each(["SIGINT", "SIGTERM"])("%s while idle exits 0 at once, exactly once, and no job runs later", async (sig) => {
    startClock();
    const t = setup();
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(1000);
    t.fire(sig);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    await done;
    expect(runTask).not.toHaveBeenCalled();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it.each(["SIGINT", "SIGTERM"])("%s while a job runs: report written before exit, exit 0 once", async (sig) => {
    startClock();
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    expect(runTask).toHaveBeenCalledTimes(1);
    t.fire(sig);
    expect(t.exit).not.toHaveBeenCalled();
    d.resolve(ok);
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalled());
    await done;
    expect(t.reportsAtExit).toEqual([1]);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("race: signal in the same tick the job resolves -> exit once, report written first", async () => {
    startClock();
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    d.resolve(ok);
    t.fire("SIGTERM"); // job promise settled but its continuation (report write) has not run yet
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalled());
    await done;
    expect(t.reportsAtExit).toEqual([1]);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("race: signal right after the job finished (scheduler back to idle) -> exit once", async () => {
    startClock();
    const t = setup();
    runTask.mockResolvedValue(ok);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    await vi.waitFor(() => expect(reports(t.dir, "a")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);
    t.fire("SIGINT");
    expect(t.exit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    await done;
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("signal during the sleep between two due jobs -> second job never starts", async () => {
    startClock();
    const t = setup([{ name: "a", time: "08:45" }, { name: "b", time: "08:50" }]);
    runTask.mockResolvedValue(ok);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    await vi.waitFor(() => expect(reports(t.dir, "a")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60000); // now sleeping until b at 08:50
    expect(runTask).toHaveBeenCalledTimes(1);
    t.fire("SIGTERM");
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(10 * 60000);
    await done;
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(reports(t.dir, "b")).toEqual([]);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("signal while job a runs and job b is due in the same slot -> b never starts", async () => {
    startClock();
    const t = setup([{ name: "a", time: "08:45" }, { name: "b", time: "08:45" }]);
    const d = deferred();
    runTask.mockReturnValueOnce(d.promise).mockResolvedValue(ok);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    expect(runTask).toHaveBeenCalledTimes(1);
    t.fire("SIGINT");
    d.resolve(ok);
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalled());
    await done;
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(reports(t.dir, "b")).toEqual([]);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("second signal while job runs exits immediately; job finishing later does not call exit again", async () => {
    startClock();
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    t.fire("SIGINT");
    expect(t.exit).not.toHaveBeenCalled();
    t.fire("SIGINT");
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    t.fire("SIGTERM"); // a third signal must not call exit again either
    d.resolve(ok);
    await vi.waitFor(() => expect(reports(t.dir, "a")).toHaveLength(1));
    await done;
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("job that throws after the signal -> still exit 0, exactly once", async () => {
    startClock();
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    t.fire("SIGTERM");
    d.reject(new Error("boom"));
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalled());
    await expect(done).resolves.toBeUndefined();
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    expect(t.reportsAtExit).toEqual([1]); // error report still written
  });

  it("job hanging past its timeoutMs after the signal -> exits after the timeout, not before", async () => {
    startClock();
    const t = setup([{ name: "a", time: "08:45", timeoutMs: 30000 }]);
    // stand-in for runTask's own timeout: settles with a timeout error after opts.timeoutMs
    runTask.mockImplementation((opts: { timeoutMs: number }) =>
      new Promise((r) => setTimeout(() => r({ ok: false, text: "", error: "timed out", exitCode: null }), opts.timeoutMs)));
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(5000); // job starts at exactly 03:15:00
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][0]).toMatchObject({ timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(1000);
    t.fire("SIGINT");
    await vi.advanceTimersByTimeAsync(28999); // t = 34999, 1 ms before the 35000 timeout
    expect(t.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalled());
    await done;
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    expect(t.reportsAtExit).toEqual([1]);
  });

  it("--once: signal mid-run exits 0 immediately; job finishing later does not exit again", async () => {
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file, "--once", "a"], t.deps);
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1));
    t.fire("SIGTERM");
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    d.resolve(ok);
    await done;
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("--once without a signal never calls exit", async () => {
    const t = setup();
    runTask.mockResolvedValue(ok);
    await main(["--jobs", t.file, "--once", "a"], t.deps);
    expect(t.exit).not.toHaveBeenCalled();
    expect(reports(t.dir, "a")).toHaveLength(1);
  });

  it.each([["--help"], ["-h"]])("%s registers zero handlers and never exits", async (flag) => {
    const t = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await main([flag, "--jobs", t.file], t.deps);
    expect(t.onSignal).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("importing main.ts registers zero process signal handlers", async () => {
    const on = vi.spyOn(process, "on");
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    vi.resetModules();
    await import("../src/main.js");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    expect(on.mock.calls.filter(([s]) => s === "SIGINT" || s === "SIGTERM")).toEqual([]);
  });

  it("unknown job with --once still rejects (exit 1 path), registers nothing, calls no exit", async () => {
    const t = setup();
    await expect(main(["--jobs", t.file, "--once", "nope"], t.deps)).rejects.toThrow(/no such job: nope/);
    expect(t.onSignal).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
  });

  it("empty deps object falls back to defaults like no 2nd arg", async () => {
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const t = setup();
    runTask.mockResolvedValue(ok);
    await main(["--jobs", t.file, "--once", "a"], {});
    const sigs = on.mock.calls.filter(([s]) => s === "SIGINT" || s === "SIGTERM").map(([s]) => s);
    expect(sigs.sort()).toEqual(["SIGINT", "SIGTERM"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("default deps (no 2nd arg) register via process.on and exit via process.exit(0)", async () => {
    startClock();
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const t = setup();
    const done = main(["--jobs", t.file]);
    await vi.advanceTimersByTimeAsync(1000);
    const calls = on.mock.calls.filter(([s]) => s === "SIGINT" || s === "SIGTERM");
    expect(calls.map(([s]) => s).sort()).toEqual(["SIGINT", "SIGTERM"]);
    expect(t.onSignal).not.toHaveBeenCalled();
    (calls.find(([s]) => s === "SIGTERM")![1] as () => void)();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    await done;
    expect(runTask).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("no listener leaks: each main() call registers exactly one handler per signal", async () => {
    startClock();
    const t = setup();
    for (let i = 1; i <= 3; i++) {
      const done = main(["--jobs", t.file], t.deps);
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.onSignal).toHaveBeenCalledTimes(2 * i);
      t.handlers.get("SIGINT")!.at(-1)!(); // stop this run
      await vi.advanceTimersByTimeAsync(3600000);
      await done;
    }
    const sigs = t.onSignal.mock.calls.map(([s]) => s);
    expect(sigs.filter((s) => s === "SIGINT")).toHaveLength(3);
    expect(sigs.filter((s) => s === "SIGTERM")).toHaveLength(3);
    expect(t.exit).toHaveBeenCalledTimes(3);
    expect(runTask).not.toHaveBeenCalled();
  });

  it("--once also registers exactly one handler per signal", async () => {
    const t = setup();
    runTask.mockResolvedValue(ok);
    await main(["--jobs", t.file, "--once", "a"], t.deps);
    await main(["--jobs", t.file, "--once", "a"], t.deps);
    expect(t.onSignal.mock.calls.map(([s]) => s).sort()).toEqual(["SIGINT", "SIGINT", "SIGTERM", "SIGTERM"]);
  });
});
