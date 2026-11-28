import { DAYS, OFFSET_MIN } from "./jobs.js";
/** First scheduled instant strictly after `now` (IST is fixed +05:30, no DST). */
export function nextRun(s, now) {
    const off = OFFSET_MIN[s.tz] * 60000;
    const [hh, mm] = s.time.split(":").map(Number);
    const local = new Date(now.getTime() + off); // read with getUTC* = wall clock in tz
    const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    for (let d = 0; d <= 7; d++) {
        const cand = dayStart + d * 86400000 + (hh * 60 + mm) * 60000;
        if (cand <= local.getTime())
            continue;
        if (s.days.includes(DAYS[new Date(cand).getUTCDay()]))
            return new Date(cand - off);
    }
    throw new Error("no next run");
}
/**
 * One job at a time. Each job has one pending due instant. Jobs whose due instant has passed run
 * in list order; after a run the job's next due instant is recomputed from the current clock, so
 * slots missed while busy or while the process was down are skipped, never back-filled.
 */
export async function runScheduler(jobs, deps) {
    if (jobs.length === 0)
        return;
    const due = new Map();
    for (const job of jobs)
        due.set(job, nextRun(job.schedule, deps.now()));
    while (!deps.stopped?.()) {
        const earliest = Math.min(...[...due.values()].map((d) => d.getTime()));
        const wait = earliest - deps.now().getTime();
        if (wait > 0) {
            await deps.sleep(wait);
            if (deps.stopped?.())
                return;
            continue; // re-evaluate against the clock (also covers waking early)
        }
        for (const job of jobs) {
            if (deps.stopped?.())
                return;
            if (due.get(job).getTime() > deps.now().getTime())
                continue;
            try {
                await deps.run(job);
            }
            catch (e) {
                console.error(`job ${job.name} failed:`, e instanceof Error ? e.message : String(e));
            }
            due.set(job, nextRun(job.schedule, deps.now()));
        }
    }
}
