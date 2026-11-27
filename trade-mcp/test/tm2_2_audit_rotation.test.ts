import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, utimesSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAudit } from "../src/risk/audit.js";

let dir: string;
let file: string;
const saved = { max: process.env.AUDIT_MAX_BYTES, ret: process.env.AUDIT_RETENTION_DAYS };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "audit-rot-"));
  file = path.join(dir, "audit.jsonl");
  delete process.env.AUDIT_MAX_BYTES;
  delete process.env.AUDIT_RETENTION_DAYS;
});
afterEach(() => {
  for (const [k, v] of [["AUDIT_MAX_BYTES", saved.max], ["AUDIT_RETENTION_DAYS", saved.ret]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const setMtime = (f: string, iso: string) => { const d = new Date(iso); utimesSync(f, d, d); };
const names = () => readdirSync(dir).sort();

describe("rotation", () => {
  it("loses and duplicates no line across 1000 appends with small max size", () => {
    process.env.AUDIT_MAX_BYTES = "2000";
    for (let i = 0; i < 1000; i++) appendAudit(file, { seq: i });
    const rotated = names().filter((n) => n !== "audit.jsonl");
    expect(rotated.length).toBeGreaterThan(1);
    const key = (n: string) => {
      const m = /^audit\.(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(n)!;
      return [m[1], Number(m[2] ?? 0)] as const;
    };
    rotated.sort((a, b) => { const [da, na] = key(a), [db, nb] = key(b); return da < db ? -1 : da > db ? 1 : na - nb; });
    const seqs: number[] = [];
    for (const n of [...rotated, "audit.jsonl"]) {
      for (const l of readFileSync(path.join(dir, n), "utf8").split("\n").filter(Boolean)) seqs.push(JSON.parse(l).seq);
    }
    expect(seqs).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  }, 30_000);

  it("IST boundary: 23:59:59.999 IST is not rotated, 00:00 IST next day is", () => {
    writeFileSync(file, '{"old":1}\n');
    setMtime(file, "2026-11-27T18:29:59.999Z");
    appendAudit(file, { a: 1 }, () => new Date("2026-11-27T18:29:59.999Z"));
    expect(names()).toEqual(["audit.jsonl"]);

    writeFileSync(file, '{"old":1}\n');
    setMtime(file, "2026-11-27T18:29:59.999Z");
    appendAudit(file, { a: 2 }, () => new Date("2026-11-27T18:30:00.000Z"));
    expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
    expect(readFileSync(path.join(dir, "audit.2026-11-27.jsonl"), "utf8")).toBe('{"old":1}\n');
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("names rotated file by IST date of mtime (UTC 20:00 is next IST day)", () => {
    writeFileSync(file, "x\n");
    setMtime(file, "2026-11-27T20:00:00.000Z");
    appendAudit(file, {}, () => new Date("2026-11-30T00:00:00.000Z"));
    expect(names()).toContain("audit.2026-11-28.jsonl");
  });

  it("size rotation on same day uses .1 suffix when dated name exists", () => {
    process.env.AUDIT_MAX_BYTES = "10";
    const now = () => new Date("2026-11-27T06:00:00.000Z");
    writeFileSync(file, "0123456789ABC\n");
    setMtime(file, "2026-11-27T05:00:00.000Z");
    appendAudit(file, { n: 1 }, now);
    expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
    setMtime(file, "2026-11-27T05:30:00.000Z");
    appendAudit(file, { n: 2 }, now);
    expect(names()).toEqual(["audit.2026-11-27.1.jsonl", "audit.2026-11-27.jsonl", "audit.jsonl"]);
  });

  it("file without extension rotates with .jsonl", () => {
    const f = path.join(dir, "audit");
    writeFileSync(f, "x\n");
    setMtime(f, "2026-11-20T05:00:00.000Z");
    appendAudit(f, {}, () => new Date("2026-11-27T05:00:00.000Z"));
    expect(names()).toEqual(["audit", "audit.2026-11-20.jsonl"]);
  });
});

describe("env parsing", () => {
  for (const bad of ["abc", "-5", "0", "", "Infinity", "NaN", "1.5"]) {
    it(`invalid AUDIT_MAX_BYTES=${JSON.stringify(bad)} falls back to 50MB default`, () => {
      process.env.AUDIT_MAX_BYTES = bad;
      writeFileSync(file, "x".repeat(5000) + "\n");
      appendAudit(file, {});
      expect(names()).toEqual(["audit.jsonl"]);
    });
    it(`invalid AUDIT_RETENTION_DAYS=${JSON.stringify(bad)} falls back to 90`, () => {
      process.env.AUDIT_RETENTION_DAYS = bad;
      writeFileSync(file, "x\n");
      setMtime(file, "2026-11-26T05:00:00.000Z");
      writeFileSync(path.join(dir, "audit.2026-08-29.jsonl"), "k"); // 90 days before 2026-11-27
      writeFileSync(path.join(dir, "audit.2026-08-28.jsonl"), "d"); // 91 days
      appendAudit(file, {}, () => new Date("2026-11-27T05:00:00.000Z"));
      expect(existsSync(path.join(dir, "audit.2026-08-29.jsonl"))).toBe(true);
      expect(existsSync(path.join(dir, "audit.2026-08-28.jsonl"))).toBe(false);
    });
  }

  it("valid AUDIT_MAX_BYTES is honoured", () => {
    process.env.AUDIT_MAX_BYTES = "100";
    writeFileSync(file, "x".repeat(100));
    appendAudit(file, {});
    expect(names()).toHaveLength(2);
  });
});

describe("retention", () => {
  it("keeps files exactly N days old, deletes N+1; never touches active or non-matching files", () => {
    process.env.AUDIT_RETENTION_DAYS = "10";
    // today (IST) = 2026-11-27
    const keep = ["audit.2026-11-17.jsonl", "audit.2026-11-17.3.jsonl", "audit.2026-11-26.jsonl"];
    const drop = ["audit.2026-11-16.jsonl", "audit.2026-11-16.2.jsonl", "audit.2020-01-01.jsonl"];
    const other = ["other.2020-01-01.jsonl", "audit.notes.txt", "audit.2020-01-01.log", "xaudit.2020-01-01.jsonl", "audit.2020-01-01.x.jsonl"];
    for (const n of [...keep, ...drop, ...other]) writeFileSync(path.join(dir, n), "x");
    writeFileSync(file, "active\n");
    setMtime(file, "2026-11-26T05:00:00.000Z");
    appendAudit(file, {}, () => new Date("2026-11-27T05:00:00.000Z"));
    for (const n of keep) expect(existsSync(path.join(dir, n)), n).toBe(true);
    for (const n of drop) expect(existsSync(path.join(dir, n)), n).toBe(false);
    for (const n of other) expect(existsSync(path.join(dir, n)), n).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(dir, "audit.2026-11-26.jsonl"))).toBe(true); // just rotated
  });

  it("uses IST today for the boundary", () => {
    process.env.AUDIT_RETENTION_DAYS = "10";
    writeFileSync(path.join(dir, "audit.2026-11-17.jsonl"), "x");
    writeFileSync(path.join(dir, "audit.2026-11-16.jsonl"), "x");
    writeFileSync(file, "x\n");
    setMtime(file, "2026-11-27T05:00:00.000Z");
    // UTC still 11-27 but IST is 11-28 -> 11-17 is 11 days old
    appendAudit(file, {}, () => new Date("2026-11-27T19:00:00.000Z"));
    expect(existsSync(path.join(dir, "audit.2026-11-17.jsonl"))).toBe(false);
  });
});

describe("existing behaviour", () => {
  it("throws when parent is a regular file", () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(() => appendAudit(path.join(blocker, "sub", "audit.jsonl"), {})).toThrow();
  });

  it("throws when target is a directory", () => {
    const d = path.join(dir, "adir.jsonl");
    mkdirSync(d);
    expect(() => appendAudit(d, {})).toThrow();
  });

  it("redacts secrets and uses injected clock for ts", () => {
    const f = path.join(dir, "nested", "audit.jsonl");
    appendAudit(f, { apiKey: "s", nested: { password: "p", ok: 1 } }, () => new Date("2026-01-02T03:04:05.000Z"));
    const e = JSON.parse(readFileSync(f, "utf8"));
    expect(e).toEqual({ apiKey: "[REDACTED]", nested: { password: "[REDACTED]", ok: 1 }, ts: "2026-01-02T03:04:05.000Z" });
    expect(statSync(f).size).toBeGreaterThan(0);
  });
});
