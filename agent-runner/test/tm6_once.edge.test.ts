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

type JobSpec = { name: string; time: string };
const reports = (dir: string, name: string) =>
  existsSync(path.join(dir, "runs", name)) ? readdirSync(path.join(dir, "runs", name)) : [];
const setup = (specs: JobSpec[] = [{ name: "a", time: "08:45" }]) => {
  const dir = mkdtempSync(path.join(tmpdir(), "tm6-edge-"));
  const file = path.join(dir, "jobs.json");
  writeFileSync(file, JSON.stringify(specs.map((s) => ({
    name: s.name, schedule: { days: ["Mon"], time: s.time, tz: "Asia/Kolkata" }, backend: "claude", prompt: `p ${s.name}`,
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN_TM6_EDGE" },
    timeoutMs: 1234, outputDir: path.join(dir, "runs"),
  }))));
  const handlers = new Map<string, Array<() => void>>();
  const onSignal = vi.fn((s: string, fn: () => void) => void handlers.set(s, [...(handlers.get(s) ?? []), fn]));
  const fire = (s: string) => { for (const fn of handlers.get(s) ?? []) fn(); };
  const exit = vi.fn((_c: number) => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { dir, file, handlers, onSignal, fire, exit, deps: { exit, onSignal } };
};
const ok = { ok: true, text: "done", exitCode: 0 };
const deferred = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

afterEach(() => { vi.useRealTimers(); runTask.mockReset(); vi.restoreAllMocks(); });

describe("TM-6 --once: edges", () => {
  it("registers exactly one handler per SIGINT and SIGTERM", async () => {
    const t = setup();
    runTask.mockReturnValue(new Promise(() => {}));
    void main(["--jobs", t.file, "--once", "a"], t.deps);
    await tick();
    expect(t.handlers.get("SIGINT")).toHaveLength(1);
    expect(t.handlers.get("SIGTERM")).toHaveLength(1);
  });

  it.each([["SIGINT", "SIGTERM"], ["SIGTERM", "SIGINT"], ["SIGINT", "SIGINT"], ["SIGTERM", "SIGTERM"]])(
    "%s then %s while the job runs -> exit(0) exactly once", async (a, b) => {
      const t = setup();
      runTask.mockReturnValue(new Promise(() => {}));
      void main(["--jobs", t.file, "--once", "a"], t.deps);
      await tick();
      t.fire(a);
      expect(t.exit).toHaveBeenCalledTimes(1);
      expect(t.exit).toHaveBeenCalledWith(0);
      t.fire(b);
      t.fire(a); // third signal too
      expect(t.exit).toHaveBeenCalledTimes(1);
    });

  it("job completes normally with no signal -> main resolves, exit never called", async () => {
    const t = setup();
    runTask.mockResolvedValue(ok);
    await main(["--jobs", t.file, "--once", "a"], t.deps);
    expect(reports(t.dir, "a")).toHaveLength(1);
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("signals after the job completed -> exit(0) still at most once", async () => {
    const t = setup();
    runTask.mockResolvedValue(ok);
    await main(["--jobs", t.file, "--once", "a"], t.deps);
    t.fire("SIGINT");
    t.fire("SIGTERM");
    t.fire("SIGINT");
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("job completion after the signal -> no second exit, main resolves", async () => {
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file, "--once", "a"], t.deps);
    await tick();
    t.fire("SIGTERM");
    expect(t.exit).toHaveBeenCalledTimes(1);
    d.resolve(ok);
    await expect(done).resolves.toBeUndefined();
    t.fire("SIGINT");
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("job rejecting after the signal -> no second exit (no exit(1) from main itself)", async () => {
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file, "--once", "a"], t.deps);
    await tick();
    t.fire("SIGINT");
    d.reject(new Error("boom"));
    await done.catch(() => {}); // outcome of main is not this AC; exit count is
    t.fire("SIGTERM");
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("signal in the same tick the job resolves -> exit once", async () => {
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file, "--once", "a"], t.deps);
    await tick();
    d.resolve(ok);
    t.fire("SIGINT");
    t.fire("SIGTERM");
    await done;
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("unknown --once job -> throws before registering handlers, no exit", async () => {
    const t = setup();
    await expect(main(["--jobs", t.file, "--once", "nope"], t.deps)).rejects.toThrow(/no such job: nope/);
    expect(t.onSignal).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
  });

  it("--once runs only the named job, never the scheduler", async () => {
    const t = setup([{ name: "a", time: "08:45" }, { name: "b", time: "08:45" }]);
    runTask.mockResolvedValue(ok);
    await main(["--jobs", t.file, "--once", "b"], t.deps);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(reports(t.dir, "b")).toHaveLength(1);
    expect(reports(t.dir, "a")).toEqual([]);
  });
});

// Scheduler mode must be unchanged by moving bye()/exited up (light re-run of TM-2 edges).
describe("TM-6: scheduler mode unchanged", () => {
  const startClock = () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-06T03:14:55Z")); // Mon 08:44:55 IST
  };

  it("SIGINT while idle -> exit(0) once, no job later", async () => {
    startClock();
    const t = setup();
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(1000);
    t.fire("SIGINT");
    t.fire("SIGTERM");
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(7 * 86400000);
    await done;
    expect(runTask).not.toHaveBeenCalled();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("first signal during a job waits for it; second exits now; job finishing later adds no exit", async () => {
    startClock();
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    expect(runTask).toHaveBeenCalledTimes(1);
    t.fire("SIGTERM");
    expect(t.exit).not.toHaveBeenCalled();
    t.fire("SIGINT");
    expect(t.exit).toHaveBeenCalledTimes(1);
    d.resolve(ok);
    await vi.waitFor(() => expect(reports(t.dir, "a")).toHaveLength(1));
    await done;
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("single signal during a job -> exit after the job's report, once", async () => {
    startClock();
    const t = setup();
    const d = deferred();
    runTask.mockReturnValue(d.promise);
    const done = main(["--jobs", t.file], t.deps);
    await vi.advanceTimersByTimeAsync(6000);
    t.fire("SIGINT");
    expect(t.exit).not.toHaveBeenCalled();
    d.resolve(ok);
    await vi.waitFor(() => expect(t.exit).toHaveBeenCalled());
    await done;
    expect(reports(t.dir, "a")).toHaveLength(1);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });
});
