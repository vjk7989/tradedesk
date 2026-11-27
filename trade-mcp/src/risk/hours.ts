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

const HOLIDAY_GROUP = (ex: string): "NSE" | "MCX" | undefined => (EQUITY.has(ex) ? "NSE" : ex === "MCX" ? "MCX" : undefined);

/** Holidays: IST dates per group (NSE covers NSE/NFO/CDS/BSE/BFO; MCX covers MCX). Unknown exchange -> false. */
export function isMarketOpen(exchange: string, now: Date, holidays?: Partial<Record<"NSE" | "MCX", string[]>>): boolean {
  const ex = exchange.toUpperCase();
  if (ex === "CRYPTO") return true;
  const { date, day, minutes } = istParts(now);
  if (day === 0 || day === 6) return false;
  const g = HOLIDAY_GROUP(ex);
  if (g && holidays?.[g]?.includes(date)) return false;
  if (EQUITY.has(ex)) return minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30;
  if (ex === "MCX") return minutes >= 9 * 60 && minutes < 23 * 60 + 30;
  return false;
}
