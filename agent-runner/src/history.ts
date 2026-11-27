import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "./jobs.js";

export interface HistoryRow {
  job: string;
  file: string;
  stem: string;
  status: string;
  durationMs?: number;
  at: number;
  seq: number;
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;

/** Parses only the header block (title, status, duration) of a report; the body is never kept. Null if malformed. */
export function parseReportHeader(text: string): { at: number; status: string; durationMs?: number } | null {
  const head = text.split(/\r?\n/);
  const title = /^# .+ - (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(head[0] ?? "");
  if (!title) return null;
  const at = Date.parse(title[1]);
  if (Number.isNaN(at)) return null;
  let status: string | undefined;
  let durationMs: number | undefined;
  let refused = false;
  for (const line of head.slice(2)) {
    if (line.trim() === "") break;
    const s = /^- status: ([a-z]{1,20})$/.exec(line);
    if (s) status = s[1];
    if (line === "- error: refused") refused = true;
    const d = /^- duration: (\d+) ms$/.exec(line);
    if (d) durationMs = Number(d[1]);
  }
  if (status !== "ok" && status !== "error") return null;
  // The runner writes "ok" or "error"; a backend refusal is "- error: refused".
  return { at, status: status === "ok" ? "ok" : refused ? "refused" : "failed", durationMs };
}

/** Reads reports for the given jobs. Newest first (header time, then -n). Local file reads only. */
export function collectHistory(jobs: Job[], n: number): { rows: HistoryRow[]; skipped: number } {
  const rows: HistoryRow[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const job of jobs) {
    const dir = join(job.outputDir, job.name);
    if (seen.has(dir)) continue;
    seen.add(dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      const m = FILE_RE.exec(f);
      if (!m) continue;
      const file = join(dir, f);
      let h: ReturnType<typeof parseReportHeader> = null;
      try {
        h = parseReportHeader(readFileSync(file, "utf8"));
      } catch {
        /* unreadable */
      }
      if (!h) {
        skipped++;
        continue;
      }
      rows.push({ job: job.name, file, stem: f.slice(0, -3), status: h.status, durationMs: h.durationMs, at: h.at, seq: Number(m[2] ?? 0) });
    }
  }
  rows.sort((a, b) => b.at - a.at || b.seq - a.seq || (a.file < b.file ? -1 : 1));
  return { rows: rows.slice(0, n), skipped };
}

/** One tab-separated line per run: job, date[-n], status, duration, path. Header fields only. */
export function formatHistory(rows: HistoryRow[], skipped: number): string[] {
  const out = rows.map((r) =>
    [r.job, r.stem, r.status, r.durationMs !== undefined ? `${r.durationMs} ms` : "-", r.file].join("\t"),
  );
  if (!rows.length) out.push("no reports found");
  if (skipped) out.push(`skipped ${skipped} unreadable`);
  return out;
}
