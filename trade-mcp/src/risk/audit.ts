import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const SECRET_RE = /apikey|token|secret|password|authorization|passphrase|privatekey|cookie|session/;
const isSecret = (k: string) => SECRET_RE.test(k.toLowerCase().replace(/[-_]/g, ""));

const MAX_STR = 2000;
const MAX_ITEMS = 100;
const MAX_DEPTH = 8;
const MAX_LINE_BYTES = 64 * 1024;

/** Key-name redaction plus size bounds (string length, array length, depth, cycles). */
function sanitize(v: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…[+${v.length - MAX_STR} chars]` : v;
  if (!v || typeof v !== "object") return v;
  if (depth > MAX_DEPTH) return "[depth limit]";
  if (seen.has(v)) return "[cycle]";
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const out = v.slice(0, MAX_ITEMS).map((x) => sanitize(x, depth + 1, seen));
      if (v.length > MAX_ITEMS) out.push(`…[+${v.length - MAX_ITEMS} items]`);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = isSecret(k) ? "[REDACTED]" : sanitize(val, depth + 1, seen);
    return out;
  } finally {
    seen.delete(v);
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 90;

/** Positive integer from env, else the default (empty, non-numeric, <=0, decimals, Infinity, NaN all fall back). */
function envPositiveInt(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return dflt;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
}

/** IST (UTC+05:30, no DST) calendar date of an instant, as YYYY-MM-DD. */
function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const dateToDay = (ymd: string): number => Date.parse(`${ymd}T00:00:00.000Z`) / DAY_MS;

// Assumes a single writer process (no cross-process locking). A future mtime (clock skew)
// names the rotated file with a future date, which keeps it out of retention.
function rotateIfNeeded(file: string, now: Date): boolean {
  if (!existsSync(file)) return false;
  const st = statSync(file);
  const fileDate = istDate(st.mtime);
  if (fileDate === istDate(now) && st.size < envPositiveInt("AUDIT_MAX_BYTES", DEFAULT_MAX_BYTES)) return false;
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  let target = path.join(dir, `${base}.${fileDate}.jsonl`);
  for (let n = 1; existsSync(target); n++) target = path.join(dir, `${base}.${fileDate}.${n}.jsonl`);
  renameSync(file, target);
  return true;
}

/** Delete rotated files dated more than `days` days before today's IST date (exactly `days` days old is kept). */
function applyRetention(file: string, now: Date): void {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d{4}-\\d{2}-\\d{2})(\\.\\d+)?\\.jsonl$`);
  const retention = envPositiveInt("AUDIT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
  const today = dateToDay(istDate(now));
  for (const name of readdirSync(dir)) {
    const m = re.exec(name);
    if (!m) continue;
    const ms = Date.parse(`${m[1]}T00:00:00.000Z`);
    // Skip impossible dates (e.g. 2026-02-30), which Date.parse may roll over.
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== m[1]) continue;
    const day = ms / DAY_MS;
    if (today - day > retention) {
      try { unlinkSync(path.join(dir, name)); } catch { /* best-effort cleanup */ }
    }
  }
}

export function appendAudit(file: string, entry: object, now: () => Date = () => new Date()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const t = now();
  if (rotateIfNeeded(file, t)) {
    try { applyRetention(file, t); } catch { /* retention must never block auditing */ }
  }
  const clean: Record<string, unknown> = { ...(sanitize(entry) as Record<string, unknown>), ts: t.toISOString() };
  let line = JSON.stringify(clean);
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_LINE_BYTES) line = JSON.stringify({ ts: clean.ts, run: clean.run, truncated: true, bytes });
  appendFileSync(file, line + "\n");
}
