import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validMcpSpec } from "./cli.js";
import { notifyTelegram } from "./notify.js";
import type { Backend, McpSpec, RunResult } from "./types.js";

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type Day = (typeof DAYS)[number];

export interface Schedule {
  days: Day[];
  time?: string; // HH:MM; exactly one of time / everyMinutes
  everyMinutes?: number; // integer 5..1440, slots at local minute 0 then every N minutes
  between?: [string, string]; // HH:MM..HH:MM local, both ends inclusive; only with everyMinutes
  tz: "Asia/Kolkata" | "UTC";
}

export interface Job {
  name: string;
  schedule: Schedule;
  backend: Backend;
  prompt: string;
  mcp: McpSpec;
  timeoutMs?: number;
  notify?: { telegram: { chatIdEnv: string } };
  outputDir: string;
}

export const OFFSET_MIN: Record<Schedule["tz"], number> = { "Asia/Kolkata": 330, UTC: 0 };

const BACKENDS = ["claude", "codex", "gemini", "api", "api-openai", "api-gemini"];

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
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    const hasTime = s.time !== undefined;
    const hasEvery = s.everyMinutes !== undefined;
    if (hasTime && hasEvery) bad(`schedule must have exactly one of time or everyMinutes, not both (job "${o.name}")`);
    if (!hasTime && !hasEvery) bad(`schedule must have exactly one of time or everyMinutes (job "${o.name}")`);
    let between: [string, string] | undefined;
    if (hasTime) {
      if (typeof s.time !== "string" || !HHMM.test(s.time)) bad("schedule.time must be HH:MM");
      if (s.between !== undefined) bad(`schedule.between is only allowed with everyMinutes (job "${o.name}")`);
    } else {
      if (!Number.isInteger(s.everyMinutes) || s.everyMinutes < 5 || s.everyMinutes > 1440) {
        bad(`schedule.everyMinutes must be an integer from 5 to 1440 (job "${o.name}")`);
      }
      if (s.between !== undefined) {
        const b = s.between;
        if (!Array.isArray(b) || b.length !== 2 || !b.every((x: unknown) => typeof x === "string" && HHMM.test(x))) {
          bad(`schedule.between must be ["HH:MM","HH:MM"] (job "${o.name}")`);
        }
        if (b[0] >= b[1]) bad(`schedule.between start must be before end, no overnight windows (job "${o.name}")`);
        between = [b[0], b[1]];
      }
    }
    if (s.tz !== "Asia/Kolkata" && s.tz !== "UTC") bad('schedule.tz must be "Asia/Kolkata" or "UTC"');
    if (!BACKENDS.includes(o.backend)) bad("backend must be claude|codex|gemini|api|api-openai|api-gemini");
    if (typeof o.prompt !== "string" || !o.prompt.trim()) bad("prompt must be a non-empty string");
    if (!validMcpSpec(o.mcp)) bad("invalid mcp {name,url,tokenEnv}");
    if (o.timeoutMs !== undefined && !(typeof o.timeoutMs === "number" && o.timeoutMs > 0)) bad("timeoutMs must be positive");
    let notify: Job["notify"];
    if (o.notify !== undefined) {
      const n = o.notify;
      const t = n && typeof n === "object" ? n.telegram : undefined;
      if (
        !n || typeof n !== "object" || Array.isArray(n) ||
        Object.keys(n).some((k) => k !== "telegram") ||
        !t || typeof t !== "object" || Array.isArray(t) ||
        Object.keys(t).some((k) => k !== "chatIdEnv") ||
        typeof t.chatIdEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.chatIdEnv)
      ) {
        bad("invalid notify {telegram:{chatIdEnv}}; chatIdEnv is an env var NAME");
      }
      if (o.notify.telegram.chatIdEnv === o.mcp.tokenEnv || o.notify.telegram.chatIdEnv === "TELEGRAM_BOT_TOKEN") {
        bad("invalid notify: chatIdEnv must not name a token env var");
      }
      notify = { telegram: { chatIdEnv: o.notify.telegram.chatIdEnv } };
    }
    if (typeof o.outputDir !== "string" || !o.outputDir) bad("outputDir must be a non-empty string");
    return {
      name: o.name,
      schedule: hasTime
        ? { days: s.days, time: s.time, tz: s.tz }
        : { days: s.days, everyMinutes: s.everyMinutes, ...(between ? { between } : {}), tz: s.tz },
      backend: o.backend,
      prompt: o.prompt,
      mcp: { name: o.mcp.name, url: o.mcp.url, tokenEnv: o.mcp.tokenEnv },
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...(notify ? { notify } : {}),
      outputDir: o.outputDir,
    };
  });
}

export interface ExecDeps {
  run: (job: Job) => Promise<RunResult>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
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
      if (job.notify?.telegram) {
        try {
          await notifyTelegram(job, { ok: res.ok, durationMs: t1.getTime() - t0.getTime(), text: res.text, error: res.error }, {
            env: deps.env ?? process.env,
            fetch: deps.fetch ?? globalThis.fetch,
          });
        } catch {
          /* notify must never affect the job */
        }
      }
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
