// TM2-46 edge tests (independent): DATA_DIR/trade-mcp.lock and the revoke-cli live-lock refusal.
// Temp dirs and fake values only. Real-process tests spawn `node --import tsx` (one process, so the
// child pid is the pid written into the lock).
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

vi.setConfig({ testTimeout: 90_000 });

// Deterministic interleaving hooks: run "another process" exactly before this process's unlink/write.
const hook = vi.hoisted(() => ({
  beforeUnlink: null as null | ((p: string) => void),
  beforeWrite: null as null | (() => void),
}));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const unlinkSync = (p: import("node:fs").PathLike) => {
    const h = hook.beforeUnlink;
    if (h) { hook.beforeUnlink = null; h(String(p)); }
    return real.unlinkSync(p);
  };
  const writeSync = ((...a: unknown[]) => {
    const h = hook.beforeWrite;
    if (h) { hook.beforeWrite = null; h(); }
    return (real.writeSync as (...x: unknown[]) => number)(...a);
  }) as typeof real.writeSync;
  return { ...real, default: { ...real, unlinkSync, writeSync }, unlinkSync, writeSync };
});

import { acquireLock, checkLock, classify, readLock, lockPath, LockHeldError, LOCK_NAME } from "../src/datadir-lock.js";
import { run } from "../src/oauth/revoke-cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_TS = path.join(ROOT, "src/datadir-lock.ts");
const INDEX_TS = path.join(ROOT, "src/index.ts");
const CLI_TS = path.join(ROOT, "src/oauth/revoke-cli.ts");
const HOST = hostname();
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

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
  hook.beforeUnlink = null;
  hook.beforeWrite = null;
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
/** A live process on this host that is not us. */
function liveOther(): number {
  const p = spawn("sleep", ["120"], { stdio: "ignore" });
  procs.push(p);
  return p.pid!;
}
/** A pid that is very likely dead (a child that already exited). */
function deadPid(): number {
  const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}
const writeLock = (dir: string, v: unknown) =>
  writeFileSync(lockPath(dir), typeof v === "string" ? v : JSON.stringify(v));
const liveLock = (pid: number) => ({ pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: HOST, procStart: procStartOf(pid) });

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

  // BUG (TOCTOU): acquireLock classifies the stale lock, then unlinks the path without re-checking.
  // If another process replaced the stale lock in between, its fresh live lock is deleted and both start.
  it("deterministic: a stale lock replaced by a rival between our read and our unlink must not let both win", () => {
    const dir = tmp();
    writeLock(dir, { pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z", hostname: HOST });
    const rival = liveLock(liveOther());
    hook.beforeUnlink = (p) => {
      // The rival saw the same stale lock, was faster: unlinked it and created its own.
      unlinkSync(p);
      writeFileSync(p, JSON.stringify(rival), { flag: "wx" });
    };
    let release: (() => void) | undefined;
    let err: unknown;
    try { release = acquireLock(dir); } catch (e) { err = e; }
    const onDisk = readLock(dir);
    // Exactly one may hold it: either we refused, or the rival's lock is gone because the rival never existed.
    expect(err, "both processes believe they hold the lock").toBeInstanceOf(LockHeldError);
    expect(onDisk).toMatchObject({ pid: rival.pid });
    release?.();
  });

  // BUG (half-written lock): the winner creates the file with O_EXCL and writes JSON afterwards. A rival
  // that reads in between sees an empty file, classifies it "corrupt", deletes it and creates its own.
  it("deterministic: a rival that sees our lock while it is still empty must not delete it", () => {
    const dir = tmp();
    const rival = liveLock(liveOther());
    hook.beforeWrite = () => {
      // Rival: EEXIST on create, reads the (still empty) file, classifies it, replaces it.
      const st = checkLock(dir);
      if (st !== "live" && st !== "missing") {
        unlinkSync(lockPath(dir));
        writeFileSync(lockPath(dir), JSON.stringify(rival), { flag: "wx" });
      }
    };
    let release: (() => void) | undefined;
    try { release = acquireLock(dir); } catch { /* refusing would also be fine */ }
    // If acquireLock returned, the lock on disk must be ours; otherwise two servers run.
    if (release) expect(readLock(dir), "both processes believe they hold the lock").toMatchObject({ pid: process.pid });
    release?.();
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
    it(`${name}: never live; startup replaces it; CLI proceeds; nothing throws`, () => {
      const dir = tmp();
      writeLock(dir, content);
      expect(checkLock(dir)).toBe("corrupt");
      const logs: string[] = [];
      const release = acquireLock(dir, (m) => logs.push(m));
      expect(readLock(dir)).toMatchObject({ pid: process.pid, hostname: HOST });
      expect(logs.join("\n")).toMatch(/replacing stale/);
      release();
      writeLock(dir, content);
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

  it("lock path is a directory: startup fails closed with a plain Error (no hang, dir untouched); CLI treats it as corrupt", () => {
    const dir = tmp();
    mkdirSync(lockPath(dir));
    writeFileSync(path.join(lockPath(dir), "keep"), "x");
    expect(checkLock(dir)).toBe("corrupt");
    let err: unknown;
    try { acquireLock(dir); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LockHeldError);
    expect(String((err as Error).message)).toMatch(/could not acquire/);
    expect(readFileSync(path.join(lockPath(dir), "keep"), "utf8")).toBe("x");
    seedStore(dir);
    const r = runCli(["--force"], cliEnv(dir));
    expect(r.code).toBe(0);
    noSecrets(r.out);
  });

  it("symlink lock -> file holding a LIVE lock: startup refuses, CLI exits 4, target untouched", () => {
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

  it("symlink lock -> victim file with stale content: only the link is replaced, the victim is never written", () => {
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

  it("dangling symlink lock: startup fails closed (no write-through to the target); CLI sees 'missing'", () => {
    const dir = tmp();
    const target = path.join(tmp(), "should-not-be-created");
    symlinkSync(target, lockPath(dir));
    let err: unknown;
    try { acquireLock(dir); } catch (e) { err = e; }
    // Current behaviour: classify says "missing" (existsSync follows the link) but O_EXCL gets EEXIST,
    // so after 5 attempts it throws "could not acquire". Safe, but the operator message is unhelpful.
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/could not acquire/);
    expect(existsSync(target)).toBe(false);
    expect(checkLock(dir)).toBe("missing");
  });

  it.skipIf(IS_ROOT)("unreadable lock file (mode 000) is classified corrupt: fails OPEN (documented, low risk)", () => {
    const dir = tmp();
    writeLock(dir, liveLock(liveOther()));
    chmodSync(lockPath(dir), 0o000);
    // Current behaviour: EACCES on read => "corrupt" => startup deletes it and the CLI proceeds,
    // even though the holder may be live. Only reachable if server and CLI run as different users.
    expect(checkLock(dir)).toBe("corrupt");
    const release = acquireLock(dir);
    expect(readLock(dir)).toMatchObject({ pid: process.pid });
    release();
  });
});

// ---------------------------------------------------------------- stale detection

describe("stale detection", () => {
  it("live pid with matching start time => live; with a different start time => stale (pid reuse)", () => {
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
    expect(classify({ pid: process.pid, startedAt: "x", hostname: HOST, procStart: procStartOf(process.pid) })).toBe("stale");
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

  it("foreign hostname => replaced on start (logged with the hostname) even if the pid is alive here", () => {
    const dir = tmp();
    writeLock(dir, { pid: liveOther(), startedAt: "x", hostname: "other-container-abc" });
    expect(checkLock(dir)).toBe("foreign");
    const logs: string[] = [];
    const release = acquireLock(dir, (m) => logs.push(m));
    expect(logs.join()).toMatch(/other-container-abc/);
    expect(readLock(dir)).toMatchObject({ pid: process.pid, hostname: HOST });
    release();
  });

  it("written lock carries pid, ISO startedAt, hostname and this process's /proc start time", () => {
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
    expect(r.out).toMatch(/trade-mcp is running; stop it first/);
    expect(r.out).toMatch(/--force does not override/);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(lock);
    noSecrets(r.out);
  });

  it("live lock without --force => refused (usage exit 2, before the lock check), store byte-identical", () => {
    // Note: this is exit 2, not 4: the no---force refusal precedes the lock check. Either way nothing changes.
    const dir = tmp();
    const store = seedStore(dir);
    writeLock(dir, liveLock(liveOther()));
    const r = runCli([], cliEnv(dir));
    expect(r.code).toBe(2);
    expect(readFileSync(path.join(dir, "oauth.json"), "utf8")).toBe(store);
    noSecrets(r.out);
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
      { pid: other, startedAt: "x", hostname: HOST, procStart: "1" },
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

  it("foreign lock => proceeds with a warning naming the host", () => {
    const dir = tmp();
    seedStore(dir);
    writeLock(dir, { pid: liveOther(), startedAt: "x", hostname: "other-container-abc" });
    const r = runCli(["--force"], cliEnv(dir));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Warning: .*another container \(other-container-abc\)/);
    expect(r.out).toMatch(/revoked 1 access, 1 refresh/);
    noSecrets(r.out);
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
    expect(r.stderr).toMatch(/trade-mcp is running; stop it first/);
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
  it("second instance refuses without binding; SIGTERM removes the lock; SIGKILL leaves it and the next start replaces it", async () => {
    const dir = tmp();
    const [pa, pb, pc, pd] = [await freePort(), await freePort(), await freePort(), await freePort()];

    const a = startServer(dir, pa);
    expect(await a.started, a.out()).toBe(true);
    expect(readLock(dir)).toMatchObject({ pid: a.p.pid, hostname: HOST, procStart: procStartOf(a.p.pid!) });
    const lockA = readFileSync(lockPath(dir), "utf8");

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

describe.skipIf(IS_ROOT)("DATA_DIR not writable (behaviour change vs main)", () => {
  // On main (no lock) trade-mcp starts and binds with a read-only DATA_DIR (writes fail later, per request).
  // Now startup fails fast: acquireLock's O_EXCL create throws EACCES => "fatal: EACCES ..." exit 1, port not bound.
  it("acquireLock throws EACCES (not LockHeldError) and writes nothing", () => {
    const dir = tmp();
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    let err: unknown;
    try { acquireLock(dir); } catch (e) { err = e; }
    expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
    expect(err).not.toBeInstanceOf(LockHeldError);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("missing DATA_DIR under a read-only parent => mkdir EACCES", () => {
    const parent = tmp();
    chmodSync(parent, 0o555);
    roDirs.push(parent);
    expect(() => acquireLock(path.join(parent, "data"))).toThrow(/EACCES/);
  });

  it("real process: exits 1 with a fatal EACCES message and does not bind the port", async () => {
    const dir = tmp();
    chmodSync(dir, 0o555);
    roDirs.push(dir);
    const port = await freePort();
    const s = startServer(dir, port);
    const e = await s.exited;
    expect(e.code).toBe(1);
    expect(s.out()).toMatch(/fatal: EACCES/);
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
