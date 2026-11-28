import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;
/** Parses only the header block (title, status, duration) of a report; the body is never kept. Null if malformed. */
const HEAD_BYTES = 4096;
/** Reads at most HEAD_BYTES of a regular file. Null for anything else or on error. */
function readHead(file) {
    try {
        if (!lstatSync(file).isFile())
            return null;
        const fd = openSync(file, "r");
        try {
            const buf = Buffer.alloc(HEAD_BYTES);
            const got = readSync(fd, buf, 0, HEAD_BYTES, 0);
            return { text: buf.subarray(0, got).toString("utf8"), truncated: got === HEAD_BYTES };
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return null;
    }
}
export function parseReportHeader(text, truncated = false) {
    const head = text.split(/\r?\n/);
    const title = /^# .+ - (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(head[0] ?? "");
    if (!title)
        return null;
    const at = Date.parse(title[1]);
    if (Number.isNaN(at))
        return null;
    let status;
    let durationMs;
    let refused = false;
    let ended = false;
    for (const line of head.slice(2)) {
        if (line.trim() === "") {
            ended = true;
            break;
        }
        // The error text is arbitrary (it may contain "- status: ok"), so nothing after "- error:" is trusted.
        if (line.startsWith("- error:")) {
            refused = line === "- error: refused";
            ended = true;
            break;
        }
        const s = /^- status: ([a-z]{1,20})$/.exec(line);
        if (s && status === undefined)
            status = s[1];
        const d = /^- duration: (\d+) ms$/.exec(line);
        if (d && durationMs === undefined)
            durationMs = Number(d[1]);
    }
    if (truncated && !ended)
        return null;
    if (status !== "ok" && status !== "error")
        return null;
    // The runner writes "ok" or "error"; a backend refusal is "- error: refused".
    return { at, status: status === "ok" ? "ok" : refused ? "refused" : "failed", durationMs };
}
/** Reads reports for the given jobs. Newest first (header time, then -n). Local file reads only. */
export function collectHistory(jobs, n) {
    const rows = [];
    let skipped = 0;
    const seen = new Set();
    for (const job of jobs) {
        const dir = join(job.outputDir, job.name);
        if (seen.has(dir))
            continue;
        seen.add(dir);
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const f of names) {
            const m = FILE_RE.exec(f);
            if (!m)
                continue;
            const file = join(dir, f);
            const head = readHead(file);
            const h = head ? parseReportHeader(head.text, head.truncated) : null;
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
export function formatHistory(rows, skipped) {
    const out = rows.map((r) => [r.job, r.stem, r.status, r.durationMs !== undefined ? `${r.durationMs} ms` : "-", r.file].join("\t"));
    if (!rows.length)
        out.push("no reports found");
    if (skipped)
        out.push(`skipped ${skipped} unreadable`);
    return out;
}
