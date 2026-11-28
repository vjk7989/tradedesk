// Exclusive DATA_DIR lock so the OAuth revoke CLI cannot run against a live trade-mcp.
// Lock file: DATA_DIR/trade-mcp.lock = JSON {pid, startedAt, hostname, procStart?}.
import { closeSync, existsSync, linkSync, openSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import path from "node:path";

export const LOCK_NAME = "trade-mcp.lock";
/** The server refreshes the lock mtime this often. */
export const HEARTBEAT_MS = 5000;
/** A lock whose mtime is younger than this is live regardless of hostname/pid. */
export const LIVE_WINDOW_MS = 15000;
/** An empty/unparseable lock younger than this is assumed to be mid-write (live). */
export const YOUNG_CORRUPT_MS = 5000;

export interface LockInfo {
  pid: number;
  startedAt: string;
  hostname: string;
  /** Kernel start time of the process (Linux /proc, clock ticks); defeats pid reuse. */
  procStart?: string;
}

/** live: fresh heartbeat, a live same-host pid, an unreadable lock, or a young unparseable lock.
 *  stale: heartbeat older than LIVE_WINDOW_MS (foreign host, or same-host live pid on a non-Linux platform), or same-host dead/reused/own pid. "foreign" is no longer returned. */
export type LockState = "missing" | "live" | "stale" | "foreign" | "corrupt";

export const lockPath = (dataDir: string) => path.join(dataDir, LOCK_NAME);

function procStart(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined; // unverifiable elsewhere; never "different"
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]; // field 22 (starttime)
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(dataDir: string): LockInfo | "corrupt" | "unreadable" | undefined {
  const f = lockPath(dataDir);
  if (!existsSync(f)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(f, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
  }
  try {
    const j = JSON.parse(raw);
    if (j && Number.isInteger(j.pid) && j.pid > 0 && typeof j.hostname === "string") return j as LockInfo;
  } catch { /* fallthrough */ }
  return "corrupt";
}

/** ageMs = time since the lock file's mtime (heartbeat). Unknown age is treated as old. */
export function classify(
  info: LockInfo | "corrupt" | "unreadable" | undefined,
  self = { pid: process.pid, hostname: osHostname() },
  ageMs = Number.POSITIVE_INFINITY,
): LockState {
  if (info === undefined) return "missing";
  if (info === "unreadable") return "live"; // fail closed
  if (info === "corrupt") return ageMs < YOUNG_CORRUPT_MS ? "live" : "corrupt";
  if (info.hostname !== self.hostname) return ageMs < LIVE_WINDOW_MS ? "live" : "stale";
  if (info.pid === self.pid) return "stale"; // same container, same pid: a previous incarnation (e.g. pid 1 after restart)
  if (!pidAlive(info.pid)) return "stale";
  if (info.procStart) {
    const now = procStart(info.pid);
    if (now !== undefined && now !== info.procStart) return "stale"; // pid reused by an unrelated process
  }
  // Non-Linux (win32, darwin) has no /proc start time to detect pid reuse: a live pid whose heartbeat is stale is a reused pid.
  if (process.platform !== "linux" && Number.isFinite(ageMs) && ageMs >= LIVE_WINDOW_MS) return "stale";
  return "live";
}

function lockAgeMs(dataDir: string): number {
  try {
    return Math.max(0, Date.now() - statSync(lockPath(dataDir)).mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Seconds since the lock heartbeat, or undefined if there is no lock. */
export function lockAgeSeconds(dataDir: string): number | undefined {
  const a = lockAgeMs(dataDir);
  return Number.isFinite(a) ? Math.round(a / 1000) : undefined;
}

export function checkLock(dataDir: string): LockState {
  const info = readLock(dataDir);
  return classify(info, undefined, info === undefined ? undefined : lockAgeMs(dataDir));
}

export class LockHeldError extends Error {}
/** DATA_DIR is not writable (EACCES/EROFS): fail at startup with a clear one-liner. */
export class LockUnwritableError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

const same = (a: LockInfo, b: LockInfo) => a.pid === b.pid && a.startedAt === b.startedAt && a.hostname === b.hostname;
const rand = () => randomBytes(4).toString("hex");

/** Acquire the lock atomically: write a temp file, then link() it to the lock name (exclusive, never half-written).
 *  Stale locks are replaced by renaming them aside and verifying what was renamed.
 *  Throws LockHeldError if live; LockUnwritableError on EACCES/EROFS; on ENOSPC warns and returns a no-op release. */
export function acquireLock(dataDir: string, log: (m: string) => void = () => {}): () => void {
  const f = lockPath(dataDir);
  const mine: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: osHostname(),
    procStart: procStart(process.pid),
  };
  const tmp = `${f}.${process.pid}.${rand()}.tmp`;
  const cleanTmp = () => { try { unlinkSync(tmp); } catch { /* gone */ } };
  try {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(mine), { mode: 0o644 });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
        throw new LockUnwritableError(`cannot create ${f}: ${code}; audit and risk-state need a writable DATA_DIR`, code);
      }
      if (code === "ENOSPC") {
        cleanTmp();
        log(`warning: cannot create ${f}: ENOSPC; running WITHOUT a DATA_DIR lock (oauth:revoke-all will not be protected)`);
        return () => {};
      }
      throw e;
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        linkSync(tmp, f);
        cleanTmp();
        return () => {
          const cur = readLock(dataDir);
          if (cur && cur !== "corrupt" && cur !== "unreadable" && same(cur, mine)) {
            try { unlinkSync(f); } catch { /* already gone */ }
          }
        };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EROFS" || code === "EPERM") throw new LockUnwritableError(`cannot create ${f}: ${code}; audit and risk-state need a writable DATA_DIR`, code);
        if (code === "ENOSPC") { log(`warning: cannot create ${f}: ENOSPC; running WITHOUT a DATA_DIR lock`); return () => {}; }
        if (code !== "EEXIST") throw e;
      }
      const info = readLock(dataDir);
      if (info === undefined) continue; // vanished; retry
      const age = lockAgeMs(dataDir);
      const state = classify(info, undefined, age);
      if (state === "live") {
        const why = typeof info === "object"
          ? `pid ${info.pid}, host ${info.hostname}, since ${info.startedAt}, heartbeat ${Number.isFinite(age) ? Math.round(age / 1000) : "?"}s ago`
          : `lock ${info}`;
        throw new LockHeldError(`trade-mcp already running on this DATA_DIR (${why}); refusing to start. After a crash, wait up to ${LIVE_WINDOW_MS / 1000}s.`);
      }
      if (info === "unreadable") continue; // unreachable (classified live)
      // stale / corrupt: serialise replacers with a short-lived guard, then take it aside atomically and verify.
      if (!takeGuard(f + ".replace")) { sleepMs(15 + Math.random() * 25); continue; }
      try {
      // Re-judge under the guard: only guard holders replace, so nobody can swap the lock after this point.
      const info2 = readLock(dataDir);
      const age2 = lockAgeMs(dataDir);
      const st2 = classify(info2, undefined, age2);
      if (st2 === "missing") continue;
      if (st2 === "live") {
        const why2 = typeof info2 === "object" ? `pid ${info2.pid}, host ${info2.hostname}, since ${info2.startedAt}` : `lock ${info2}`;
        throw new LockHeldError(`trade-mcp already running on this DATA_DIR (${why2}); refusing to start. After a crash, wait up to ${LIVE_WINDOW_MS / 1000}s.`);
      }
      if (info2 === undefined || info2 === "unreadable") continue;
      const aside = `${f}.stale.${process.pid}.${rand()}`;
      try { renameSync(f, aside); } catch { continue; } // raced; re-evaluate
      const taken = readAside(aside);
      const judgedSame = info2 === "corrupt" ? taken === "corrupt" : typeof taken === "object" && same(taken, info2);
      if (!judgedSame) {
        // We moved a rival's fresh lock. Put it back if the path is free, then re-evaluate (we will see it live).
        try { linkSync(aside, f); } catch { /* path taken by someone else; theirs wins */ }
        try { unlinkSync(aside); } catch { /* gone */ }
        continue;
      }
      try { unlinkSync(aside); } catch { /* gone */ }
      log(`replacing stale ${LOCK_NAME} (${info2 === "corrupt" ? "stale: corrupt" : `stale: pid ${info2.pid} host ${info2.hostname}, heartbeat older than ${LIVE_WINDOW_MS / 1000}s or process gone`})`);
      } finally {
        try { unlinkSync(f + ".replace"); } catch { /* gone */ }
      }
    }
    throw new Error(`could not acquire ${f}: lock kept changing; try again`);
  } finally {
    cleanTmp();
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Short-lived guard serialising stale replacement. A guard older than 10 s belongs to a crashed replacer. */
function takeGuard(g: string): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(g, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(g).mtimeMs > 10_000) unlinkSync(g);
        else return false;
      } catch { /* raced */ }
    }
  }
  return false;
}

function readAside(p: string): LockInfo | "corrupt" | "unreadable" {
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j && Number.isInteger(j.pid) && j.pid > 0 && typeof j.hostname === "string") return j as LockInfo;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code) return "unreadable";
  }
  return "corrupt";
}

/** Refresh the lock mtime every HEARTBEAT_MS while we own it. The timer is unref()'d. Returns a stop function. */
export function startHeartbeat(dataDir: string, log: (m: string) => void = () => {}): () => void {
  const f = lockPath(dataDir);
  const t = setInterval(() => {
    try {
      const cur = readLock(dataDir);
      if (cur && cur !== "corrupt" && cur !== "unreadable" && cur.pid === process.pid && cur.hostname === osHostname()) {
        const now = new Date();
        utimesSync(f, now, now);
      }
    } catch (e) {
      log(`warning: lock heartbeat failed: ${(e as Error).message}`);
    }
  }, HEARTBEAT_MS);
  t.unref();
  return () => clearInterval(t);
}
