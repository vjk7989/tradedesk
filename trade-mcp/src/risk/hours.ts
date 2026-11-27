const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** IST wall-clock parts computed from UTC (host TZ independent). */
export function istParts(now: Date): { date: string; day: number; minutes: number } {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    day: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const EQUITY = new Set(["NSE", "BSE", "NFO", "BFO", "CDS"]);

/** Holidays are not modelled. Unknown exchange -> false. */
export function isMarketOpen(exchange: string, now: Date): boolean {
  const ex = exchange.toUpperCase();
  if (ex === "CRYPTO") return true;
  const { day, minutes } = istParts(now);
  if (day === 0 || day === 6) return false;
  if (EQUITY.has(ex)) return minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30;
  if (ex === "MCX") return minutes >= 9 * 60 && minutes < 23 * 60 + 30;
  return false;
}
