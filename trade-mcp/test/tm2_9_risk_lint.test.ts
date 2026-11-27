import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintRisk, main } from "../src/risk/lint.js";
import { riskSchema, loadConfig } from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(here, "../../deploy/risk.example.json");
const T = { today: "2026-06-15" };
const j = (o: unknown) => JSON.stringify(o);
const full = { marketHolidays: { NSE: ["2026-01-26"], MCX: ["2026-01-26", "2026-05-01"] } };

describe("lintRisk", () => {
  it("valid file: exit 0, no warnings, correct summary counts", () => {
    const r = lintRisk(j({ symbolAllow: ["A", "B", "C"], contractValues: { X: 1, Y: 2 }, maxQtyPerOrder: 7, maxOrdersPerDay: 9, marketHolidays: { NSE: ["2026-01-26", "2026-03-03", "2027-01-26"], MCX: ["2026-05-01"] } }), T);
    expect(r.code).toBe(0);
    const t = r.lines.join("\n");
    expect(t).toContain("maxQtyPerOrder: 7");
    expect(t).toContain("maxOrdersPerDay: 9");
    expect(t).toContain("symbolAllow 3");
    expect(t).toContain("contractValues: 2");
    expect(t).toContain("NSE: 2026: 2, 2027: 1");
    expect(t).toContain("MCX: 2026: 1");
    expect(t).not.toContain("warning:");
  });
  it("warns on no holidays for the year, uses --today year", () => {
    const r = lintRisk(j(full), { today: "2027-02-01" });
    expect(r.lines).toContain("warning: NSE: no holidays listed for 2027");
    expect(r.lines).toContain("warning: MCX: no holidays listed for 2027");
    expect(r.code).toBe(0);
  });
  it("warns on duplicate holiday", () => {
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-01-26", "2026-01-26"], MCX: ["2026-05-01"] } }), T);
    expect(r.lines).toContain("warning: NSE: duplicate holiday 2026-01-26");
  });
  it("warns on weekend holidays", () => {
    const r = lintRisk(j({ marketHolidays: { NSE: ["2026-06-13", "2026-06-14"], MCX: ["2026-05-01"] } }), T);
    expect(r.lines).toContain("warning: NSE: holiday 2026-06-13 falls on a Saturday");
    expect(r.lines).toContain("warning: NSE: holiday 2026-06-14 falls on a Sunday");
  });
  it("--strict gives exit 2 with warnings, 0 without", () => {
    expect(lintRisk(j({}), { ...T, strict: true }).code).toBe(2);
    expect(lintRisk(j({}), T).code).toBe(0);
    expect(lintRisk(j(full), { ...T, strict: true }).code).toBe(0);
  });
  it("parse errors: wrong type, unknown key, impossible date", () => {
    const a = lintRisk(j({ maxQtyPerOrder: "x" }), T);
    expect(a.code).toBe(1);
    expect(a.lines.some((l) => l.startsWith("maxQtyPerOrder: "))).toBe(true);
    const b = lintRisk(j({ bogus: 1 }), T);
    expect(b.code).toBe(1);
    expect(b.lines.join("\n")).toMatch(/\(root\): .*bogus/);
    const c = lintRisk(j({ marketHolidays: { NSE: ["2026-02-30"] } }), T);
    expect(c.code).toBe(1);
    expect(c.lines.some((l) => l.startsWith("marketHolidays.NSE.0: "))).toBe(true);
  });
  it("invalid JSON and bad --today", () => {
    expect(lintRisk("{nope", T)).toMatchObject({ code: 1 });
    expect(lintRisk("{}", { today: "2026-13-01" }).code).toBe(1);
    expect(lintRisk("{}", { today: "tomorrow" }).lines[0]).toContain("--today");
  });
});

describe("main", () => {
  const run = (argv: string[], files: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, {
      readFile: (p) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p];
      },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    return { code, out, err };
  };
  it("missing file", () => {
    const r = run(["nope.json"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("cannot read file nope.json");
  });
  it("no path / unknown option", () => {
    expect(run([]).code).toBe(1);
    expect(run(["--wat", "f"], { f: "{}" }).code).toBe(1);
  });
  it("invalid JSON", () => {
    const r = run(["f"], { f: "{bad" });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("not valid JSON");
  });
  it("bad --today / missing value", () => {
    expect(run(["f", "--today", "2026-02-30"], { f: "{}" }).code).toBe(1);
    expect(run(["f", "--today"], { f: "{}" }).code).toBe(1);
  });
  it("--strict exit codes", () => {
    expect(run(["f", "--today", "2026-06-15"], { f: "{}" }).code).toBe(0);
    expect(run(["f", "--today", "2026-06-15", "--strict"], { f: "{}" }).code).toBe(2);
  });
  it("default today is IST", () => {
    const out: string[] = [];
    // 2026-12-31T20:00Z is already 2027-01-01 in IST
    main(["f"], { readFile: () => j({ marketHolidays: { NSE: ["2026-01-26"], MCX: ["2026-01-26"] } }), out: (s) => out.push(s), err: () => {}, now: () => Date.parse("2026-12-31T20:00:00Z") });
    expect(out).toContain("warning: NSE: no holidays listed for 2027");
  });
});

describe("deploy/risk.example.json", () => {
  const text = readFileSync(examplePath, "utf8");
  it("lints with exit 0 and only the empty-holiday warnings", () => {
    const r = lintRisk(text, T);
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.startsWith("warning:"))).toEqual(["warning: NSE: no holidays listed for 2026", "warning: MCX: no holidays listed for 2026"]);
  });
  it("riskSchema is exported and parses like loadConfig", () => {
    const direct = riskSchema.parse(JSON.parse(text));
    const cfg = loadConfig({ OPENALGO_URL: "http://x", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(24), RISK_CONFIG: examplePath });
    expect(cfg.risk).toEqual(direct);
  });
});
