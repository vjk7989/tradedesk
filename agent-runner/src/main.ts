import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runTask } from "./cli.js";
import { DEFAULT_GEMINI_MODEL } from "./gemini.js";
import { executeJob, OFFSET_MIN, parseJobs, type Job } from "./jobs.js";
import { nextRun, runScheduler } from "./scheduler.js";

// Backend -> API key env (CLI backends need none).
const KEY_ENV: Record<string, string> = {
  api: "ANTHROPIC_API_KEY",
  "api-openai": "OPENAI_API_KEY",
  "api-gemini": "GEMINI_API_KEY",
};
const state = (name: string) => (process.env[name]?.trim() ? "set" : "missing");

/** Wall clock in the job tz, e.g. "2026-11-30 08:45 Asia/Kolkata". */
const wall = (d: Date, tz: Job["schedule"]["tz"]) =>
  new Date(d.getTime() + OFFSET_MIN[tz] * 60000).toISOString().slice(0, 16).replace("T", " ") + " " + tz;

const run = (job: Job) =>
  runTask({ backend: job.backend, prompt: job.prompt, mcp: job.mcp, timeoutMs: job.timeoutMs });
const exec = (job: Job) => executeJob(job, { run }).then((f) => console.error(`job ${job.name}: wrote ${f}`));

/** Model that would be used. Names the env var, never prints its value. */
const modelLine = (b: string) =>
  b === "api" ? "claude-opus-5-5"
  : b === "api-openai" ? "gpt-5.5 (default; OPENAI_MODEL overrides if set)"
  : b === "api-gemini" ? `${DEFAULT_GEMINI_MODEL} (default; GEMINI_MODEL overrides if set)`
  : "backend CLI default (none configured)";

/** Describes a job without running it. Every printed line is redacted against all known secret env values. */
function dryRun(job: Job, all: Job[]): string {
  const names = [
    ...Object.values(KEY_ENV),
    "TELEGRAM_BOT_TOKEN",
    ...all.flatMap((j) => [j.mcp.tokenEnv, j.notify?.telegram.chatIdEnv]),
  ];
  const vals = [...new Set(names.flatMap((n) => (n && process.env[n]?.trim() ? [process.env[n] as string] : [])))];
  const short = vals.some((v) => v.trim().length < 4);
  const secrets = [...new Set(vals.flatMap((v) => (v.trim().length >= 4 ? [v, v.trim()] : [])))].sort((x, y) => y.length - x.length);
  const redact = (t: string) => secrets.reduce((acc, x) => acc.split(x).join("[redacted]"), t);
  const withheld = "[withheld: a referenced secret is shorter than 4 characters]";
  const next = nextRun(job.schedule, new Date());
  const lines = [
    `job: ${job.name}`,
    `backend: ${job.backend}`,
    `model: ${modelLine(job.backend)}`,
    `mcp url: ${short ? withheld : job.mcp.url}`,
    `token env: ${job.mcp.tokenEnv} (${state(job.mcp.tokenEnv)})`,
    `timeout: ${job.timeoutMs !== undefined ? `${job.timeoutMs} ms` : "default"}`,
    `schedule: ${job.schedule.days.join(",")} ${job.schedule.time} ${job.schedule.tz}`,
    `next run: ${wall(next, job.schedule.tz)} | ${next.toISOString()}`,
    `prompt: ${short ? withheld : ""}`.trimEnd(),
    ...(short ? [] : [job.prompt]),
  ];
  return lines.map(redact).join("\n");
}

/** `args` are the CLI arguments after the script name. */
export interface MainDeps {
  exit?: (code: number) => void;
  onSignal?: (sig: string, fn: () => void) => void;
}

export async function main(args: string[] = process.argv.slice(2), deps: MainDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const onSignal = deps.onSignal ?? ((s: string, fn: () => void) => void process.on(s as NodeJS.Signals, fn));
  const signals = ["SIGINT", "SIGTERM"] as const;
  let exited = false;
  const bye = () => {
    if (exited) return;
    exited = true;
    exit(0);
  };
  const val = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--help") || args.includes("-h")) {
    console.log("agent-runner: node dist/main.js --jobs jobs.json [--once <name>] [--check] [--next N] [--dry-run <name>]");
    return;
  }
  const dryIdx = args.findIndex((a) => a === "--dry-run" || a.startsWith("--dry-run="));
  if (dryIdx >= 0) {
    const bad = ["--once", "--check", "--next"].filter((f) => args.includes(f));
    if (bad.length) {
      console.error(`--dry-run cannot be combined with ${bad.join(", ")}`);
      return exit(1);
    }
    const arg = args[dryIdx];
    const name = arg.startsWith("--dry-run=") ? arg.slice(10) : args[dryIdx + 1];
    if (!name || name.startsWith("--")) {
      console.error("--dry-run requires a job name");
      return exit(1);
    }
    let jobs: Job[];
    try {
      jobs = parseJobs(JSON.parse(readFileSync(val("--jobs") ?? "jobs.json", "utf8")));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return exit(1);
    }
    const job = jobs.find((j) => j.name === name);
    if (!job) {
      console.error(`no such job: ${name}. valid names: ${jobs.map((j) => j.name).join(", ")}`);
      return exit(1);
    }
    console.log(dryRun(job, jobs));
    return exit(0);
  }
  const check = args.includes("--check");
  const nextIdx = args.indexOf("--next");
  if (check || nextIdx >= 0) {
    if (check && nextIdx >= 0) {
      console.error("--check and --next cannot be combined");
      return exit(1);
    }
    let n = 5;
    if (nextIdx >= 0) {
      const a = args[nextIdx + 1];
      if (a !== undefined && !a.startsWith("--")) {
        if (Number(a) > 100) {
          console.error("--next N must be between 1 and 100");
          return exit(1);
        }
        if (!/^\d+$/.test(a) || Number(a) < 1) {
          console.error(`--next N must be a positive integer, got: ${a}`);
          return exit(1);
        }
        n = Number(a);
      }
    }
    const file = val("--jobs") ?? "jobs.json";
    let jobs: Job[];
    try {
      jobs = parseJobs(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return exit(1);
    }
    if (check) {
      let ok = true;
      console.log(["job", "backend", "mcp token env", "api key env"].join("\t"));
      for (const j of jobs) {
        const tok = state(j.mcp.tokenEnv);
        const keyName = KEY_ENV[j.backend];
        const key = keyName ? state(keyName) : undefined;
        if (tok !== "set" || key === "missing") ok = false;
        console.log([j.name, j.backend, `${j.mcp.tokenEnv}: ${tok}`, keyName ? `${keyName}: ${key}` : "-"].join("\t"));
      }
      return exit(ok ? 0 : 1);
    }
    const start = new Date();
    for (const j of jobs) {
      console.log(j.name);
      let t = start;
      for (let i = 0; i < n; i++) {
        t = nextRun(j.schedule, t);
        console.log(`  ${wall(t, j.schedule.tz)}  ${t.toISOString()}`);
      }
    }
    return exit(0);
  }
  const jobs = parseJobs(JSON.parse(readFileSync(val("--jobs") ?? "jobs.json", "utf8")));
  const once = val("--once");
  if (once !== undefined) {
    const job = jobs.find((j) => j.name === once);
    if (!job) throw new Error(`no such job: ${once}`);
    for (const sig of signals) onSignal(sig, bye);
    await exec(job);
    return;
  }
  let stopping = false;
  let running = false;
  // First signal: stop starting jobs; exit now if idle, else after the running job. Second: exit now.
  const onStop = () => {
    const second = stopping;
    stopping = true;
    if (second || !running) bye();
  };
  for (const sig of signals) onSignal(sig, onStop);
  console.error(`agent-runner scheduler started: ${jobs.length} job(s)`);
  await runScheduler(jobs, {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 3600000))),
    run: async (job) => {
      running = true;
      try {
        await exec(job);
      } finally {
        running = false;
      }
    },
    stopped: () => stopping,
  });
  if (stopping) bye();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("fatal:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
