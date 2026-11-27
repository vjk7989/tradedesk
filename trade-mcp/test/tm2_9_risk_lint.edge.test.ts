import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintRisk, main, istToday } from "../src/risk/lint.js";
import { loadConfig } from "../src/config.js";

const j = (o: unknown) => JSON.stringify(o);
const T = { today: "2026-06-15" };
const warnings = (lines: string[]) => lines.filter((l) => l.startsWith("warning:"));
// A config with no warnings for 2026 (2026-01-26 is a Monday).
const clean = { marketHolidays: { NSE: ["2026-01-26"], MCX: ["2026-01-26"] } };

function run(argv: string[], files: Record<string, string> = {}, now?: number) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...(now !== undefined ? { now: () => now } : {}),
  });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

describe("date math", () => {
  it("weekend detection around UTC day/year boundaries", () => {
    // 2026-12-31 Thu, 2027-01-01 Fri, 2027-01-02 Sat, 2027-01-03 Sun, 2027-01-04 Mon
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"] } }), { today: "2027-01-01" });
    const w = warnings(r.lines).filter((l) => l.includes("NSE: holiday"));
    expect(w).toEqual(["warning: NSE: holiday 2027-01-02 falls on a Saturday", "warning: NSE: holiday 2027-01-03 falls on a Sunday"]);
  });
  it("weekend detection on dates that are DST transitions elsewhere (computed in UTC)", () => {
    // 2026-03-08 Sun (US DST start), 2026-03-29 Sun (EU DST start), 2026-10-25 Sun, 2026-03-09 Mon
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-03-08", "2026-03-29", "2026-10-25", "2026-03-09"] } }), T);
    const w = warnings(r.lines).filter((l) => l.includes("falls on"));
    expect(w).toHaveLength(3);
    expect(w.every((l) => l.endsWith("Sunday"))).toBe(true);
    expect(w.join("\n")).not.toContain("2026-03-09");
  });
  it("Feb 29: valid in leap year 2028, parse error in 2027", () => {
    const ok = lintRisk(j({ marketHolidays: { NSE: ["2028-02-29"], MCX: ["2028-02-29"] } }), { today: "2028-02-29" });
    expect(ok.code).toBe(0);
    expect(warnings(ok.lines)).toEqual([]); // 2028-02-29 is a Tuesday
    const bad = lintRisk(j({ marketHolidays: { NSE: ["2027-02-29"] } }), T);
    expect(bad.code).toBe(1);
    expect(bad.lines.some((l) => l.startsWith("marketHolidays.NSE.0: "))).toBe(true);
    // century rule: 2100 is not a leap year, 2000 is
    expect(lintRisk(j({ marketHolidays: { NSE: ["2100-02-29"] } }), T).code).toBe(1);
    expect(lintRisk(j({ marketHolidays: { NSE: ["2000-02-29"] } }), T).code).toBe(0);
  });
  it("--today Feb 29 validity", () => {
    expect(lintRisk(j(clean), { today: "2028-02-29" }).code).toBe(0);
    expect(lintRisk(j(clean), { today: "2027-02-29" }).code).toBe(1);
  });
  it("year boundary: Dec 31 holiday counts for its own year only", () => {
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-12-31"], MCX: ["2026-12-31"] } }), { today: "2027-01-01" });
    expect(r.lines).toContain("warning: NSE: no holidays listed for 2027");
    expect(r.lines).toContain("  NSE: 2026: 1");
  });
});

describe("--today and the IST clock", () => {
  it("istToday flips to the next day at 18:30Z", () => {
    expect(istToday(Date.parse("2026-12-31T18:29:59Z"))).toBe("2026-12-31");
    expect(istToday(Date.parse("2026-12-31T18:30:00Z"))).toBe("2027-01-01");
  });
  it("main picks the IST year on Dec 31 at 18:29:59Z vs 18:30Z", () => {
    const f = { f: j({ marketHolidays: { NSE: ["2026-01-26"], MCX: ["2027-01-26"] } }) };
    const before = run(["f"], f, Date.parse("2026-12-31T18:29:59Z"));
    expect(before.out).toContain("warning: MCX: no holidays listed for 2026");
    expect(before.all).not.toContain("NSE: no holidays");
    const after = run(["f"], f, Date.parse("2026-12-31T18:30:00Z"));
    expect(after.out).toContain("warning: NSE: no holidays listed for 2027");
    expect(after.all).not.toContain("MCX: no holidays");
  });
  it("explicit --today overrides the clock", () => {
    const r = run(["f", "--today", "2026-06-15"], { f: j(clean) }, Date.parse("2030-01-01T00:00:00Z"));
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("warning:");
  });
  it.each(["2026-1-5", "2026-13-01", "", "2026-00-10", "2026-06-31", " 2026-06-15", "2026-06-15T00:00", "20260615"])("rejects --today %j with exit 1", (t) => {
    const r = run(["f", "--today", t], { f: j(clean) });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("--today");
    expect(r.out).toEqual([]);
  });
});

describe("duplicates", () => {
  it("same date in NSE and MCX is not a duplicate", () => {
    const r = lintRisk(j(clean), T);
    expect(r.lines.join("\n")).not.toContain("duplicate");
  });
  it("duplicate within one group is flagged for that group only", () => {
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-01-26"], MCX: ["2026-01-26", "2026-01-26"] } }), T);
    const d = r.lines.filter((l) => l.includes("duplicate"));
    expect(d).toEqual(["warning: MCX: duplicate holiday 2026-01-26"]);
  });
  it("triple duplicate is reported (at least once) and weekend not double-reported", () => {
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-06-13", "2026-06-13", "2026-06-13"], MCX: ["2026-01-26"] } }), T);
    const d = r.lines.filter((l) => l.includes("duplicate holiday 2026-06-13"));
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.length).toBeLessThanOrEqual(2);
    expect(r.lines.filter((l) => l.includes("2026-06-13 falls on a Saturday"))).toHaveLength(1);
  });
});

describe("holiday coverage and summary", () => {
  it("holidays only in other years -> warning for the current year", () => {
    const r = lintRisk(j({ marketHolidays: { NSE: ["2025-01-26", "2027-01-26"], MCX: ["2025-05-01"] } }), T);
    expect(r.lines).toContain("warning: NSE: no holidays listed for 2026");
    expect(r.lines).toContain("warning: MCX: no holidays listed for 2026");
    expect(r.code).toBe(0);
    expect(lintRisk(j({ marketHolidays: { NSE: ["2025-01-26"], MCX: ["2025-05-01"] } }), { ...T, strict: true }).code).toBe(2);
  });
  it("huge holiday list (every weekday 2000-2099) lints quickly with correct counts", () => {
    const dates: string[] = [];
    for (let t = Date.UTC(2000, 0, 1); t < Date.UTC(2100, 0, 1); t += 86400000) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.push(d.toISOString().slice(0, 10));
    }
    expect(dates.length).toBeGreaterThan(26000);
    const t0 = Date.now();
    const r = lintRisk(j({ marketHolidays: { NSE: dates, MCX: dates } }), T);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.code).toBe(0);
    expect(warnings(r.lines)).toEqual([]);
    const nse = r.lines.find((l) => l.startsWith("  NSE: "))!;
    expect(nse).toContain("2000: 260");
    expect(nse).toContain("2026: 261");
    expect(nse.split(", ")).toHaveLength(100);
  });
  it("summary counts: N holidays per group across 2 years", () => {
    // Weekdays only: NSE 3 in 2026 + 2 in 2027, MCX 1 in 2026 + 4 in 2027
    const r = lintRisk(
      j({
        marketHolidays: {
          NSE: ["2027-01-26", "2026-01-26", "2026-03-03", "2027-03-22", "2026-10-02"],
          MCX: ["2027-01-26", "2027-03-22", "2026-01-26", "2027-05-03", "2027-08-16"],
        },
      }),
      T,
    );
    expect(r.code).toBe(0);
    expect(r.lines).toContain("  NSE: 2026: 3, 2027: 2");
    expect(r.lines).toContain("  MCX: 2026: 1, 2027: 4");
    expect(warnings(r.lines)).toEqual([]);
  });
  it("absent group prints none and warns", () => {
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-01-26"] } }), T);
    expect(r.lines).toContain("  MCX: none");
    expect(r.lines).toContain("warning: MCX: no holidays listed for 2026");
  });
  it("--strict with zero warnings -> exit 0", () => {
    expect(lintRisk(j(clean), { ...T, strict: true }).code).toBe(0);
    expect(run(["f", "--strict", "--today", "2026-06-15"], { f: j(clean) }).code).toBe(0);
  });
});

describe("file content edge cases", () => {
  it("BOM: behaves the same as the server loader (both reject or both accept)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tm29-bom-"));
    try {
      const p = path.join(dir, "risk.json");
      const text = "﻿" + j(clean);
      writeFileSync(p, text, "utf8");
      let serverOk = true;
      try {
        loadConfig({ OPENALGO_URL: "http://x", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(24), RISK_CONFIG: p });
      } catch {
        serverOk = false;
      }
      const r = lintRisk(text, T);
      expect(r.code === 1).toBe(!serverOk);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("CRLF line endings are fine", () => {
    const text = JSON.stringify(clean, null, 2).replace(/\n/g, "\r\n");
    expect(lintRisk(text, T).code).toBe(0);
  });
  it("trailing comma is invalid JSON -> exit 1", () => {
    const r = lintRisk('{"maxQtyPerOrder": 5,}', T);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("not valid JSON");
  });
  it.each([
    ["null", "null"],
    ["array root", "[]"],
    ["number root", "42"],
    ["string root", '"x"'],
  ])("%s -> parse error at (root)", (_n, text) => {
    const r = lintRisk(text, T);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("(root): "))).toBe(true);
  });
  it.each(["", "   ", "\r\n"])("empty/whitespace file %j -> exit 1", (text) => {
    const r = lintRisk(text, T);
    expect(r.code).toBe(1);
    expect(r.lines.length).toBeGreaterThan(0);
  });
  it("unknown top-level key -> parse error naming the key", () => {
    const r = lintRisk(j({ maxQtyPerOrdr: 5 }), T);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/\(root\): .*maxQtyPerOrdr/);
  });
  it("unknown holiday group -> parse error with marketHolidays path", () => {
    const r = lintRisk(j({ marketHolidays: { BSE: ["2026-01-26"] } }), T);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("marketHolidays: ") && l.includes("BSE"))).toBe(true);
  });
  it.each(["maxQtyPerOrder", "maxNotionalPerOrder", "maxDailyLoss", "maxOrdersPerRun"])("negative cap %s -> parse error with path", (k) => {
    const r = lintRisk(j({ [k]: -1 }), T);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith(`${k}: `))).toBe(true);
  });
  it("negative contractValue -> parse error with nested path", () => {
    const r = lintRisk(j({ contractValues: { BTCUSD: -0.001 } }), T);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("contractValues.BTCUSD: "))).toBe(true);
  });
  it("multiple issues are each printed", () => {
    const r = lintRisk(j({ maxQtyPerOrder: -1, maxDailyLoss: 0, marketHolidays: { NSE: ["2026-02-30"] } }), T);
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => /^[\w.()]+: /.test(l)).length).toBeGreaterThanOrEqual(3);
  });
});

describe("argv edge cases", () => {
  const files = { f: j(clean), "my risk.json": j(clean), "risk-ü-日本.json": j(clean) };
  it("flags before the path", () => {
    expect(run(["--strict", "--today", "2026-06-15", "f"], files).code).toBe(0);
    expect(run(["--strict", "--today", "2026-06-15", "f"], { f: "{}" }).code).toBe(2);
  });
  it("repeated --strict is fine", () => {
    expect(run(["f", "--strict", "--strict", "--today", "2026-06-15"], { f: "{}" }).code).toBe(2);
  });
  it("--today without a value (last arg, or followed by a flag) -> exit 1", () => {
    const a = run(["f", "--today"], files);
    expect(a.code).toBe(1);
    expect(a.err.join("\n")).toContain("--today");
    const b = run(["f", "--today", "--strict"], files);
    expect(b.code).toBe(1);
    expect(b.err.join("\n")).toContain("--today");
  });
  it("-- separator: never crashes, exits deterministically with a message", () => {
    const r = run(["--", "f", "--today", "2026-06-15"], files);
    expect([0, 1]).toContain(r.code);
    if (r.code === 1) expect(r.err.length).toBeGreaterThan(0);
  });
  it("two paths -> exit 1", () => {
    expect(run(["f", "f"], files).code).toBe(1);
  });
  it("path containing spaces and unicode (virtual fs)", () => {
    expect(run(["my risk.json", "--today", "2026-06-15"], files).code).toBe(0);
    expect(run(["risk-ü-日本.json", "--today", "2026-06-15"], files).code).toBe(0);
  });
  it("path containing spaces and unicode (real fs, default reader)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tm29 ü 日本 "));
    try {
      const p = path.join(dir, "my risk ü.json");
      writeFileSync(p, j(clean), "utf8");
      const out: string[] = [];
      const err: string[] = [];
      const code = main([p, "--today", "2026-06-15", "--strict"], { out: (s) => out.push(s), err: (s) => err.push(s) });
      expect(code).toBe(0);
      expect(out[0]).toBe("risk config OK");
      const missing = main([path.join(dir, "nope ü.json")], { out: () => {}, err: (s) => err.push(s) });
      expect(missing).toBe(1);
      expect(err.join("\n")).toContain("nope ü.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("success output goes to out, errors to err", () => {
    const ok = run(["f", "--today", "2026-06-15"], files);
    expect(ok.err).toEqual([]);
    const bad = run(["f", "--today", "2026-06-15"], { f: "{bad" });
    expect(bad.out).toEqual([]);
  });
});

describe("read-only guarantees", () => {
  const SECRET = "TM29_SECRET_canary_7f3a9c";
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("never prints env values", () => {
    vi.stubEnv("TM29_CANARY", SECRET);
    vi.stubEnv("OPENALGO_API_KEY", SECRET);
    vi.stubEnv("MCP_TOKEN", SECRET);
    vi.stubEnv("RISK_CONFIG", SECRET);
    const texts = [j(clean), "{}", "{bad", j({ bogus: 1 }), j({ maxQtyPerOrder: -1 }), ""];
    for (const t of texts) {
      for (const argv of [["f"], ["f", "--strict"], ["f", "--today", "2026-13-01"], ["f", "--today"], [], ["--x"], ["missing"]]) {
        const r = run(argv, { f: t });
        expect(r.all).not.toContain(SECRET);
      }
    }
  });
  it("makes no network calls", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", fetchSpy);
    run(["f", "--today", "2026-06-15", "--strict"], { f: j(clean) });
    run(["f"], { f: "{}" });
    run(["f"], { f: "{bad" });
    lintRisk(j({ symbolAllow: ["BTCUSD"], contractValues: {} }), T);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
