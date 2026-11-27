import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validMcpSpec } from "./cli.js";
import type { Backend, McpSpec, RunResult } from "./types.js";

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type Day = (typeof DAYS)[number];

export interface Schedule {
  days: Day[];
  time: string; // HH:MM
  tz: "Asia/Kolkata" | "UTC";
}

export interface Job {
  name: string;
  schedule: Schedule;
  backend: Backend;
  prompt: string;
  mcp: McpSpec;
  timeoutMs?: number;
  outputDir: string;
}

export const OFFSET_MIN: Record<Schedule["tz"], number> = { "Asia/Kolkata": 330, UTC: 0 };

const BACKENDS = ["claude", "codex", "gemini", "api"];

export class JobsError extends Error {}

export function parseJobs(raw: unknown): Job[] {
  if (!Array.isArray(raw)) throw new JobsError("jobs must be an array");
  const seen = new Set<string>();
  return raw.map((j, i) => {
    const at = `jobs[${i}]`;
    const bad = (m: string): never => {
      throw new JobsError(`${at}: ${m}`);
    };
    if (!j || typeof j !== "object" || Array.isArray(j)) return bad("must be an object");
    const o = j as Record<string, any>;
    if (typeof o.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(o.name)) bad("name must match [A-Za-z0-9_-]+");
    if (seen.has(o.name)) bad("duplicate name");
    seen.add(o.name);
    const s = o.schedule;
    if (!s || typeof s !== "object") return bad("schedule is required");
    if (!Array.isArray(s.days) || s.days.length === 0 || !s.days.every((d: unknown) => DAYS.includes(d as Day))) {
      bad("schedule.days must be a non-empty list of Mon..Sun");
    }
    if (typeof s.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) bad("schedule.time must be HH:MM");
    if (s.tz !== "Asia/Kolkata" && s.tz !== "UTC") bad('schedule.tz must be "Asia/Kolkata" or "UTC"');
    if (!BACKENDS.includes(o.backend)) bad("backend must be claude|codex|gemini|api");
    if (typeof o.prompt !== "string" || !o.prompt.trim()) bad("prompt must be a non-empty string");
    if (!validMcpSpec(o.mcp)) bad("invalid mcp {name,url,tokenEnv}");
    if (o.timeoutMs !== undefined && !(typeof o.timeoutMs === "number" && o.timeoutMs > 0)) bad("timeoutMs must be positive");
    if (typeof o.outputDir !== "string" || !o.outputDir) bad("outputDir must be a non-empty string");
    return {
      name: o.name,
      schedule: { days: s.days, time: s.time, tz: s.tz },
      backend: o.backend,
      prompt: o.prompt,
      mcp: { name: o.mcp.name, url: o.mcp.url, tokenEnv: o.mcp.tokenEnv },
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      outputDir: o.outputDir,
    };
  });
}

export interface ExecDeps {
  run: (job: Job) => Promise<RunResult>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

/** Runs one job and writes <outputDir>/<name>/<ISO date>.md. Never writes the MCP token. Returns the file path. */
export async function executeJob(job: Job, deps: ExecDeps): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const token = (deps.env ?? process.env)[job.mcp.tokenEnv];
  const redact = (t: string) => (token ? t.split(token).join("[redacted]") : t);
  const t0 = now();
  let res: RunResult;
  try {
    res = await deps.run(job);
  } catch (e) {
    res = { ok: false, text: "", error: e instanceof Error ? e.message : String(e), exitCode: null };
  }
  const t1 = now();
  const body = [
    `# ${job.name} - ${t0.toISOString()}`,
    "",
    `- status: ${res.ok ? "ok" : "error"}`,
    `- duration: ${t1.getTime() - t0.getTime()} ms`,
    ...(res.error ? [`- error: ${res.error}`] : []),
    "",
    "## Prompt",
    "",
    job.prompt,
    "",
    "## Result",
    "",
    res.text,
    "",
  ].join("\n");
  const dir = join(job.outputDir, job.name);
  await mkdir(dir, { recursive: true });
  // file date is the job's own tz date (IST for Asia/Kolkata jobs)
  const date = new Date(t0.getTime() + OFFSET_MIN[job.schedule.tz] * 60000).toISOString().slice(0, 10);
  for (let n = 0; ; n++) {
    const file = join(dir, `${date}${n ? `-${n}` : ""}.md`);
    try {
      await writeFile(file, redact(body), { flag: "wx" });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
