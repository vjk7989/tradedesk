// TM2-49: regression tests for the Windows source fixes, runnable on Linux.
// S1 revoke-cli main guard (path with a space), S2 win32 lock liveness (platform stubbed), S3 oauth rename retry.
import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 60_000 });

// S3: fake renameSync failures for the oauth store only (other renames pass straight through).
const hook = vi.hoisted(() => ({ fail: [] as string[], calls: 0 }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const renameSync = (a: import("node:fs").PathLike, b: import("node:fs").PathLike) => {
    if (String(b).endsWith("oauth.json")) {
      hook.calls++;
      const code = hook.fail.shift();
      if (code) throw Object.assign(new Error(`${code}: fake rename failure`), { code });
    }
    return real.renameSync(a, b);
  };
  return { ...real, default: { ...real, renameSync }, renameSync };
});

import { acquireLock, checkLock, classify, lockPath, readLock, LockHeldError, LIVE_WINDOW_MS } from "../src/datadir-lock.js";
import { TradeOAuthProvider } from "../src/oauth/provider.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = hostname();
const dirs: string[] = [];
const procs: ChildProcess[] = [];
const tmp = (prefix = "tm2-49-") => { const d = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(d); return d; };

afterEach(() => {
  hook.fail = [];
  hook.calls = 0;
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
});
afterAll(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

const far = () => Math.floor(Date.now() / 1000) + 86_400;
function seedStore(dir: string): string {
  const s = JSON.stringify({
    clients: { cid: { client_id: "cid", redirect_uris: ["https://claude.ai/cb"] } },
    access: { ["a".repeat(64)]: { clientId: "cid", familyId: "f1", scopes: ["read"], expiresAt: far() } },
    refresh: { ["b".repeat(64)]: { clientId: "cid", familyId: "f1", scopes: ["read"], expiresAt: far() } },
  });
  writeFileSync(path.join(dir, "oauth.json"), s);
  return s;
}
const readStore = (dir: string) => JSON.parse(readFileSync(path.join(dir, "oauth.json"), "utf8"));

// ---------------------------------------------------------------- S1
describe("S1: revoke-cli main guard runs from a path containing a space", () => {
  let cli = "";
  let root = "";
  beforeAll(() => {
    for (const need of ["node_modules", path.join("node_modules", "tsx")]) {
      if (!existsSync(path.join(ROOT, need))) {
        throw new Error(`TM2-49 S1 setup: ${path.join(ROOT, need)} is missing; run \`npm ci\` in trade-mcp first`);
      }
    }
    // A copy of the package under a directory whose name has spaces (file URL pathname would hold %20).
    root = path.join(tmp("tm2 49 space "), "trade mcp");
    cpSync(path.join(ROOT, "src"), path.join(root, "src"), { recursive: true });
    for (const f of ["package.json", "tsconfig.json"]) cpSync(path.join(ROOT, f), path.join(root, f));
    // "junction" works without admin rights on Windows; ignored (plain symlink) on POSIX.
    symlinkSync(path.join(ROOT, "node_modules"), path.join(root, "node_modules"), "junction");
    cli = path.join(root, "src", "oauth", "revoke-cli.ts");
  });
  const runCli = (argv: string[], dataDir: string) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...argv], {
      cwd: root, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATA_DIR: dataDir, OAUTH_PASSWORD_HASH: "" },
    });

  it("--force actually revokes (old guard: silent exit 0, store untouched)", () => {
    expect(cli).toContain(" ");
    const dir = tmp();
    seedStore(dir);
    const r = runCli(["--force"], dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/revoked 1 access, 1 refresh, 0 codes/);
    const after = readStore(dir);
    expect(after.access).toEqual({});
    expect(after.refresh).toEqual({});
    expect(Object.keys(after.clients)).toEqual(["cid"]);
  });

  // POSIX-only: creating a file symlink on Windows needs admin rights or Developer Mode (EPERM otherwise).
  it.skipIf(process.platform === "win32")("run through a symlink to the entry: --force actually revokes (argv[1] is the link, import.meta.url the realpath)", () => {
    const link = path.join(tmp("tm2 49 link "), "revoke all.ts");
    symlinkSync(cli, link);
    const dir = tmp();
    seedStore(dir);
    const r = spawnSync(process.execPath, ["--import", "tsx", link, "--force"], {
      cwd: root, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATA_DIR: dir, OAUTH_PASSWORD_HASH: "" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/revoked 1 access, 1 refresh, 0 codes/);
    expect(readStore(dir).access).toEqual({});
    expect(readStore(dir).refresh).toEqual({});
  });

  it("without --force exits 2 and leaves the store byte-identical", () => {
    const dir = tmp();
    const store = seedStore(dir);
    const r = runCli([], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Refusing to run without --force/);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
  });
});

// ---------------------------------------------------------------- S2
/** Run fn with process.platform reporting `p` (the lock code reads it at call time). */
function withPlatform<T>(p: NodeJS.Platform, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...desc, value: p });
  try { return fn(); } finally { Object.defineProperty(process, "platform", desc); }
}
function liveOther(): number {
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  procs.push(p);
  return p.pid!;
}
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}
const age = (file: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(file, t, t); };

describe("S2: win32 same-host liveness = pid alive AND heartbeat younger than LIVE_WINDOW_MS", () => {
  it("win32: live pid is live with a fresh or unknown heartbeat, stale at >= LIVE_WINDOW_MS", () => {
    const pid = liveOther();
    const l = { pid, startedAt: "x", hostname: HOST };
    withPlatform("win32", () => {
      expect(classify(l, undefined, 0)).toBe("live");
      expect(classify(l, undefined, LIVE_WINDOW_MS - 1)).toBe("live");
      expect(classify(l, undefined, LIVE_WINDOW_MS)).toBe("stale");
      expect(classify(l, undefined, 10 * LIVE_WINDOW_MS)).toBe("stale");
      expect(classify(l)).toBe("live"); // unknown age: fail closed
    });
  });

  it("win32: a recorded procStart is never checked (no /proc): a fresh lock with a 'different' start time stays live", () => {
    const pid = liveOther();
    withPlatform("win32", () => {
      expect(classify({ pid, startedAt: "x", hostname: HOST, procStart: "1" }, undefined, 0)).toBe("live");
      expect(classify({ pid, startedAt: "x", hostname: HOST, procStart: "1" }, undefined, LIVE_WINDOW_MS)).toBe("stale");
    });
  });

  it("win32: dead pid is stale even with a fresh heartbeat; own pid is stale", () => {
    const pid = deadPid();
    withPlatform("win32", () => {
      expect(classify({ pid, startedAt: "x", hostname: HOST }, undefined, 0)).toBe("stale");
      expect(classify({ pid: process.pid, startedAt: "x", hostname: HOST }, undefined, 0)).toBe("stale");
    });
  });

  it("win32: checkLock/acquireLock refuse a fresh live-pid lock, replace it once the heartbeat is old; no procStart recorded", () => {
    const dir = tmp();
    writeFileSync(lockPath(dir), JSON.stringify({ pid: liveOther(), startedAt: "x", hostname: HOST }));
    withPlatform("win32", () => {
      expect(checkLock(dir)).toBe("live");
      expect(() => acquireLock(dir)).toThrow(LockHeldError);
      age(lockPath(dir), LIVE_WINDOW_MS + 1000);
      expect(checkLock(dir)).toBe("stale");
      const logs: string[] = [];
      const release = acquireLock(dir, (m) => logs.push(m));
      expect(logs.join()).toMatch(/replacing stale/);
      const mine = readLock(dir) as unknown as Record<string, unknown>;
      expect(mine).toMatchObject({ pid: process.pid, hostname: HOST });
      expect(mine.procStart).toBeUndefined();
      release();
      expect(existsSync(lockPath(dir))).toBe(false);
    });
  });

  it("linux (unchanged): a live pid with an old heartbeat is live; a different /proc start time is stale", () => {
    const pid = liveOther();
    const l = { pid, startedAt: "x", hostname: HOST };
    withPlatform("linux", () => {
      expect(classify(l, undefined, 10 * LIVE_WINDOW_MS)).toBe("live");
      expect(classify(l)).toBe("live");
    });
    if (process.platform === "linux") {
      expect(classify({ ...l, procStart: "1" }, undefined, 0)).toBe("stale"); // real /proc needed
    }
  });

  it("darwin (every non-linux platform): same heartbeat rule as win32: old => stale, fresh => live, unknown => live", () => {
    const pid = liveOther();
    const l = { pid, startedAt: "x", hostname: HOST };
    withPlatform("darwin", () => {
      expect(classify(l, undefined, 0)).toBe("live");
      expect(classify(l, undefined, LIVE_WINDOW_MS - 1)).toBe("live");
      expect(classify(l, undefined, LIVE_WINDOW_MS)).toBe("stale");
      expect(classify(l, undefined, 10 * LIVE_WINDOW_MS)).toBe("stale");
      expect(classify(l)).toBe("live"); // unknown age: fail closed
      expect(classify({ ...l, procStart: "1" }, undefined, 0)).toBe("live"); // no /proc: start time not checked
    });
  });

  it("foreign hostname is unaffected by the platform: live < window, stale >= window", () => {
    for (const p of ["win32", "linux"] as const) {
      withPlatform(p, () => {
        expect(classify({ pid: 1, startedAt: "x", hostname: "other-host" }, undefined, LIVE_WINDOW_MS - 1)).toBe("live");
        expect(classify({ pid: 1, startedAt: "x", hostname: "other-host" }, undefined, LIVE_WINDOW_MS)).toBe("stale");
      });
    }
  });
});

// ---------------------------------------------------------------- S3
describe("S3: oauth store rename retries EPERM/EBUSY a bounded number of times", () => {
  const provider = (dir: string) => new TradeOAuthProvider({
    issuerUrl: new URL("https://invalid.example"), passwordHash: "x", allowedRedirectHosts: [],
    stateFile: path.join(dir, "oauth.json"),
  });

  it("EPERM once, then success: persist succeeds (2 rename attempts), store written, no .tmp left", () => {
    const dir = tmp();
    seedStore(dir);
    const p = provider(dir);
    hook.fail = ["EPERM"];
    hook.calls = 0;
    expect(p.revokeAll()).toMatchObject({ access: 1, refresh: 1 });
    expect(hook.calls).toBe(2);
    expect(readStore(dir).access).toEqual({});
    expect(existsSync(path.join(dir, "oauth.json.tmp"))).toBe(false);
  });

  it("EBUSY three times, then success: persist succeeds on the 4th and last attempt", () => {
    const dir = tmp();
    seedStore(dir);
    const p = provider(dir);
    hook.fail = ["EBUSY", "EBUSY", "EBUSY"];
    hook.calls = 0;
    p.revokeAll();
    expect(hook.calls).toBe(4);
    expect(readStore(dir).access).toEqual({});
  });

  it("EPERM four times: rethrows EPERM after 4 attempts; the original store is untouched", () => {
    const dir = tmp();
    const store = seedStore(dir);
    const p = provider(dir);
    hook.fail = ["EPERM", "EPERM", "EPERM", "EPERM"];
    hook.calls = 0;
    let err: unknown;
    try { p.revokeAll(); } catch (e) { err = e; }
    expect((err as NodeJS.ErrnoException)?.code).toBe("EPERM");
    expect(hook.calls).toBe(4);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
  });

  it("other errors (EACCES, EXDEV, ENOENT) are not retried", () => {
    for (const code of ["EACCES", "EXDEV", "ENOENT"]) {
      const dir = tmp();
      const store = seedStore(dir);
      const p = provider(dir);
      hook.fail = [code, "EPERM"]; // a second entry would only be consumed by a retry
      hook.calls = 0;
      let err: unknown;
      try { p.revokeAll(); } catch (e) { err = e; }
      expect((err as NodeJS.ErrnoException)?.code, code).toBe(code);
      expect(hook.calls, code).toBe(1);
      expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    }
  });
});
