import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, utimesSync,
  statSync, rmSync, truncateSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAudit } from "../src/risk/audit.js";
import { createBindings } from "../src/sdk/bindings.js";
import { RiskEngine } from "../src/risk/engine.js";
import type { Config } from "../src/config.js";

const MB50 = 50 * 1024 * 1024;
const isWin = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let dir: string;
let file: string;
const saved = { max: process.env.AUDIT_MAX_BYTES, ret: process.env.AUDIT_RETENTION_DAYS };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "audit-rot-edge-"));
  file = path.join(dir, "audit.jsonl");
  delete process.env.AUDIT_MAX_BYTES;
  delete process.env.AUDIT_RETENTION_DAYS;
});
afterEach(() => {
  vi.useRealTimers();
  for (const [k, v] of [["AUDIT_MAX_BYTES", saved.max], ["AUDIT_RETENTION_DAYS", saved.ret]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

const setMtime = (f: string, iso: string | Date) => { const d = new Date(iso); utimesSync(f, d, d); };
const names = (d = dir) => readdirSync(d).sort();
const at = (iso: string) => () => new Date(iso);
const read = (n: string, d = dir) => readFileSync(path.join(d, n), "utf8");
const jsonLines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** Create `f` with exactly `size` bytes (sparse where supported). */
const sized = (f: string, size: number) => { writeFileSync(f, ""); truncateSync(f, size); };

describe("IST day boundary (injected clock)", () => {
  it("mtime 18:29:59.999Z, now 18:29:59.999Z -> same IST day, no rotation", () => {
    writeFileSync(file, '{"old":1}\n');
    setMtime(file, "2026-11-27T18:29:59.999Z");
    appendAudit(file, { a: 1 }, at("2026-11-27T18:29:59.999Z"));
    expect(names()).toEqual(["audit.jsonl"]);
    expect(jsonLines(file)).toHaveLength(2);
  });

  it("mtime 18:29:59.999Z, now 18:30:00.000Z -> rotates to the previous IST date", () => {
    writeFileSync(file, '{"old":1}\n');
    setMtime(file, "2026-11-27T18:29:59.999Z");
    appendAudit(file, { a: 1 }, at("2026-11-27T18:30:00.000Z"));
    expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
    expect(read("audit.2026-11-27.jsonl")).toBe('{"old":1}\n');
    expect(jsonLines(file)).toEqual([{ a: 1, ts: "2026-11-27T18:30:00.000Z" }]);
  });

  it("mtime 18:30:00.000Z, now 18:30:00.000Z -> both on the new IST day, no rotation", () => {
    writeFileSync(file, '{"old":1}\n');
    setMtime(file, "2026-11-27T18:30:00.000Z");
    appendAudit(file, { a: 1 }, at("2026-11-27T18:30:00.000Z"));
    expect(names()).toEqual(["audit.jsonl"]);
  });

  it("written seconds ago but on 'yesterday IST' (same UTC day) -> rotates, named by IST date of mtime", () => {
    writeFileSync(file, '{"old":1}\n');
    setMtime(file, "2026-11-27T18:29:58.000Z"); // 23:59:58 IST on 11-27
    appendAudit(file, { a: 1 }, at("2026-11-27T18:30:03.000Z")); // 00:00:03 IST on 11-28
    expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
  });

  it("UTC date differs but IST date is the same -> no rotation", () => {
    writeFileSync(file, '{"old":1}\n');
    setMtime(file, "2026-11-26T23:59:59.000Z"); // 05:29:59 IST on 11-27
    appendAudit(file, { a: 1 }, at("2026-11-27T00:00:01.000Z")); // 05:30:01 IST on 11-27
    expect(names()).toEqual(["audit.jsonl"]);
  });
});

describe("size boundary", () => {
  const NOW = "2026-11-27T06:00:00.000Z";
  it("size AUDIT_MAX_BYTES-1 does not rotate", () => {
    process.env.AUDIT_MAX_BYTES = "100";
    writeFileSync(file, "x".repeat(99));
    setMtime(file, NOW);
    appendAudit(file, { a: 1 }, at(NOW));
    expect(names()).toEqual(["audit.jsonl"]);
  });

  it("size exactly AUDIT_MAX_BYTES rotates", () => {
    process.env.AUDIT_MAX_BYTES = "100";
    writeFileSync(file, "x".repeat(100));
    setMtime(file, NOW);
    appendAudit(file, { a: 1 }, at(NOW));
    expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
    expect(statSync(path.join(dir, "audit.2026-11-27.jsonl")).size).toBe(100);
  });

  it("default 50 MB: 50MB-1 stays, exactly 50MB rotates", () => {
    sized(file, MB50 - 1);
    setMtime(file, NOW);
    appendAudit(file, { a: 1 }, at(NOW));
    expect(names()).toEqual(["audit.jsonl"]);
    truncateSync(file, MB50);
    setMtime(file, NOW);
    appendAudit(file, { a: 2 }, at(NOW));
    expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
  });
});

describe("rotated-name collisions", () => {
  const NOW = at("2026-11-28T06:00:00.000Z");
  it("existing .D, .D.1, .D.2 are never overwritten; next goes to .D.3", () => {
    const pre = { "audit.2026-11-26.jsonl": "A\n", "audit.2026-11-26.1.jsonl": "B\n", "audit.2026-11-26.2.jsonl": "C\n" };
    for (const [n, c] of Object.entries(pre)) writeFileSync(path.join(dir, n), c);
    writeFileSync(file, "D\n");
    setMtime(file, "2026-11-26T06:00:00.000Z");
    appendAudit(file, { a: 1 }, NOW);
    for (const [n, c] of Object.entries(pre)) expect(read(n), n).toBe(c);
    expect(read("audit.2026-11-26.3.jsonl")).toBe("D\n");
  });

  it("gap in the sequence (.D and .D.2 exist, .D.1 missing) does not overwrite .D.2", () => {
    writeFileSync(path.join(dir, "audit.2026-11-26.jsonl"), "A\n");
    writeFileSync(path.join(dir, "audit.2026-11-26.2.jsonl"), "C\n");
    writeFileSync(file, "D\n");
    setMtime(file, "2026-11-26T06:00:00.000Z");
    appendAudit(file, { a: 1 }, NOW);
    expect(read("audit.2026-11-26.jsonl")).toBe("A\n");
    expect(read("audit.2026-11-26.2.jsonl")).toBe("C\n");
    const all = names().filter((n) => n !== "audit.jsonl").map((n) => read(n)).sort();
    expect(all).toEqual(["A\n", "C\n", "D\n"]);
  });

  it("a directory occupying the dated name is skipped, not clobbered", () => {
    mkdirSync(path.join(dir, "audit.2026-11-26.jsonl"));
    writeFileSync(file, "D\n");
    setMtime(file, "2026-11-26T06:00:00.000Z");
    appendAudit(file, { a: 1 }, NOW);
    expect(statSync(path.join(dir, "audit.2026-11-26.jsonl")).isDirectory()).toBe(true);
    expect(read("audit.2026-11-26.1.jsonl")).toBe("D\n");
  });

  it("many same-day size rotations produce unique names and keep every line", () => {
    process.env.AUDIT_MAX_BYTES = "1";
    const now = new Date();
    for (let i = 0; i < 25; i++) appendAudit(file, { seq: i }, () => now);
    const rotated = names().filter((n) => n !== "audit.jsonl");
    expect(rotated).toHaveLength(24);
    expect(new Set(rotated).size).toBe(24);
    const total = [...rotated, "audit.jsonl"].flatMap((n) => jsonLines(path.join(dir, n))).map((e) => e.seq).sort((a, b) => a - b);
    expect(total).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});

describe("retention", () => {
  const NOW = at("2026-11-27T05:00:00.000Z"); // IST today 2026-11-27
  const rotateNow = () => {
    writeFileSync(file, "active\n");
    setMtime(file, "2026-11-26T05:00:00.000Z");
    appendAudit(file, { a: 1 }, NOW);
  };

  it("N=1: exactly 1 day old kept, 2 days old deleted", () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    writeFileSync(path.join(dir, "audit.2026-11-25.jsonl"), "x");
    writeFileSync(path.join(dir, "audit.2026-11-25.7.jsonl"), "x");
    rotateNow();
    expect(existsSync(path.join(dir, "audit.2026-11-26.jsonl"))).toBe(true); // N days old (just rotated)
    expect(existsSync(path.join(dir, "audit.2026-11-25.jsonl"))).toBe(false);
    expect(existsSync(path.join(dir, "audit.2026-11-25.7.jsonl"))).toBe(false);
  });

  it("N=30: day 30 kept, day 31 deleted (month boundary)", () => {
    process.env.AUDIT_RETENTION_DAYS = "30";
    writeFileSync(path.join(dir, "audit.2026-10-28.jsonl"), "keep"); // 30 days
    writeFileSync(path.join(dir, "audit.2026-10-27.jsonl"), "drop"); // 31 days
    rotateNow();
    expect(existsSync(path.join(dir, "audit.2026-10-28.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "audit.2026-10-27.jsonl"))).toBe(false);
  });

  it("ignores non-matching files even when very old", () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    const other = [
      "audit.jsonl.bak", "other.jsonl", "audit.2026-13-45.jsonl", "audit.2020-01-01.jsonl.bak",
      "other.2020-01-01.jsonl", "audit.2020-1-1.jsonl", "audit.20200101.jsonl", "audit.2020-01-01.-1.jsonl",
      "audit.2020-01-01.jsonl.gz", "audit.2020-01-01.log",
    ];
    for (const n of other) { writeFileSync(path.join(dir, n), "x"); setMtime(path.join(dir, n), "2020-01-01T00:00:00Z"); }
    rotateNow();
    for (const n of other) expect(existsSync(path.join(dir, n)), n).toBe(true);
  });

  it("ignores calendar-invalid dates such as 2026-02-30 / 2026-00-10 (not rotation names)", () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    writeFileSync(path.join(dir, "audit.2026-02-30.jsonl"), "x");
    writeFileSync(path.join(dir, "audit.2026-00-10.jsonl"), "x");
    rotateNow();
    expect(existsSync(path.join(dir, "audit.2026-00-10.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "audit.2026-02-30.jsonl"))).toBe(true);
  });

  it("never deletes the active file, even when its mtime is far older than N days", () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    writeFileSync(file, "ancient\n");
    setMtime(file, "2020-01-01T00:00:00Z");
    appendAudit(file, { fresh: 1 }, NOW);
    expect(existsSync(file)).toBe(true);
    expect(jsonLines(file)).toEqual([{ fresh: 1, ts: "2026-11-27T05:00:00.000Z" }]);
  });

  it("a directory matching the rotation pattern is not removed and does not break auditing", () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    mkdirSync(path.join(dir, "audit.2020-01-01.jsonl"));
    writeFileSync(path.join(dir, "audit.2020-01-01.jsonl", "inner"), "x");
    expect(() => rotateNow()).not.toThrow();
    expect(existsSync(path.join(dir, "audit.2020-01-01.jsonl", "inner"))).toBe(true);
    expect(jsonLines(file)).toHaveLength(1);
  });

  it("does not touch other streams' rotated files in the same dir", () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    writeFileSync(path.join(dir, "trades.2020-01-01.jsonl"), "x");
    writeFileSync(path.join(dir, "auditx.2020-01-01.jsonl"), "x");
    rotateNow();
    expect(existsSync(path.join(dir, "trades.2020-01-01.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "auditx.2020-01-01.jsonl"))).toBe(true);
  });
});

describe("env parsing falls back to defaults", () => {
  const NOW = "2026-11-27T06:00:00.000Z";
  const bad = ["abc", "-1", "0", "1e9", "99999999999999999999", "1.0", " ", "0x10", "+100", "Infinity"];

  for (const v of bad) {
    it(`AUDIT_MAX_BYTES=${JSON.stringify(v)} -> 50 MB (exactly 50 MB rotates)`, () => {
      process.env.AUDIT_MAX_BYTES = v;
      sized(file, MB50);
      setMtime(file, NOW);
      appendAudit(file, { a: 1 }, at(NOW));
      expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
    });
  }

  for (const v of bad) {
    it(`AUDIT_MAX_BYTES=${JSON.stringify(v)} -> 50 MB (50MB-1 stays)`, () => {
      process.env.AUDIT_MAX_BYTES = v;
      sized(file, MB50 - 1);
      setMtime(file, NOW);
      appendAudit(file, { a: 1 }, at(NOW));
      expect(names()).toEqual(["audit.jsonl"]);
    });
  }

  for (const v of bad) {
    it(`AUDIT_RETENTION_DAYS=${JSON.stringify(v)} -> 90 days`, () => {
      process.env.AUDIT_RETENTION_DAYS = v;
      writeFileSync(path.join(dir, "audit.2026-08-29.jsonl"), "k"); // 90 days before 11-27
      writeFileSync(path.join(dir, "audit.2026-08-28.jsonl"), "d"); // 91 days
      writeFileSync(file, "x\n");
      setMtime(file, "2026-11-26T05:00:00.000Z");
      appendAudit(file, {}, at("2026-11-27T05:00:00.000Z"));
      expect(existsSync(path.join(dir, "audit.2026-08-29.jsonl"))).toBe(true);
      expect(existsSync(path.join(dir, "audit.2026-08-28.jsonl"))).toBe(false);
    });
  }

  it("surrounding whitespace on a valid value is accepted", () => {
    process.env.AUDIT_MAX_BYTES = " 100 ";
    writeFileSync(file, "x".repeat(100));
    setMtime(file, NOW);
    appendAudit(file, { a: 1 }, at(NOW));
    expect(names()).toHaveLength(2);
  });
});

describe("no loss / no duplication", () => {
  it("2000 appends crossing the size limit: exactly 2000 lines, in order, none duplicated", () => {
    process.env.AUDIT_MAX_BYTES = "4096";
    for (let i = 0; i < 2000; i++) appendAudit(file, { seq: i, pad: "p".repeat(i % 37) });
    const rotated = names().filter((n) => n !== "audit.jsonl");
    expect(rotated.length).toBeGreaterThan(5);
    const key = (n: string) => {
      const m = /^audit\.(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(n);
      expect(m, n).not.toBeNull();
      return [m![1], Number(m![2] ?? 0)] as const;
    };
    rotated.sort((a, b) => { const [da, na] = key(a), [db, nb] = key(b); return da < db ? -1 : da > db ? 1 : na - nb; });
    const seqs: number[] = [];
    for (const n of [...rotated, "audit.jsonl"]) for (const e of jsonLines(path.join(dir, n))) seqs.push(e.seq);
    expect(seqs).toHaveLength(2000);
    expect(new Set(seqs).size).toBe(2000);
    expect(seqs).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    for (const n of rotated) {
      const sz = statSync(path.join(dir, n)).size;
      expect(sz).toBeGreaterThanOrEqual(4096);
      expect(sz).toBeLessThan(4096 + 200);
    }
  }, 30_000);

  it("rotation across the IST boundary mid-stream keeps every line, in order", () => {
    // mtime is the real write time, so make it follow the injected clock
    const t0 = Date.parse("2026-11-27T18:29:59.900Z");
    for (let i = 0; i < 200; i++) {
      const t = new Date(t0 + i);
      if (existsSync(file)) setMtime(file, new Date(t0 + i - 1));
      appendAudit(file, { seq: i }, () => t);
    }
    expect(names()).toEqual(["audit.2026-11-27.jsonl", "audit.jsonl"]);
    const seqs = [...jsonLines(path.join(dir, "audit.2026-11-27.jsonl")), ...jsonLines(file)].map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(jsonLines(file)[0].ts).toBe("2026-11-27T18:30:00.000Z");
  });
});

describe("fail-closed: unwritable targets still throw", () => {
  it("parent path is a regular file -> throws", () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(() => appendAudit(path.join(blocker, "audit.jsonl"), {}, at("2026-11-27T05:00:00Z"))).toThrow();
    expect(read("blocker")).toBe("x");
  });

  it("target is a directory -> throws", () => {
    mkdirSync(file);
    expect(() => appendAudit(file, {}, at("2026-11-27T05:00:00Z"))).toThrow();
  });

  it.skipIf(isRoot)("read-only active file on the same IST day -> throws", () => {
    writeFileSync(file, "x\n");
    const now = new Date();
    setMtime(file, now);
    chmodSync(file, 0o444);
    try {
      expect(() => appendAudit(file, { a: 1 }, () => now)).toThrow();
    } finally { chmodSync(file, 0o644); }
  });

  it.skipIf(isWin || isRoot)("read-only directory with no active file -> throws", () => {
    chmodSync(dir, 0o555);
    expect(() => appendAudit(file, { a: 1 })).toThrow();
  });

  it.skipIf(isWin || isRoot)("read-only directory with a rotation due -> throws and the old file is intact", () => {
    writeFileSync(file, "old\n");
    setMtime(file, "2026-11-20T05:00:00Z");
    chmodSync(dir, 0o555);
    expect(() => appendAudit(file, { a: 1 }, at("2026-11-27T05:00:00Z"))).toThrow();
    chmodSync(dir, 0o700);
    expect(read("audit.jsonl")).toBe("old\n");
  });
});

describe("Windows-style paths", () => {
  it("directory and file names with spaces and regex metacharacters rotate and retain correctly", () => {
    const d = path.join(dir, "my audit (prod) [x]+$");
    mkdirSync(d);
    const f = path.join(d, "audit log.v2.jsonl");
    process.env.AUDIT_RETENTION_DAYS = "1";
    writeFileSync(path.join(d, "audit log.v2.2020-01-01.jsonl"), "old");
    writeFileSync(path.join(d, "audit logXv2.2020-01-01.jsonl"), "lookalike"); // '.' must be literal
    writeFileSync(f, "x\n");
    setMtime(f, "2026-11-26T05:00:00Z");
    appendAudit(f, { a: 1 }, at("2026-11-27T05:00:00Z"));
    expect(names(d)).toEqual(["audit log.v2.2026-11-26.jsonl", "audit log.v2.jsonl", "audit logXv2.2020-01-01.jsonl"]);
  });

  it.skipIf(!isWin)("forward-slash and backslash spellings of the same Windows path behave the same", () => {
    const d = path.join(dir, "Program Files", "trade mcp");
    const back = path.join(d, "audit.jsonl");
    const fwd = back.replace(/\\/g, "/");
    appendAudit(fwd, { a: 1 }, at("2026-11-26T05:00:00Z"));
    setMtime(back, "2026-11-26T05:00:00Z");
    appendAudit(back, { a: 2 }, at("2026-11-27T05:00:00Z"));
    expect(names(d)).toEqual(["audit.2026-11-26.jsonl", "audit.jsonl"]);
    expect(jsonLines(path.join(d, "audit.2026-11-26.jsonl"))).toHaveLength(1);
    expect(jsonLines(back)).toHaveLength(1);
  });
});

describe("integration through bindings", () => {
  const OPEN = new Date("2026-01-07T04:30:00Z"); // Wed 10:00 IST
  const order = { symbol: "SBIN", exchange: "NSE", side: "BUY", quantity: 10, product: "MIS", priceType: "LIMIT", price: 100 };
  const mkClient = () => ({
    quotes: vi.fn(async () => ({ status: "success", data: { ltp: 200 } })),
    analyzerStatus: vi.fn(async () => ({ status: "success", data: { analyze_mode: true } })),
    pnl: vi.fn(async () => ({ status: "success", total_pnl: 0 })),
    placeOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    modifyOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    cancelOrder: vi.fn(async () => ({ status: "success", orderid: "1" })),
    closePosition: vi.fn(async () => ({ status: "success" })),
    history: vi.fn(async () => ({})),
    toggleAnalyzer: vi.fn(async () => ({})),
  });
  function setup(auditFile: string) {
    const risk = {
      allowedExchanges: ["NSE"], allowedProducts: ["MIS"], symbolAllow: [], symbolDeny: [],
      maxQtyPerOrder: 100, maxNotionalPerOrder: 50000, maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20, maxNotionalPerDay: 200000, maxDailyLoss: 5000, maxOrdersPerRun: 5,
    };
    const kill = path.join(dir, "KILL");
    const engine = new RiskEngine(risk as any, { mode: "paper", killSwitchFile: kill, stateFile: path.join(dir, "st.json"), now: () => OPEN });
    const cfg = { mode: "paper", risk, killSwitchFile: kill } as unknown as Config;
    const client = mkClient();
    return { b: createBindings({ client: client as any, risk: engine, cfg, auditFile }, { id: "r1" }), client };
  }

  it("trade.place with a rotation-triggering clock audits exactly one line in the new active file", async () => {
    const auditFile = path.join(dir, "logs", "audit.jsonl");
    mkdirSync(path.dirname(auditFile));
    writeFileSync(auditFile, '{"prev":1}\n');
    setMtime(auditFile, "2026-01-06T10:00:00Z"); // IST 2026-01-06, the day before OPEN
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OPEN);
    const { b, client } = setup(auditFile);
    await b.trade.place(order);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(names(path.dirname(auditFile))).toEqual(["audit.2026-01-06.jsonl", "audit.jsonl"]);
    expect(read("audit.2026-01-06.jsonl", path.dirname(auditFile))).toBe('{"prev":1}\n');
    const ls = jsonLines(auditFile);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ run: "r1", action: "trade.place", decision: "allowed", ts: OPEN.toISOString() });
  });

  it("fail-closed probe still refuses when the audit dir is a regular file", async () => {
    const blocker = path.join(dir, "logs");
    writeFileSync(blocker, "not a dir");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { b, client } = setup(path.join(blocker, "audit.jsonl"));
      await expect(b.trade.place(order)).rejects.toThrow(/audit log unavailable/);
      expect(client.placeOrder).not.toHaveBeenCalled();
      expect(read("logs")).toBe("not a dir");
    } finally { errSpy.mockRestore(); }
  });
});
