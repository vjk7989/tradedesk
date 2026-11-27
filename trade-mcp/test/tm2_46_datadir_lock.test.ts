import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { acquireLock, checkLock, lockPath, LockHeldError } from "../src/datadir-lock.js";
import { run } from "../src/oauth/revoke-cli.js";

const kids: ChildProcess[] = [];
afterEach(() => { for (const k of kids.splice(0)) k.kill("SIGKILL"); });
const dir = () => mkdtempSync(path.join(tmpdir(), "tm246-"));
function sleeper(): ChildProcess {
  const c = spawn("sleep", ["60"], { stdio: "ignore" });
  kids.push(c);
  return c;
}
const writeLock = (d: string, o: object) => writeFileSync(lockPath(d), JSON.stringify({ startedAt: new Date().toISOString(), hostname: hostname(), ...o }));
const quiet = () => { const w = process.stderr.write.bind(process.stderr); const o = process.stdout.write.bind(process.stdout);
  process.stderr.write = (() => true) as never; process.stdout.write = (() => true) as never;
  return () => { process.stderr.write = w; process.stdout.write = o; }; };
function cli(d: string, args: string[]) { const r = quiet(); try { return run(args, { DATA_DIR: d } as NodeJS.ProcessEnv); } finally { r(); } }

describe("TM2-46 DATA_DIR lock", () => {
  it("creates the lock with pid, start time and hostname; clean release removes it", () => {
    const d = dir();
    const release = acquireLock(d);
    const j = JSON.parse(readFileSync(lockPath(d), "utf8"));
    expect(j.pid).toBe(process.pid);
    expect(j.hostname).toBe(hostname());
    expect(Date.parse(j.startedAt)).toBeGreaterThan(0);
    release();
    expect(existsSync(lockPath(d))).toBe(false);
  });

  it("double start is refused while another live process holds the lock", () => {
    const d = dir();
    const k = sleeper();
    writeLock(d, { pid: k.pid });
    expect(() => acquireLock(d)).toThrow(LockHeldError);
    expect(JSON.parse(readFileSync(lockPath(d), "utf8")).pid).toBe(k.pid);
  });

  it("a stale lock (dead pid, e.g. after SIGKILL) is replaced and logged", async () => {
    const d = dir();
    const k = sleeper();
    writeLock(d, { pid: k.pid });
    expect(checkLock(d)).toBe("live");
    k.kill("SIGKILL");
    await new Promise((r) => k.once("exit", r));
    expect(checkLock(d)).toBe("stale");
    const logs: string[] = [];
    const release = acquireLock(d, (m) => logs.push(m));
    expect(logs.join()).toMatch(/replacing stale/);
    expect(JSON.parse(readFileSync(lockPath(d), "utf8")).pid).toBe(process.pid);
    release();
  });

  it("a lock from a previous incarnation with our own pid (container pid 1 restart) is stale", () => {
    const d = dir();
    writeLock(d, { pid: process.pid });
    expect(checkLock(d)).toBe("stale");
  });

  it("pid reuse (live pid, different process start time) is stale", () => {
    const d = dir();
    const k = sleeper();
    writeLock(d, { pid: k.pid, procStart: "1" });
    expect(checkLock(d)).toBe("stale");
  });

  it("a lock from another hostname is foreign and replaced on start", () => {
    const d = dir();
    writeLock(d, { pid: 1, hostname: "some-other-container" });
    expect(checkLock(d)).toBe("foreign");
    const logs: string[] = [];
    acquireLock(d, (m) => logs.push(m))();
    expect(logs.join()).toMatch(/another host/);
  });

  it("release does not remove a lock someone else now owns", () => {
    const d = dir();
    const release = acquireLock(d);
    writeLock(d, { pid: 999999, hostname: "other" });
    release();
    expect(existsSync(lockPath(d))).toBe(true);
  });

  describe("revoke-cli", () => {
    it("refuses with a live lock even with --force (exit 4), store untouched", () => {
      const d = dir();
      const store = JSON.stringify({ clients: {}, access: {}, refresh: {} });
      writeFileSync(path.join(d, "oauth.json"), store);
      const k = sleeper();
      writeLock(d, { pid: k.pid });
      expect(cli(d, ["--force"])).toBe(4);
      expect(readFileSync(path.join(d, "oauth.json"), "utf8")).toBe(store);
    });

    it("proceeds over a missing lock", () => {
      expect(cli(dir(), ["--force"])).toBe(0);
    });

    it("proceeds over a stale lock", async () => {
      const d = dir();
      const k = sleeper();
      writeLock(d, { pid: k.pid });
      k.kill("SIGKILL");
      await new Promise((r) => k.once("exit", r));
      expect(cli(d, ["--force"])).toBe(0);
    });

    it("proceeds over a foreign-hostname lock (new container, documented limit)", () => {
      const d = dir();
      writeLock(d, { pid: 1, hostname: "old-container" });
      expect(cli(d, ["--force"])).toBe(0);
    });

    it("without --force still exits 2 and unknown args 2", () => {
      expect(cli(dir(), [])).toBe(2);
      expect(cli(dir(), ["--x"])).toBe(2);
    });
  });
});
