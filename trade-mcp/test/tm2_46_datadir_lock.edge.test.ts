// TM2-46 edge tests (independent): DATA_DIR/trade-mcp.lock and the revoke-cli live-lock refusal.
// Temp dirs and fake values only. Real-process tests spawn `node --import tsx` (one process, so the
// child pid is the pid written into the lock).
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

vi.setConfig({ testTimeout: 90_000 });

// Deterministic interleaving hooks: run "another process" exactly around this process's rename/link of the lock.
const hook = vi.hoisted(() => ({
  beforeRename: null as null | ((src: string) => void),
  afterRename: null as null | ((src: string) => void),
  beforeLink: null as null | ((src: string, dst: string) => void),
}));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const renameSync = (a: import("node:fs").PathLike, b: import("node:fs").PathLike) => {
    const h = hook.beforeRename;
    if (h) { hook.beforeRename = null; h(String(a)); }
    real.renameSync(a, b);
    const h2 = hook.afterRename;
    if (h2) { hook.afterRename = null; h2(String(a)); }
  };
  const linkSync = (a: import("node:fs").PathLike, b: import("node:fs").PathLike) => {
    const h = hook.beforeLink;
    if (h) { hook.beforeLink = null; h(String(a), String(b)); }
    return real.linkSync(a, b);
  };
  return { ...real, default: { ...real, renameSync, linkSync }, renameSync, linkSync };
});

import {
  acquireLock, checkLock, classify, readLock, lockPath, startHeartbeat, LockHeldError, LockUnwritableError, LOCK_NAME,
  HEARTBEAT_MS, LIVE_WINDOW_MS, YOUNG_CORRUPT_MS,
} from "../src/datadir-lock.js";
import { run } from "../src/oauth/revoke-cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_TS = path.join(ROOT, "src/datadir-lock.ts");
const INDEX_TS = path.join(ROOT, "src/index.ts");
const CLI_TS = path.join(ROOT, "src/oauth/revoke-cli.ts");
const HOST = hostname();
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
// Windows (see TM2-49): no /proc, no POSIX mode bits, symlinks need admin/Developer Mode, and SIGTERM/SIGINT sent
// via ChildProcess.kill() terminate the child outright (no handler runs). Tests that depend on those are skipped there.
const IS_WIN = process.platform === "win32";

// Fake secrets: must never appear in any output.
const FAKE_MCP_TOKEN = "fake-mcp-token-edge-" + "q".repeat(20);
const FAKE_API_KEY = "fake-openalgo-key-edge-46";
const FAKE_PW_HASH = "scrypt:" + "ab".repeat(16) + ":" + "cd".repeat(64);
const FAKE_CLIENT_SECRET = "fake-client-secret-" + "z".repeat(24);
const FAKE_ACCESS_KEY = "e".repeat(64);
const FAKE_REFRESH_KEY = "f".repeat(64);
const SECRETS = [FAKE_MCP_TOKEN, FAKE_API_KEY, FAKE_PW_HASH, FAKE_CLIENT_SECRET, FAKE_ACCESS_KEY, FAKE_REFRESH_KEY];

const tmpDirs: string[] = [];
const procs: ChildProcess[] = [];
const roDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "tm2-46-edge-"));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  hook.beforeRename = null;
  hook.afterRename = null;
  hook.beforeLink = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of roDirs.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } }
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
});
afterAll(() => {
  for (const d of tmpDirs) { try { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function procStartOf(pid: number): string {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  return s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
}
/** procStartOf on Linux; undefined on Windows (no /proc; the lock code records no procStart there either). */
const procStartIfAny = (pid: number): string | undefined => (IS_WIN ? undefined : procStartOf(pid));
/** A live process on this host that is not us. Uses this node binary, not `sleep` (no sleep.exe on Windows). */
function liveOther(): number {
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  procs.push(p);
  return p.pid!;
}
/** A pid that is very likely dead (a child that already exited). */
function deadPid(): number {
  // A node child prints its own pid and exits (no `sh` on Windows).
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}
const writeLock = (dir: string, v: unknown) =>
  writeFileSync(lockPath(dir), typeof v === "string" ? v : JSON.stringify(v));
/** Backdate the lock heartbeat (mtime) by ms. */
const age = (file: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(file, t, t); };
const OLD_CORRUPT = YOUNG_CORRUPT_MS + 3000; // past the "mid-write" window
const OLD_HEARTBEAT = LIVE_WINDOW_MS + 5000; // past the live window
const ageMsOf = (file: string) => Date.now() - statSync(file).mtimeMs;
const leftovers = (dir: string) => readdirSync(dir).filter((n) => n !== LOCK_NAME && n.startsWith(LOCK_NAME));
const liveLock = (pid: number) => ({ pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: HOST, procStart: procStartIfAny(pid) });

function seedStore(dir: string): string {
  const far = Math.floor(Date.now() / 1000) + 86_400;
  const s = JSON.stringify({
    clients: { "cid-edge": { client_id: "cid-edge", client_secret: FAKE_CLIENT_SECRET, redirect_uris: ["https://claude.ai/cb"] } },
    access: { [FAKE_ACCESS_KEY]: { clientId: "cid-edge", familyId: "fam1", scopes: ["read"], expiresAt: far } },
    refresh: { [FAKE_REFRESH_KEY]: { clientId: "cid-edge", familyId: "fam1", scopes: ["read"], expiresAt: far } },
  });
  writeFileSync(path.join(dir, "oauth.json"), s);
  return s;
}
function runCli(argv: string[], env: NodeJS.ProcessEnv) {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { out += String(c); return true; });
  const code = run(argv, env);
  vi.restoreAllMocks();
  return { code, out };
}
const cliEnv = (dir: string) => ({ DATA_DIR: dir, OAUTH_PASSWORD_HASH: FAKE_PW_HASH, MCP_TOKEN: FAKE_MCP_TOKEN });
const noSecrets = (s: string) => { for (const x of SECRETS) expect(s).not.toContain(x); };

// ---------------------------------------------------------------- concurrent starts (real processes)

const WORKER = `
import { acquireLock, LockHeldError } from ${JSON.stringify(pathToFileURL(LOCK_TS).href)};
import { existsSync, readFileSync } from "node:fs";
const [dir, go, done] = process.argv.slice(2);
process.stdout.write("READY\\n");
while (!existsSync(go)) { /* spin: maximise overlap */ }
let rel;
try { rel = acquireLock(dir); }
catch (e) { process.stdout.write((e instanceof LockHeldError ? "LOSE" : "ERR " + e.message) + "\\n"); process.exit(0); }
let mine = false;
try { mine = JSON.parse(readFileSync(dir + "/${LOCK_NAME}", "utf8")).pid === process.pid; } catch {}
process.stdout.write("WIN " + (mine ? "owns" : "lost-file") + "\\n");
const t = Date.now();
while (!existsSync(done) && Date.now() - t < 30000) await new Promise((r) => setTimeout(r, 20));
rel(); process.exit(0);
`;

async function race(dir: string, n: number): Promise<string[]> {
  const wdir = tmp();
  const worker = path.join(wdir, "worker.mjs");
  writeFileSync(worker, WORKER);
  const go = path.join(wdir, "go");
  const done = path.join(wdir, "done");
  const lines: Promise<string>[] = [];
  const ready: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    const p = spawn(process.execPath, ["--import", "tsx", worker, dir, go, done], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(p);
    let buf = "";
    let r1!: () => void;
    let r2!: (s: string) => void;
    ready.push(new Promise((r) => (r1 = r)));
    lines.push(new Promise((r) => (r2 = r)));
    p.stdout!.on("data", (c) => {
      buf += c;
      if (buf.includes("READY\n")) r1();
      const m = buf.match(/(WIN \S+|LOSE|ERR [^\n]*)\n/);
      if (m) r2(m[1]);
    });
    p.on("exit", () => { r1(); r2(buf.match(/(WIN \S+|LOSE|ERR [^\n]*)\n/)?.[1] ?? "EXITED"); });
  }
  await Promise.all(ready);
  writeFileSync(go, "");
  const res = await Promise.all(lines);
  writeFileSync(done, "");
  await Promise.all(procs.filter((p) => p.exitCode === null).map((p) => new Promise((r) => p.on("exit", r))));
  return res;
}

describe("concurrent starts", () => {
  it("N simultaneous acquires on an empty DATA_DIR: exactly one winner, everyone else refused", async () => {
    for (let round = 0; round < 3; round++) {
      const dir = tmp();
      const res = await race(dir, 6);
      expect(res.filter((r) => r.startsWith("WIN")), JSON.stringify(res)).toHaveLength(1);
      expect(res.filter((r) => r === "LOSE")).toHaveLength(5);
      expect(existsSync(lockPath(dir))).toBe(false); // winner released on exit
    }
  });

  it("N simultaneous acquires over a pre-existing STALE lock: exactly one replaces it, the rest refuse", async () => {
    for (let round = 0; round < 3; round++) {
      const dir = tmp();
      writeLock(dir, { pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z", hostname: HOST });
      const res = await race(dir, 6);
      expect(res.filter((r) => r.startsWith("WIN")), JSON.stringify(res)).toHaveLength(1);
      expect(res.filter((r) => r === "WIN owns")).toHaveLength(1);
    }
  });

  // Formerly failing (round 0): the stale-lock unlink could delete a rival's fresh lock. Now replacement is
  // rename-aside + verify. A rival that swaps in a live lock just before our rename must win.
  it("deterministic: a rival's live lock swapped in just before our rename-aside is restored and we refuse", () => {
    const dir = tmp();
    writeLock(dir, { pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z", hostname: HOST });
    const rival = liveLock(liveOther());
    hook.beforeRename = (src) => {
      expect(src).toBe(lockPath(dir));
      unlinkSync(src);
      writeFileSync(src, JSON.stringify(rival), { flag: "wx" });
    };
    let release: (() => void) | undefined;
    let err: unknown;
    try { release = acquireLock(dir); } catch (e) { err = e; }
    expect(err, "both processes believe they hold the lock").toBeInstanceOf(LockHeldError);
    expect(readLock(dir)).toEqual(rival);
    expect(leftovers(dir)).toEqual([]); // no aside/tmp/guard files left behind
    release?.();
  });

  it("deterministic: a rival that links its lock into the gap right after our rename-aside wins; we refuse", () => {
    const dir = tmp();
    writeLock(dir, { pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z", hostname: HOST });
    const rival = liveLock(liveOther());
    hook.afterRename = (src) => {
      expect(existsSync(src)).toBe(false);
      writeFileSync(src, JSON.stringify(rival), { flag: "wx" });
    };
    let err: unknown;
    try { acquireLock(dir)(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LockHeldError);
    expect(readLock(dir)).toEqual(rival);
    expect(leftovers(dir)).toEqual([]);
  });

  it("deterministic: a fresh replace guard held by another replacer blocks a concurrent replace", () => {
    const dir = tmp();
    const stale = { pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z", hostname: HOST };
    writeLock(dir, stale);
    let rivalErr: unknown;
    let rivalSawGuard = false;
    hook.beforeRename = () => {
      // We hold the guard and are about to rename. A concurrent replacer must not get past the guard.
      rivalSawGuard = existsSync(lockPath(dir) + ".replace");
      try { acquireLock(dir)(); } catch (e) { rivalErr = e; }
      expect(readLock(dir)).toEqual(stale); // the rival did not touch the stale lock
    };
    const release = acquireLock(dir);
    expect(rivalSawGuard).toBe(true);
    expect(rivalErr).toBeInstanceOf(Error);
    expect(rivalErr).not.toBeInstanceOf(LockHeldError);
    expect(String((rivalErr as Error).message)).toMatch(/could not acquire/);
    expect(readLock(dir)).toMatchObject({ pid: process.pid });
    expect(leftovers(dir)).toEqual([]); // guard removed after the replace
    release();
  });

  it("a fresh guard file (crashed/slow replacer < 10 s ago) blocks stale replacement; startup fails, lock untouched", () => {
    const dir = tmp();
    const stale = JSON.stringify({ pid: deadPid(), startedAt: "x", hostname: HOST });
    writeLock(dir, stale);
    writeFileSync(lockPath(dir) + ".replace", "");
    let err: unknown;
    try { acquireLock(dir); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LockHeldError);
    expect(String((err as Error).message)).toMatch(/could not acquire/);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(stale);
    expect(existsSync(lockPath(dir) + ".replace")).toBe(true);
  });

  it("an abandoned guard file older than 10 s is ignored and cleaned up", () => {
    const dir = tmp();
    writeLock(dir, { pid: deadPid(), startedAt: "x", hostname: HOST });
    writeFileSync(lockPath(dir) + ".replace", "");
    age(lockPath(dir) + ".replace", 11_000);
    const logs: string[] = [];
    const release = acquireLock(dir, (m) => logs.push(m));
    expect(readLock(dir)).toMatchObject({ pid: process.pid });
    expect(logs.join()).toMatch(/replacing stale/);
    expect(existsSync(lockPath(dir) + ".replace")).toBe(false);
    release();
  });

  // Formerly failing (round 0): the lock was created empty and written afterwards. Now a full temp file is
  // link()ed into place, so the lock path never exists half-written.
  it("the lock path never exists half-written: at link time the source already holds our full JSON", () => {
    const dir = tmp();
    let seen: unknown;
    hook.beforeLink = (src, dst) => {
      expect(dst).toBe(lockPath(dir));
      expect(existsSync(dst)).toBe(false);
      seen = JSON.parse(readFileSync(src, "utf8"));
    };
    const release = acquireLock(dir);
    expect(seen).toMatchObject({ pid: process.pid, hostname: HOST });
    expect(readLock(dir)).toEqual(seen);
    expect(leftovers(dir)).toEqual([]);
    release();
  });

  it("an empty lock younger than YOUNG_CORRUPT_MS is treated as a rival mid-write (live); older is replaced", () => {
    const dir = tmp();
    writeLock(dir, "");
    expect(checkLock(dir)).toBe("live");
    expect(() => acquireLock(dir)).toThrow(LockHeldError);
    expect(readFileSync(lockPath(dir), "utf8")).toBe("");
    age(lockPath(dir), OLD_CORRUPT);
    expect(checkLock(dir)).toBe("corrupt");
    const release = acquireLock(dir);
    expect(readLock(dir)).toMatchObject({ pid: process.pid });
    release();
  });
});

// ---------------------------------------------------------------- shutdown / release

describe("release", () => {
  it("does not delete a lock that another process wrote after ours", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    const other = liveLock(liveOther());
    writeLock(dir, other);
    release();
    expect(readLock(dir)).toEqual(other);
  });

  it("does not delete a same-pid same-host lock with a different startedAt (a later incarnation)", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    const later = { pid: process.pid, startedAt: "2099-01-01T00:00:00.000Z", hostname: HOST };
    writeLock(dir, later);
    release();
    expect(readLock(dir)).toEqual(later);
  });

  it("does not delete a lock replaced by corrupt content or a directory", () => {
    const dir = tmp();
    const r1 = acquireLock(dir);
    writeLock(dir, "{garbage");
    expect(() => r1()).not.toThrow();
    expect(readFileSync(lockPath(dir), "utf8")).toBe("{garbage");
    unlinkSync(lockPath(dir));
    const r2 = acquireLock(dir);
    unlinkSync(lockPath(dir));
    mkdirSync(lockPath(dir));
    expect(() => r2()).not.toThrow();
    expect(lstatSync(lockPath(dir)).isDirectory()).toBe(true);
  });

  it("release twice is a no-op the second time, even if a new lock appeared in between", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    release();
    expect(existsSync(lockPath(dir))).toBe(false);
    const other = liveLock(liveOther());
    writeLock(dir, other);
    expect(() => release()).not.toThrow();
    expect(readLock(dir)).toEqual(other);
  });

  it("release after the lock file (or the whole DATA_DIR) was deleted does not throw or recreate anything", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    unlinkSync(lockPath(dir));
    expect(() => release()).not.toThrow();
    expect(existsSync(lockPath(dir))).toBe(false);
    const dir2 = tmp();
    const release2 = acquireLock(dir2);
    rmSync(dir2, { recursive: true, force: true });
    expect(() => release2()).not.toThrow();
    expect(existsSync(dir2)).toBe(false);
  });
});

// ---------------------------------------------------------------- lock content

describe("hostile lock content", () => {
  const junk: [string, string][] = [
    ["corrupt JSON", "{not json"],
    ["empty file", ""],
    ["whitespace", "   \n"],
    ["JSON null", "null"],
    ["JSON array", "[1,2]"],
    ["JSON number", "42"],
    ["missing hostname", JSON.stringify({ pid: 1, startedAt: "x" })],
    ["missing pid", JSON.stringify({ hostname: HOST, startedAt: "x" })],
    ["pid as string", JSON.stringify({ pid: String(process.ppid), hostname: HOST })],
    ["pid 0 (would signal our process group)", JSON.stringify({ pid: 0, hostname: HOST })],
    ["pid -1 (would signal everything)", JSON.stringify({ pid: -1, hostname: HOST })],
    ["pid float", JSON.stringify({ pid: 1.5, hostname: HOST })],
    ["hostname non-string", JSON.stringify({ pid: process.ppid, hostname: 7 })],
    ["__proto__ pollution", '{"__proto__":{"pid":123,"hostname":"x"},"pid":"no"}'],
  ];
  for (const [name, content] of junk) {
    it(`${name}: live while young (fail closed); once older than ${YOUNG_CORRUPT_MS} ms replaced on start, CLI proceeds`, () => {
      const dir = tmp();
      writeLock(dir, content);
      expect(checkLock(dir)).toBe("live");
      expect(() => acquireLock(dir)).toThrow(LockHeldError);
      expect(readFileSync(lockPath(dir), "utf8")).toBe(content);
      age(lockPath(dir), OLD_CORRUPT);
      expect(checkLock(dir)).toBe("corrupt");
      const logs: string[] = [];
      const release = acquireLock(dir, (m) => logs.push(m));
      expect(readLock(dir)).toMatchObject({ pid: process.pid, hostname: HOST });
      expect(logs.join("\n")).toMatch(/replacing stale/);
      release();
      writeLock(dir, content);
      age(lockPath(dir), OLD_CORRUPT);
      seedStore(dir);
      const r = runCli(["--force"], cliEnv(dir));
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/revoked 1 access, 1 refresh/);
      noSecrets(r.out);
      expect(({} as Record<string, unknown>).pid).toBeUndefined();
    });
  }

  it("pid beyond int32 / MAX_SAFE_INTEGER is not 'live' and does not throw", () => {
    for (const pid of [2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      const dir = tmp();
      writeLock(dir, { pid, startedAt: "x", hostname: HOST });
      expect(() => checkLock(dir)).not.toThrow();
      expect(checkLock(dir)).not.toBe("live");
      const release = acquireLock(dir);
      expect(readLock(dir)).toMatchObject({ pid: process.pid });
      release();
    }
  });

  it("huge (20 MB) garbage lock: corrupt, replaced, CLI proceeds", () => {
    const dir = tmp();
    writeLock(dir, "{" + " ".repeat(20 * 1024 * 1024));
    expect(checkLock(dir)).toBe("live"); // young
    age(lockPath(dir), OLD_CORRUPT);
    expect(checkLock(dir)).toBe("corrupt");
    const release = acquireLock(dir);
    expect(readLock(dir)).toMatchObject({ pid: process.pid });
    release();
  });

  it("huge but valid live lock (padded with 10 MB whitespace) is still live", () => {
    const dir = tmp();
    writeLock(dir, " ".repeat(10 * 1024 * 1024) + JSON.stringify(liveLock(liveOther())));
    expect(checkLock(dir)).toBe("live");
    expect(() => acquireLock(dir)).toThrow(LockHeldError);
  });

  it("lock path is a directory: unreadable => live (fail closed): startup refuses, CLI exits 4, dir untouched", () => {
    const dir = tmp();
    mkdirSync(lockPath(dir));
    writeFileSync(path.join(lockPath(dir), "keep"), "x");
    age(lockPath(dir), OLD_HEARTBEAT);
    expect(checkLock(dir)).toBe("live");
    expect(() => acquireLock(dir)).toThrow(LockHeldError);
    expect(readFileSync(path.join(lockPath(dir), "keep"), "utf8")).toBe("x");
    const store = seedStore(dir);
    const r = runCli(["--force"], cliEnv(dir));
    expect(r.code).toBe(4);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    noSecrets(r.out);
  });

  // POSIX-only: creating a symlink on Windows needs admin rights or Developer Mode (EPERM otherwise).
  it.skipIf(IS_WIN)("symlink lock -> file holding a LIVE lock: startup refuses, CLI exits 4, target untouched", () => {
    const dir = tmp();
    const target = path.join(tmp(), "elsewhere.json");
    const live = JSON.stringify(liveLock(liveOther()));
    writeFileSync(target, live);
    symlinkSync(target, lockPath(dir));
    expect(() => acquireLock(dir)).toThrow(LockHeldError);
    const store = seedStore(dir);
    const r = runCli(["--force"], cliEnv(dir));
    expect(r.code).toBe(4);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    expect(readFileSync(target, "utf8")).toBe(live);
  });

  // POSIX-only: creating a symlink on Windows needs admin rights or Developer Mode (EPERM otherwise).
  it.skipIf(IS_WIN)("symlink lock -> victim file with stale content: only the link is replaced, the victim is never written", () => {
    const dir = tmp();
    const victim = path.join(tmp(), "victim.txt");
    const stale = JSON.stringify({ pid: deadPid(), startedAt: "x", hostname: HOST });
    writeFileSync(victim, stale);
    symlinkSync(victim, lockPath(dir));
    const release = acquireLock(dir);
    expect(lstatSync(lockPath(dir)).isSymbolicLink()).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe(stale);
    release();
  });

  // POSIX-only: creating a symlink on Windows needs admin rights or Developer Mode (EPERM otherwise).
  it.skipIf(IS_WIN)("dangling symlink lock: startup fails closed (no write-through to the target); CLI sees 'missing'", () => {
    const dir = tmp();
    const target = path.join(tmp(), "should-not-be-created");
    symlinkSync(target, lockPath(dir));
    let err: unknown;
    try { acquireLock(dir); } catch (e) { err = e; }
    // Current behaviour: readLock says "missing" (existsSync follows the link) but link() gets EEXIST,
    // so after the retries it throws "could not acquire". Safe, but the operator message is unhelpful.
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/could not acquire/);
    expect(existsSync(target)).toBe(false);
    expect(checkLock(dir)).toBe("missing");
  });

  // POSIX-only on Windows too: chmod 0o000 only sets the read-only attribute there; the file stays readable.
  it.skipIf(IS_ROOT || IS_WIN)("unreadable lock file (mode 000) is live (fail closed): startup refuses, CLI exits 4", () => {
    const dir = tmp();
    writeLock(dir, { pid: deadPid(), startedAt: "x", hostname: HOST }); // even dead content: we cannot know
    chmodSync(lockPath(dir), 0o000);
    age(lockPath(dir), OLD_HEARTBEAT);
    expect(checkLock(dir)).toBe("live");
    expect(() => acquireLock(dir)).toThrow(LockHeldError);
    expect(existsSync(lockPath(dir))).toBe(true);
    const store = seedStore(dir);
    expect(runCli(["--force"], cliEnv(dir)).code).toBe(4);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
  });
});

// ---------------------------------------------------------------- stale detection

describe("stale detection", () => {
  // POSIX-only: process start time comes from /proc/<pid>/stat (Linux).
  it.skipIf(IS_WIN)("live pid with matching start time => live; with a different start time => stale (pid reuse)", () => {
    const pid = liveOther();
    const ps = procStartOf(pid);
    expect(classify({ pid, startedAt: "x", hostname: HOST, procStart: ps })).toBe("live");
    expect(classify({ pid, startedAt: "x", hostname: HOST, procStart: String(Number(ps) + 1) })).toBe("stale");
    expect(classify({ pid, startedAt: "x", hostname: HOST, procStart: "garbage" })).toBe("stale");
  });

  it("live pid without procStart (older lock) => live", () => {
    expect(classify({ pid: liveOther(), startedAt: "x", hostname: HOST })).toBe("live");
  });

  it("pid === own pid => stale (previous incarnation, e.g. pid 1 in a restarted container)", () => {
    expect(classify({ pid: process.pid, startedAt: "x", hostname: HOST, procStart: procStartIfAny(process.pid) })).toBe("stale");
    expect(classify({ pid: 1, startedAt: "x", hostname: "c1" }, { pid: 1, hostname: "c1" })).toBe("stale");
    const dir = tmp();
    writeLock(dir, { pid: process.pid, startedAt: "x", hostname: HOST });
    const logs: string[] = [];
    const release = acquireLock(dir, (m) => logs.push(m));
    expect(logs.join()).toMatch(/replacing stale.*stale/);
    release();
  });

  it("dead pid => stale; startup replaces it and logs", () => {
    const dir = tmp();
    writeLock(dir, { pid: deadPid(), startedAt: "x", hostname: HOST });
    expect(checkLock(dir)).toBe("stale");
    const logs: string[] = [];
    const release = acquireLock(dir, (m) => logs.push(m));
    expect(logs.join()).toMatch(/replacing stale/);
    expect(readLock(dir)).toMatchObject({ pid: process.pid });
    release();
  });

  it("foreign hostname with a fresh heartbeat => LIVE: startup refuses even if the pid means nothing here", () => {
    const dir = tmp();
    writeLock(dir, { pid: deadPid(), startedAt: "x", hostname: "other-container-abc" });
    expect(checkLock(dir)).toBe("live");
    expect(() => acquireLock(dir)).toThrow(/already running.*other-container-abc.*heartbeat \d+s ago/);
    age(lockPath(dir), LIVE_WINDOW_MS - 3000);
    expect(checkLock(dir)).toBe("live");
  });

  it("foreign hostname with a heartbeat older than LIVE_WINDOW_MS => stale: replaced on start, logged with the host", () => {
    const dir = tmp();
    writeLock(dir, { pid: liveOther(), startedAt: "x", hostname: "other-container-abc" }); // pid alive here: irrelevant
    age(lockPath(dir), OLD_HEARTBEAT);
    expect(checkLock(dir)).toBe("stale");
    const logs: string[] = [];
    const release = acquireLock(dir, (m) => logs.push(m));
    expect(logs.join()).toMatch(/replacing stale.*other-container-abc/);
    expect(readLock(dir)).toMatchObject({ pid: process.pid, hostname: HOST });
    release();
  });

  // POSIX-only: on Linux pid reuse is caught by the /proc start time, so the heartbeat is ignored for same-host locks.
  // Windows has no start time, so there a live pid with an old heartbeat is stale (see the win32 variant below).
  it.skipIf(IS_WIN)("same-host locks ignore the heartbeat: a dead pid with a fresh mtime is stale, a live pid with an old mtime is live", () => {
    const d1 = tmp();
    writeLock(d1, { pid: deadPid(), startedAt: "x", hostname: HOST });
    expect(checkLock(d1)).toBe("stale");
    const d2 = tmp();
    writeLock(d2, liveLock(liveOther()));
    age(lockPath(d2), 10 * LIVE_WINDOW_MS);
    expect(checkLock(d2)).toBe("live");
  });

  // win32-only (TM2-49 S2): no start time on Windows, so a live pid counts only while its heartbeat is fresh.
  it.runIf(IS_WIN)("win32: same-host dead pid is stale; a live pid is live with a fresh heartbeat, stale (and replaced) once older than the window", () => {
    const d1 = tmp();
    writeLock(d1, { pid: deadPid(), startedAt: "x", hostname: HOST });
    expect(checkLock(d1)).toBe("stale");
    const d2 = tmp();
    writeLock(d2, liveLock(liveOther()));
    expect(checkLock(d2)).toBe("live");
    expect(() => acquireLock(d2)).toThrow(LockHeldError);
    age(lockPath(d2), LIVE_WINDOW_MS + 1000);
    expect(checkLock(d2)).toBe("stale");
    const logs: string[] = [];
    const release = acquireLock(d2, (m) => logs.push(m));
    expect(logs.join()).toMatch(/replacing stale/);
    expect(readLock(d2)).toMatchObject({ pid: process.pid });
    release();
  });

  // POSIX-only: asserts the /proc start time (Linux).
  it.skipIf(IS_WIN)("written lock carries pid, ISO startedAt, hostname and this process's /proc start time", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    const l = readLock(dir) as unknown as Record<string, unknown>;
    expect(l.pid).toBe(process.pid);
    expect(l.hostname).toBe(HOST);
    expect(new Date(String(l.startedAt)).toISOString()).toBe(l.startedAt);
    expect(l.procStart).toBe(procStartOf(process.pid));
    expect(checkLock(dir)).toBe("stale"); // from our own point of view it is our pid
    release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });
});

// ---------------------------------------------------------------- revoke-cli

describe("revoke-cli vs the lock", () => {
  it("live lock + --force => exit 4, store byte-identical, lock untouched, no secrets", () => {
    const dir = tmp();
    const store = seedStore(dir);
    const lock = JSON.stringify(liveLock(liveOther()));
    writeLock(dir, lock);
    const r = runCli(["--force"], cliEnv(dir));
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/trade-mcp is running \(lock heartbeat \d+s ago\); stop it first, then wait 15 s/);
    expect(r.out).toMatch(/--force does not override/);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(lock);
    noSecrets(r.out);
  });

  it("live lock without --force, or with unknown args => exit 4 (lock checked first), store byte-identical", () => {
    const dir = tmp();
    const store = seedStore(dir);
    writeLock(dir, liveLock(liveOther()));
    for (const argv of [[], ["--bogus"], ["--force", "--bogus"]]) {
      const r = runCli(argv, cliEnv(dir));
      expect(r.code, JSON.stringify(argv)).toBe(4);
      expect(r.out).toMatch(/trade-mcp is running \(lock heartbeat/);
      noSecrets(r.out);
    }
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
  });

  it("no lock: without --force still exit 2", () => {
    expect(runCli([], cliEnv(tmp())).code).toBe(2);
  });

  it("live lock + --force + store missing => still exit 4 (lock checked first)", () => {
    const dir = tmp();
    writeLock(dir, liveLock(liveOther()));
    expect(runCli(["--force"], cliEnv(dir)).code).toBe(4);
    expect(existsSync(path.join(dir, "oauth.json"))).toBe(false);
  });

  it("live lock with a corrupt store => 4, not 1 (the store is not even read)", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "oauth.json"), "{corrupt");
    writeLock(dir, liveLock(liveOther()));
    expect(runCli(["--force"], cliEnv(dir)).code).toBe(4);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe("{corrupt");
  });

  it("stale lock (dead pid / own pid / reused pid) => proceeds and revokes, with a note", () => {
    const other = liveOther();
    for (const l of [
      { pid: deadPid(), startedAt: "x", hostname: HOST },
      { pid: process.pid, startedAt: "x", hostname: HOST },
      // Reused pid (live pid, wrong start time) is detectable only via /proc start time: POSIX-only case.
      ...(IS_WIN ? [] : [{ pid: other, startedAt: "x", hostname: HOST, procStart: "1" }]),
    ]) {
      const dir = tmp();
      seedStore(dir);
      writeLock(dir, l);
      const r = runCli(["--force"], cliEnv(dir));
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Note: ignoring stale/);
      expect(r.out).toMatch(/revoked 1 access, 1 refresh/);
      noSecrets(r.out);
    }
  });

  it("foreign lock: fresh heartbeat => exit 4; heartbeat older than the window => proceeds with a stale note", () => {
    const dir = tmp();
    const store = seedStore(dir);
    writeLock(dir, { pid: liveOther(), startedAt: "x", hostname: "other-container-abc" });
    const r1 = runCli(["--force"], cliEnv(dir));
    expect(r1.code).toBe(4);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    age(lockPath(dir), OLD_HEARTBEAT);
    const r2 = runCli(["--force"], cliEnv(dir));
    expect(r2.code).toBe(0);
    expect(r2.out).toMatch(/Note: ignoring stale/);
    expect(r2.out).toMatch(/revoked 1 access, 1 refresh/);
    noSecrets(r1.out + r2.out);
  });

  it("corrupt lock: young => exit 4; old => proceeds with a corrupt note", () => {
    const dir = tmp();
    seedStore(dir);
    writeLock(dir, "{x");
    expect(runCli(["--force"], cliEnv(dir)).code).toBe(4);
    age(lockPath(dir), OLD_CORRUPT);
    const r = runCli(["--force"], cliEnv(dir));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Note: ignoring corrupt/);
  });

  it("missing lock => proceeds silently about the lock", () => {
    const dir = tmp();
    seedStore(dir);
    const r = runCli(["--force"], cliEnv(dir));
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/lock/i);
    noSecrets(r.out);
  });

  it("does not create, modify or remove the lock in any case", () => {
    for (const l of [undefined, "{x", { pid: deadPid(), startedAt: "x", hostname: HOST }, { pid: 2, startedAt: "x", hostname: "far" }]) {
      const dir = tmp();
      seedStore(dir);
      if (l !== undefined) writeLock(dir, l);
      const before = existsSync(lockPath(dir)) ? readFileSync(lockPath(dir), "utf8") : undefined;
      runCli(["--force"], cliEnv(dir));
      const after = existsSync(lockPath(dir)) ? readFileSync(lockPath(dir), "utf8") : undefined;
      expect(after).toBe(before);
    }
  });

  it("real CLI process: exit code 4 via process.exit on a live lock; store byte-identical; no secrets", () => {
    const dir = tmp();
    const store = seedStore(dir);
    writeLock(dir, liveLock(liveOther()));
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI_TS, "--force"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, ...cliEnv(dir) },
    });
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/trade-mcp is running \(lock heartbeat \d+s ago\); stop it first/);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    noSecrets(r.stdout + r.stderr);
  });
});

// ---------------------------------------------------------------- real trade-mcp process

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
}
const portOpen = (port: number) =>
  new Promise<boolean>((r) => {
    const c = connect(port, "127.0.0.1");
    c.on("connect", () => { c.destroy(); r(true); });
    c.on("error", () => r(false));
  });

function startServer(dir: string, port: number) {
  const p = spawn(process.execPath, ["--import", "tsx", INDEX_TS], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_DIR: dir, PORT: String(port), HOST: "127.0.0.1", MODE: "paper",
      OPENALGO_URL: "http://127.0.0.1:9", OPENALGO_API_KEY: FAKE_API_KEY, MCP_TOKEN: FAKE_MCP_TOKEN,
      OAUTH_PASSWORD_HASH: "", OAUTH_ISSUER_URL: "",
    },
  });
  procs.push(p);
  let out = "";
  p.stdout!.on("data", (c) => (out += c));
  p.stderr!.on("data", (c) => (out += c));
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => p.on("exit", (code, signal) => r({ code, signal })));
  const started = new Promise<boolean>((r) => {
    const t = setInterval(() => {
      if (/trade-mcp started/.test(out)) { clearInterval(t); r(true); }
      else if (p.exitCode !== null || p.signalCode !== null) { clearInterval(t); r(false); }
    }, 25);
  });
  return { p, exited, started, out: () => out };
}

describe("real trade-mcp process", () => {
  // POSIX-only: needs /proc start time and a graceful SIGTERM/SIGINT shutdown; on Windows kill() terminates outright.
  it.skipIf(IS_WIN)("second instance refuses without binding; SIGTERM removes the lock; SIGKILL leaves it and the next start replaces it", async () => {
    const dir = tmp();
    const [pa, pb, pc, pd] = [await freePort(), await freePort(), await freePort(), await freePort()];

    const a = startServer(dir, pa);
    expect(await a.started, a.out()).toBe(true);
    expect(readLock(dir)).toMatchObject({ pid: a.p.pid, hostname: HOST, procStart: procStartOf(a.p.pid!) });
    const lockA = readFileSync(lockPath(dir), "utf8");

    // Heartbeat: backdate the mtime; the running server refreshes it within HEARTBEAT_MS.
    age(lockPath(dir), 60_000);
    const hbDeadline = Date.now() + HEARTBEAT_MS + 4000;
    while (ageMsOf(lockPath(dir)) > 10_000 && Date.now() < hbDeadline) await new Promise((r) => setTimeout(r, 100));
    expect(ageMsOf(lockPath(dir))).toBeLessThan(HEARTBEAT_MS + 1000);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(lockA); // heartbeat touches mtime only

    // CLI against the live server, as a real process
    seedStore(dir);
    const storeBefore = readFileSync(path.join(dir, "oauth.json"), "utf8");
    const cli = spawnSync(process.execPath, ["--import", "tsx", CLI_TS, "--force"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, ...cliEnv(dir) },
    });
    expect(cli.status).toBe(4);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(storeBefore);

    const b = startServer(dir, pb);
    const eb = await b.exited;
    expect(eb.code).not.toBe(0);
    expect(eb.code).not.toBeNull();
    expect(b.out()).toMatch(/already running on this DATA_DIR/);
    expect(b.out()).not.toMatch(/trade-mcp started/);
    expect(await portOpen(pb)).toBe(false);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(lockA); // loser did not touch it
    noSecrets(b.out());

    a.p.kill("SIGTERM");
    expect((await a.exited).code).toBe(0);
    expect(existsSync(lockPath(dir))).toBe(false);

    // Same host: a SIGKILLed server's pid is dead, so its lock is stale immediately (no 15 s wait).
    const c = startServer(dir, pc);
    expect(await c.started, c.out()).toBe(true);
    c.p.kill("SIGKILL");
    await c.exited;
    expect(readLock(dir)).toMatchObject({ pid: c.p.pid });
    expect(checkLock(dir)).toBe("stale");

    const d = startServer(dir, pd);
    expect(await d.started, d.out()).toBe(true);
    expect(d.out()).toMatch(/replacing stale trade-mcp\.lock/);
    expect(readLock(dir)).toMatchObject({ pid: d.p.pid });
    expect(await portOpen(pd)).toBe(true);
    d.p.kill("SIGINT");
    expect((await d.exited).code).toBe(0);
    expect(existsSync(lockPath(dir))).toBe(false);
    noSecrets(a.out() + c.out() + d.out());
  });

  // POSIX-only: ends with a graceful SIGTERM shutdown (exit 0, lock removed); on Windows kill() terminates outright.
  it.skipIf(IS_WIN)("SIGKILLed server seen from another hostname: LIVE (start refused) while its heartbeat is < 15 s, then replaced", async () => {
    const dir = tmp();
    const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
    const a = startServer(dir, p1);
    expect(await a.started, a.out()).toBe(true);
    a.p.kill("SIGKILL");
    await a.exited;
    // Simulate the view from a different container: same lock, other hostname, fresh heartbeat.
    const l = readLock(dir) as unknown as Record<string, unknown>;
    expect(l.pid).toBe(a.p.pid);
    writeLock(dir, { ...l, hostname: "crashed-container-1" });
    age(lockPath(dir), LIVE_WINDOW_MS - 5000);
    const b = startServer(dir, p2);
    const eb = await b.exited;
    expect(eb.code).toBe(1);
    expect(b.out()).toMatch(/already running on this DATA_DIR.*crashed-container-1.*After a crash, wait up to 15s/);
    expect(await portOpen(p2)).toBe(false);
    expect(readLock(dir)).toMatchObject({ hostname: "crashed-container-1" });
    // The CLI also refuses during the window.
    const cli = spawnSync(process.execPath, ["--import", "tsx", CLI_TS, "--force"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, ...cliEnv(dir) },
    });
    expect(cli.status).toBe(4);
    // Past the window: replaced.
    age(lockPath(dir), OLD_HEARTBEAT);
    const c = startServer(dir, p3);
    expect(await c.started, c.out()).toBe(true);
    expect(c.out()).toMatch(/replacing stale trade-mcp\.lock.*crashed-container-1/);
    expect(readLock(dir)).toMatchObject({ pid: c.p.pid, hostname: HOST });
    c.p.kill("SIGTERM");
    expect((await c.exited).code).toBe(0);
    expect(existsSync(lockPath(dir))).toBe(false);
    expect(leftovers(dir)).toEqual([]);
    noSecrets(a.out() + b.out() + c.out() + cli.stdout + cli.stderr);
  });

  it("listen failure (port already in use) after the lock is taken does not leave the lock behind", async () => {
    const dir = tmp();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const s = startServer(dir, port);
      const e = await s.exited;
      expect(e.code).not.toBe(0);
      expect(existsSync(lockPath(dir))).toBe(false);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

// ---------------------------------------------------------------- DATA_DIR not writable

// POSIX-only on Windows too: chmod 0o555 does not make a directory read-only there.
describe.skipIf(IS_ROOT || IS_WIN)("DATA_DIR not writable (behaviour change vs main)", () => {
  // On main (no lock) trade-mcp starts and binds with a read-only DATA_DIR (writes fail later, per request).
  // Now startup fails fast: LockUnwritableError => "fatal: cannot create <lock>: EACCES; ..." exit 1, port not bound.
  it("acquireLock throws EACCES (not LockHeldError) and writes nothing", () => {
    const dir = tmp();
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    let err: unknown;
    try { acquireLock(dir); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LockUnwritableError);
    expect((err as LockUnwritableError).code).toBe("EACCES");
    expect((err as Error).message).toMatch(/^cannot create .*trade-mcp\.lock: EACCES; audit and risk-state need a writable DATA_DIR/);
    expect(err).not.toBeInstanceOf(LockHeldError);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("missing DATA_DIR under a read-only parent => mkdir EACCES", () => {
    const parent = tmp();
    chmodSync(parent, 0o555);
    roDirs.push(parent);
    expect(() => acquireLock(path.join(parent, "data"))).toThrow(LockUnwritableError);
    expect(() => acquireLock(path.join(parent, "data"))).toThrow(/cannot create .*: EACCES/);
  });

  it("real process: exits 1 with a fatal EACCES message and does not bind the port", async () => {
    const dir = tmp();
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    const port = await freePort();
    const s = startServer(dir, port);
    const e = await s.exited;
    expect(e.code).toBe(1);
    expect(s.out()).toMatch(/fatal: cannot create .*trade-mcp\.lock: EACCES; audit and risk-state need a writable DATA_DIR/);
    expect(s.out()).not.toMatch(/trade-mcp started/);
    expect(await portOpen(port)).toBe(false);
    noSecrets(s.out());
  });

  it("CLI with a read-only DATA_DIR and a live lock still exits 4 (lock check needs only read access)", () => {
    const dir = tmp();
    seedStore(dir);
    writeLock(dir, liveLock(liveOther()));
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    expect(runCli(["--force"], cliEnv(dir)).code).toBe(4);
  });
});

// ---------------------------------------------------------------- heartbeat (unit)

describe("heartbeat", () => {
  it("refreshes our lock's mtime every HEARTBEAT_MS; stops refreshing after stop()", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    age(lockPath(dir), 60_000);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stop = startHeartbeat(dir);
    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    expect(ageMsOf(lockPath(dir))).toBeGreaterThan(50_000); // not yet
    vi.advanceTimersByTime(1);
    expect(ageMsOf(lockPath(dir))).toBeLessThan(2000);
    age(lockPath(dir), 60_000);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(ageMsOf(lockPath(dir))).toBeLessThan(2000);
    stop();
    age(lockPath(dir), 60_000);
    vi.advanceTimersByTime(5 * HEARTBEAT_MS);
    expect(ageMsOf(lockPath(dir))).toBeGreaterThan(50_000);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    release();
  });

  it("the interval timer is unref()'d (does not keep the process alive)", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    const spy = vi.spyOn(globalThis, "setInterval");
    const stop = startHeartbeat(dir);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(HEARTBEAT_MS);
    const t = spy.mock.results[0].value as NodeJS.Timeout;
    expect(t.hasRef()).toBe(false);
    stop();
    release();
  });

  it("never touches a lock another process now owns, never recreates a deleted lock, never throws", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    const logs: string[] = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stop = startHeartbeat(dir, (m) => logs.push(m));
    const other = liveLock(liveOther());
    writeLock(dir, other);
    age(lockPath(dir), 60_000);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(ageMsOf(lockPath(dir))).toBeGreaterThan(50_000);
    expect(readLock(dir)).toEqual(other);
    unlinkSync(lockPath(dir));
    expect(() => vi.advanceTimersByTime(HEARTBEAT_MS)).not.toThrow();
    expect(existsSync(lockPath(dir))).toBe(false);
    stop();
    vi.useRealTimers();
    release();
  });

  it("a crashed foreign server stops heartbeating: its lock goes live -> stale exactly at LIVE_WINDOW_MS", () => {
    const dir = tmp();
    writeLock(dir, { pid: 4242, startedAt: "x", hostname: "gone-container" });
    age(lockPath(dir), LIVE_WINDOW_MS - 1000);
    expect(checkLock(dir)).toBe("live");
    age(lockPath(dir), LIVE_WINDOW_MS + 1000);
    expect(checkLock(dir)).toBe("stale");
    expect(classify({ pid: 4242, startedAt: "x", hostname: "gone-container" }, undefined, LIVE_WINDOW_MS - 1)).toBe("live");
    expect(classify({ pid: 4242, startedAt: "x", hostname: "gone-container" }, undefined, LIVE_WINDOW_MS)).toBe("stale");
    expect(classify({ pid: 4242, startedAt: "x", hostname: "gone-container" })).toBe("stale"); // unknown age = old
  });
});
