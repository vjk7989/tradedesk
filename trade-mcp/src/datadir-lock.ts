// Exclusive DATA_DIR lock so the OAuth revoke CLI cannot run against a live trade-mcp.
// Lock file: DATA_DIR/trade-mcp.lock = JSON {pid, startedAt, hostname, procStart?}.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import path from "node:path";

export const LOCK_NAME = "trade-mcp.lock";

export interface LockInfo {
  pid: number;
  startedAt: string;
  hostname: string;
  /** Kernel start time of the process (Linux /proc, clock ticks); defeats pid reuse. */
  procStart?: string;
}

/** live: a process on this host/namespace holds it. stale: dead or ours from a previous life.
 *  foreign: written by another hostname (container); liveness cannot be judged from here. */
export type LockState = "missing" | "live" | "stale" | "foreign" | "corrupt";

export const lockPath = (dataDir: string) => path.join(dataDir, LOCK_NAME);

function procStart(pid: number): string | undefined {
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

export function readLock(dataDir: string): LockInfo | "corrupt" | undefined {
  const f = lockPath(dataDir);
  if (!existsSync(f)) return undefined;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (j && Number.isInteger(j.pid) && j.pid > 0 && typeof j.hostname === "string") return j as LockInfo;
  } catch { /* fallthrough */ }
  return "corrupt";
}

export function classify(info: LockInfo | "corrupt" | undefined, self = { pid: process.pid, hostname: osHostname() }): LockState {
  if (info === undefined) return "missing";
  if (info === "corrupt") return "corrupt";
  if (info.hostname !== self.hostname) return "foreign";
  if (info.pid === self.pid) return "stale"; // same container, same pid: a previous incarnation (e.g. pid 1 after restart)
  if (!pidAlive(info.pid)) return "stale";
  if (info.procStart) {
    const now = procStart(info.pid);
    if (now !== undefined && now !== info.procStart) return "stale"; // pid reused by an unrelated process
  }
  return "live";
}

export function checkLock(dataDir: string): LockState {
  return classify(readLock(dataDir));
}

export class LockHeldError extends Error {}

/** Acquire the lock (exclusive create). Throws LockHeldError if a live server holds it. */
export function acquireLock(dataDir: string, log: (m: string) => void = () => {}): () => void {
  mkdirSync(dataDir, { recursive: true });
  const f = lockPath(dataDir);
  const mine: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: osHostname(),
    procStart: procStart(process.pid),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(f, "wx", 0o644);
      try { writeSync(fd, JSON.stringify(mine)); } finally { closeSync(fd); }
      return () => {
        const cur = readLock(dataDir);
        if (cur && cur !== "corrupt" && cur.pid === mine.pid && cur.startedAt === mine.startedAt && cur.hostname === mine.hostname) {
          try { unlinkSync(f); } catch { /* already gone */ }
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const info = readLock(dataDir);
    const state = classify(info);
    if (state === "live") {
      const i = info as LockInfo;
      throw new LockHeldError(`trade-mcp already running on this DATA_DIR (pid ${i.pid}, host ${i.hostname}, since ${i.startedAt}); refusing to start`);
    }
    if (state !== "missing") {
      const why = state === "foreign" ? `from another host/container (${(info as LockInfo).hostname}), assumed dead` : state;
      log(`replacing stale ${LOCK_NAME} (${why})`);
      try { unlinkSync(f); } catch { /* raced */ }
    }
  }
  throw new Error(`could not acquire ${f}`);
}
