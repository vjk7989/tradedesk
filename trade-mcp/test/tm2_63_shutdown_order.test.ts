// TM2-63: SIGINT/SIGTERM handlers are registered right after acquireLock(), before the heartbeat, createHttpServer
// and listen(), so a signal at any point after the lock is taken runs stop() (exit 0, lock released by the exit hook).
// Real built process (`node dist/src/index.js`), temp DATA_DIR, fake env values only.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCK_NAME, lockPath } from "../src/datadir-lock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "src", "index.js");
const INDEX_TS = path.join(ROOT, "src", "index.ts");
// Windows: ChildProcess.kill("SIGTERM"/"SIGINT") terminates the child outright (POSIX signals cannot be delivered to
// a child there, so no handler ever runs). Only the real-signal cases are skipped; the source-order guard runs everywhere.
const IS_WIN = process.platform === "win32";

const FAKE_MCP_TOKEN = "fake-mcp-token-tm2-63-" + "q".repeat(20);
const FAKE_API_KEY = "fake-openalgo-key-tm2-63";

const tmpDirs: string[] = [];
const procs: ChildProcess[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "tm2-63-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
});
afterAll(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/** Newest mtime of any .ts file under src/. dist is rebuilt if it is missing or older (CI runs vitest before build). */
function newestSrcMtime(dir = path.join(ROOT, "src")): number {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) m = Math.max(m, newestSrcMtime(p));
    else if (e.name.endsWith(".ts")) m = Math.max(m, statSync(p).mtimeMs);
  }
  return m;
}
beforeAll(() => {
  if (!existsSync(ENTRY) || statSync(ENTRY).mtimeMs < newestSrcMtime()) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
      cwd: ROOT, encoding: "utf8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  expect(existsSync(ENTRY)).toBe(true);
}, 120_000);

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
}

/** Same env as the tm2_46 edge test's startServer, against the built entry. */
function startBuilt(dir: string, port: number) {
  const p = spawn(process.execPath, [ENTRY], {
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
  let stdout = "", stderr = "";
  p.stdout!.on("data", (c) => (stdout += c));
  const firstStderrLine = new Promise<string | null>((r) => {
    p.stderr!.on("data", (c) => {
      stderr += c;
      const nl = stderr.indexOf("\n");
      if (nl >= 0) r(stderr.slice(0, nl));
    });
    p.on("exit", () => r(null));
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    p.on("exit", (code, signal) => r({ code, signal })));
  return { p, exited, firstStderrLine, out: () => stdout + stderr };
}

const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(LOCK_NAME));
const noSecrets = (s: string) => {
  expect(s).not.toContain(FAKE_MCP_TOKEN);
  expect(s).not.toContain(FAKE_API_KEY);
};
/** A pid that is certainly dead: a node child that printed its own pid and exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

describe("TM2-63 shutdown handlers vs startup (real built process)", () => {
  describe.each(["SIGTERM", "SIGINT"] as const)("%s", (sig) => {
    it.skipIf(IS_WIN)(`${sig} at the first stderr line (empty DATA_DIR) => exit 0, lock removed`, { timeout: 60_000 }, async () => {
      const dir = tmp();
      const s = startBuilt(dir, await freePort());
      const line = await s.firstStderrLine;
      expect(line, s.out()).not.toBeNull();
      s.p.kill(sig);
      expect(await s.exited, s.out()).toEqual({ code: 0, signal: null });
      expect(existsSync(lockPath(dir))).toBe(false);
      expect(leftovers(dir)).toEqual([]);
      noSecrets(s.out());
    });

    // Earliest phase: with a stale lock seeded, the first stderr line is acquireLock's own "replacing stale" log,
    // printed before the handlers, the heartbeat and listen() exist. The signal is still dispatched only after main()'s
    // synchronous run has registered stop(), so the exit is clean.
    it.skipIf(IS_WIN)(`${sig} at the first stderr line printed from inside acquireLock => exit 0, lock removed`, { timeout: 60_000 }, async () => {
      const dir = tmp();
      writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z", hostname: hostname() }));
      const s = startBuilt(dir, await freePort());
      const line = await s.firstStderrLine;
      expect(line, s.out()).toMatch(/replacing stale trade-mcp\.lock/);
      s.p.kill(sig);
      expect(await s.exited, s.out()).toEqual({ code: 0, signal: null });
      expect(existsSync(lockPath(dir))).toBe(false);
      expect(leftovers(dir)).toEqual([]);
      noSecrets(s.out());
    });
  });

  // The signal can land before Node has bootstrapped any JS (or before main() reaches acquireLock): then no JS
  // handler exists and Node's default action ends the process by the signal (code null, signal SIGTERM). Nothing can
  // run earlier than the entry file, so that window cannot be closed in-process; but in it the lock was never taken,
  // so nothing is left behind. If the signal lands after the handlers exist, stop() runs and the exit is 0.
  it.skipIf(IS_WIN)("SIGTERM immediately after spawn => exit 0 or killed by SIGTERM, never a lock left behind", { timeout: 60_000 }, async () => {
    const dir = tmp();
    const s = startBuilt(dir, await freePort());
    s.p.kill("SIGTERM");
    const e = await s.exited;
    expect([JSON.stringify({ code: 0, signal: null }), JSON.stringify({ code: null, signal: "SIGTERM" })], s.out())
      .toContain(JSON.stringify(e));
    expect(existsSync(lockPath(dir))).toBe(false);
    expect(leftovers(dir)).toEqual([]);
    noSecrets(s.out());
  });

  it("source order in src/index.ts: acquireLock( < SIGINT/SIGTERM registration < startHeartbeat( and .listen(", () => {
    const src = readFileSync(INDEX_TS, "utf8");
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, `${needle} not found in src/index.ts`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const lock = at("acquireLock(");
    const term = at('process.on("SIGTERM"');
    const int = at('process.on("SIGINT"');
    const heartbeat = at("startHeartbeat(");
    const httpServer = at("createHttpServer(");
    const listen = at(".listen(");
    for (const reg of [term, int]) {
      expect(reg).toBeGreaterThan(lock);
      expect(reg).toBeLessThan(heartbeat);
      expect(reg).toBeLessThan(httpServer);
      expect(reg).toBeLessThan(listen);
    }
  });
});
