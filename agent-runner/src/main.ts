import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runTask } from "./cli.js";
import { executeJob, parseJobs, type Job } from "./jobs.js";
import { runScheduler } from "./scheduler.js";

const run = (job: Job) =>
  runTask({ backend: job.backend, prompt: job.prompt, mcp: job.mcp, timeoutMs: job.timeoutMs });
const exec = (job: Job) => executeJob(job, { run }).then((f) => console.error(`job ${job.name}: wrote ${f}`));

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
    console.log("agent-runner: node dist/main.js --jobs jobs.json [--once <name>]");
    return;
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
