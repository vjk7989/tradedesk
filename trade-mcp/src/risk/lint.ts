import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { riskSchema, stripBom } from "../config.js";

export interface LintResult {
  code: 0 | 1 | 2;
  lines: string[];
}
export interface LintOpts {
  today?: string;
  strict?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Current date in IST (UTC+5:30) as YYYY-MM-DD. */
export function istToday(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Lint risk.json text with the server's own riskSchema. Pure: no IO, no env, no network.
 * Crypto-without-contractValues is intentionally not checked: symbolAllow carries no exchange and
 * crypto option/future symbols (BTC28FEB2580000CE) have the same shape as NFO ones, so crypto
 * symbols cannot be told apart reliably.
 */
export function lintRisk(text: string, opts: LintOpts = {}): LintResult {
  const today = opts.today ?? istToday();
  if (!validDate(today)) return { code: 1, lines: [`error: --today must be a valid YYYY-MM-DD date, got "${opts.today}"`] };

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    return { code: 1, lines: ["error: file is not valid JSON"] };
  }
  const parsed = riskSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = ["error: risk config is invalid"];
    for (const i of parsed.error.issues) {
      const p = i.path.length ? i.path.map(String).join(".") : "(root)";
      lines.push(`${p}: ${i.message}`);
    }
    return { code: 1, lines };
  }
  const r = parsed.data;
  const lines: string[] = [
    "risk config OK",
    "per-order caps:",
    `  maxQtyPerOrder: ${r.maxQtyPerOrder}`,
    `  maxNotionalPerOrder: ${r.maxNotionalPerOrder}`,
    `  maxNotionalPerOrderUsd: ${r.maxNotionalPerOrderUsd}`,
    `  maxOrdersPerRun: ${r.maxOrdersPerRun}`,
    "daily caps:",
    `  maxOrdersPerDay: ${r.maxOrdersPerDay}`,
    `  maxNotionalPerDay: ${r.maxNotionalPerDay}`,
    `  maxDailyLoss: ${r.maxDailyLoss}`,
    `allowlist: symbolAllow ${r.symbolAllow.length}, symbolDeny ${r.symbolDeny.length}, exchanges ${r.allowedExchanges.length}, products ${r.allowedProducts.length}`,
    `contractValues: ${Object.keys(r.contractValues).length}`,
    "marketHolidays:",
  ];
  const warnings: string[] = [];
  const year = today.slice(0, 4);
  for (const group of ["NSE", "MCX"] as const) {
    const dates = r.marketHolidays[group] ?? [];
    const perYear = new Map<string, number>();
    for (const d of dates) perYear.set(d.slice(0, 4), (perYear.get(d.slice(0, 4)) ?? 0) + 1);
    const summary = [...perYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([y, n]) => `${y}: ${n}`).join(", ");
    lines.push(`  ${group}: ${dates.length === 0 ? "none" : summary}`);
    if (!perYear.has(year)) warnings.push(`${group}: no holidays listed for ${year}`);
    const seen = new Set<string>();
    for (const d of dates) {
      if (seen.has(d)) warnings.push(`${group}: duplicate holiday ${d}`);
      seen.add(d);
    }
    for (const d of seen) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) warnings.push(`${group}: holiday ${d} falls on a ${dow === 0 ? "Sunday" : "Saturday"}`);
    }
  }
  for (const w of warnings) lines.push(`warning: ${w}`);
  const code = warnings.length > 0 && opts.strict ? 2 : 0;
  return { code, lines };
}

export interface MainIO {
  readFile?: (p: string) => string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  now?: () => number;
}

/** Thin CLI wrapper; returns the exit code. */
export function main(argv: string[] = process.argv.slice(2), io: MainIO = {}): number {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const out = io.out ?? ((s: string) => console.log(s));
  const err = io.err ?? ((s: string) => console.error(s));
  let file: string | undefined;
  let today: string | undefined;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") strict = true;
    else if (a === "--today") {
      today = argv[++i];
      if (today === undefined) {
        err("error: --today requires a value (YYYY-MM-DD)");
        return 1;
      }
    } else if (a.startsWith("--")) {
      err(`error: unknown option ${a}`);
      return 1;
    } else if (file === undefined) file = a;
    else {
      err("error: only one risk.json path may be given");
      return 1;
    }
  }
  if (file === undefined) {
    err("usage: risk:lint <risk.json> [--today YYYY-MM-DD] [--strict]");
    return 1;
  }
  let text: string;
  try {
    text = readFile(file);
  } catch {
    err(`error: cannot read file ${file}`);
    return 1;
  }
  const res = lintRisk(text, { today: today ?? istToday(io.now?.() ?? Date.now()), strict });
  for (const l of res.lines) (res.code === 1 ? err : out)(l);
  return res.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
