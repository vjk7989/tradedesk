import { DAYS, OFFSET_MIN, type Job, type Schedule } from "./jobs.js";

/** First scheduled instant strictly after `now` (IST is fixed +05:30, no DST). */
export function nextRun(s: Schedule, now: Date): Date {
  const off = OFFSET_MIN[s.tz] * 60000;
  const [hh, mm] = s.time.split(":").map(Number);
  const local = new Date(now.getTime() + off); // read with getUTC* = wall clock in tz
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let d = 0; d <= 7; d++) {
    const cand = dayStart + d * 86400000 + (hh * 60 + mm) * 60000;
    if (cand <= local.getTime()) continue;
    if (s.days.includes(DAYS[new Date(cand).getUTCDay()])) return new Date(cand - off);
  }
  throw new Error("no next run");
}

export interface SchedulerDeps {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  run: (job: Job) => Promise<void>;
  /** Checked at the top of every loop and after each sleep; true ends the scheduler. */
  stopped?: () => boolean;
}

/**
 * One job at a time. Each job has one pending due instant. Jobs whose due instant has passed run
 * in list order; after a run the job's next due instant is recomputed from the current clock, so
 * slots missed while busy or while the process was down are skipped, never back-filled.
 */
export async function runScheduler(jobs: Job[], deps: SchedulerDeps): Promise<void> {
  if (jobs.length === 0) return;
  const due = new Map<Job, Date>();
  for (const job of jobs) due.set(job, nextRun(job.schedule, deps.now()));
  while (!deps.stopped?.()) {
    const earliest = Math.min(...[...due.values()].map((d) => d.getTime()));
    const wait = earliest - deps.now().getTime();
    if (wait > 0) {
      await deps.sleep(wait);
      if (deps.stopped?.()) return;
      continue; // re-evaluate against the clock (also covers waking early)
    }
    for (const job of jobs) {
      if (deps.stopped?.()) return;
      if (due.get(job)!.getTime() > deps.now().getTime()) continue;
      try {
        await deps.run(job);
      } catch (e) {
        console.error(`job ${job.name} failed:`, e instanceof Error ? e.message : String(e));
      }
      due.set(job, nextRun(job.schedule, deps.now()));
    }
  }
}
