import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError, stripBom } from "../src/config.js";
import { lintRisk, main } from "../src/risk/lint.js";

const base = {
  OPENALGO_URL: "http://localhost:5000/",
  OPENALGO_API_KEY: "secret-api-key-value",
  MCP_TOKEN: "t".repeat(24),
};
const BOM = "﻿";
const TODAY = "2026-01-01";
const dir = mkdtempSync(path.join(tmpdir(), "o2-bom-edge-"));
let n = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(content: string | Buffer): string {
  const p = path.join(dir, `risk-${n++}.json`);
  writeFileSync(p, content);
  return p;
}
function load(content: string | Buffer) {
  return loadConfig({ ...base, RISK_CONFIG: file(content) });
}
function cli(content: string | Buffer, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main([file(content), "--today", TODAY, ...extra], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out, err };
}

const valid = JSON.stringify({ maxQtyPerOrder: 7, symbolAllow: ["RELIANCE"], marketHolidays: { NSE: ["2026-01-26"] } });
const u16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const u16be = (s: string) => {
  const le = Buffer.from(s, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
};
const utf8Bom = (s: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, "utf8")]);
const large = JSON.stringify({ symbolAllow: Array.from({ length: 50000 }, (_, i) => `SYM${i}`), maxQtyPerOrder: 3 }, null, 2);

const rejected: Array<[string, string | Buffer]> = [
  ["empty file", ""],
  ["lone BOM", BOM],
  ["BOM + whitespace only", BOM + " \r\n"],
  ["BOM + invalid JSON", BOM + "{not json"],
  ["double BOM", BOM + BOM + valid],
  ["BOM in the middle", '{"maxQtyPerOrder":' + BOM + "7}"],
  ["whitespace before BOM", "  " + BOM + valid],
  ["U+FFFE prefix", "￾" + valid],
  ["UTF-16LE BOM bytes", u16le(valid)],
  ["UTF-16BE BOM bytes", u16be(valid)],
];

describe("O-2 edge: stripBom", () => {
  it("empty string -> empty string", () => expect(stripBom("")).toBe(""));
  it("lone BOM -> empty string", () => expect(stripBom(BOM)).toBe(""));
  it("BOM + whitespace + JSON -> whitespace + JSON", () => expect(stripBom(BOM + " \r\n\t{}")).toBe(" \r\n\t{}"));
  it("BOM + invalid JSON -> only the BOM removed", () => expect(stripBom(BOM + "{x")).toBe("{x"));
  it("double BOM -> exactly one removed", () => expect(stripBom(BOM + BOM + "{}")).toBe(BOM + "{}"));
  it("BOM in the middle is untouched", () => expect(stripBom("{" + BOM + "}")).toBe("{" + BOM + "}"));
  it("trailing BOM is untouched", () => expect(stripBom("{}" + BOM)).toBe("{}" + BOM));
  it("U+FFFE is not a BOM", () => expect(stripBom("￾{}")).toBe("￾{}"));
  it("UTF-16LE / BE BOM bytes read as utf8 are not stripped (decode to U+FFFD)", () => {
    const le = u16le("{}").toString("utf8");
    const be = u16be("{}").toString("utf8");
    expect(le.charCodeAt(0)).toBe(0xfffd);
    expect(be.charCodeAt(0)).toBe(0xfffd);
    expect(stripBom(le)).toBe(le);
    expect(stripBom(be)).toBe(be);
  });
  it("UTF-8 BOM bytes EF BB BF decoded as utf8 are stripped", () => {
    expect(stripBom(utf8Bom("{}").toString("utf8"))).toBe("{}");
  });
  it("no BOM -> identity", () => expect(stripBom(valid)).toBe(valid));
  it("large input: only the first char removed", () => {
    const r = stripBom(BOM + large);
    expect(r.length).toBe(large.length);
    expect(r).toBe(large);
  });
});

describe("O-2 edge: loadConfig RISK_CONFIG", () => {
  it("AC1: BOM file deep-equals no-BOM file", () => {
    const a = load(BOM + valid).risk;
    expect(a).toEqual(load(valid).risk);
    expect(a.maxQtyPerOrder).toBe(7);
  });
  it("AC1: EF BB BF bytes + whitespace + CRLF pretty JSON deep-equals no-BOM", () => {
    const pretty = JSON.stringify(JSON.parse(valid), null, 2).replace(/\n/g, "\r\n");
    expect(load(utf8Bom(" \r\n" + pretty + "\r\n")).risk).toEqual(load(valid).risk);
  });
  it("AC1: BOM + {} equals defaults", () => {
    expect(load(BOM + "{}").risk).toEqual(load("{}").risk);
  });
  it("AC1: large BOM file deep-equals no-BOM file", () => {
    const a = load(BOM + large).risk;
    expect(a).toEqual(load(large).risk);
    expect(a.symbolAllow.length).toBe(50000);
  });
  it("BOM inside string values is preserved", () => {
    const r = load(BOM + JSON.stringify({ symbolAllow: [BOM + "ABC", "X" + BOM] })).risk;
    expect(r.symbolAllow).toEqual([BOM + "ABC", "X" + BOM]);
  });
  it("schema errors after a BOM are still reported, same message as no-BOM", () => {
    const bad = JSON.stringify({ maxQtyPerOrder: -1 });
    let a: unknown;
    let b: unknown;
    try {
      load(BOM + bad);
    } catch (e) {
      a = e;
    }
    try {
      load(bad);
    } catch (e) {
      b = e;
    }
    expect(a).toBeInstanceOf(ConfigError);
    expect((a as Error).message).toMatch(/maxQtyPerOrder/);
    expect((a as Error).message).toBe((b as Error).message);
  });
  it("unknown key after a BOM is still rejected", () => {
    expect(() => load(BOM + '{"nope":1}')).toThrow(/unknown key/);
  });
  it("__proto__ guard still applies after a BOM", () => {
    expect(() => load(BOM + '{"contractValues":{"__proto__":1}}')).toThrow(/contractValues/);
  });
  for (const [name, content] of rejected) {
    it(`rejects ${name} with a clear ConfigError`, () => {
      let e: unknown;
      try {
        load(content);
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/not valid JSON/);
    });
  }
});

describe("O-2 edge: lintRisk (pure)", () => {
  it("AC1: BOM text gives identical result to no-BOM", () => {
    const a = lintRisk(BOM + valid, { today: TODAY });
    expect(a.code).toBe(0);
    expect(a).toEqual(lintRisk(valid, { today: TODAY }));
  });
  it("AC1: strict warnings (code 2) identical with BOM", () => {
    const w = JSON.stringify({ marketHolidays: { NSE: ["2026-01-03"] } }); // a Saturday
    const a = lintRisk(BOM + w, { today: TODAY, strict: true });
    expect(a.code).toBe(2);
    expect(a).toEqual(lintRisk(w, { today: TODAY, strict: true }));
  });
  it("schema errors after a BOM still reported, identical to no-BOM", () => {
    const bad = JSON.stringify({ maxQtyPerOrder: -1, symbolAllow: "x" });
    const a = lintRisk(BOM + bad, { today: TODAY });
    expect(a.code).toBe(1);
    expect(a.lines[0]).toBe("error: risk config is invalid");
    expect(a.lines.some((l) => l.startsWith("maxQtyPerOrder:"))).toBe(true);
    expect(a.lines.some((l) => l.startsWith("symbolAllow:"))).toBe(true);
    expect(a).toEqual(lintRisk(bad, { today: TODAY }));
  });
  it("invalid --today is still checked first with BOM text", () => {
    const a = lintRisk(BOM + valid, { today: "2026-02-30" });
    expect(a.code).toBe(1);
    expect(a.lines[0]).toMatch(/--today/);
  });
  it("large BOM text identical to no-BOM", () => {
    const a = lintRisk(BOM + large, { today: TODAY });
    expect(a).toEqual(lintRisk(large, { today: TODAY }));
    expect(a.lines.join("\n")).toMatch(/symbolAllow 50000/);
  });
  it("BOM in string values is kept (still 2 entries, no error)", () => {
    const a = lintRisk(BOM + JSON.stringify({ symbolAllow: [BOM + "A", BOM] }), { today: TODAY });
    expect(a.code).toBe(0);
    expect(a.lines.join("\n")).toMatch(/symbolAllow 2,/);
  });
  for (const [name, content] of rejected) {
    it(`rejects ${name}: code 1, not valid JSON`, () => {
      const text = typeof content === "string" ? content : content.toString("utf8");
      expect(lintRisk(text, { today: TODAY })).toEqual({ code: 1, lines: ["error: file is not valid JSON"] });
    });
  }
});

describe("O-2 edge: risk:lint CLI (main, real file read)", () => {
  it("AC1: BOM file exits 0 with identical stdout/stderr", () => {
    const a = cli(BOM + valid);
    expect(a.code).toBe(0);
    expect(a.err).toEqual([]);
    expect(a).toEqual(cli(valid));
  });
  it("AC1: EF BB BF bytes on disk exit 0, identical", () => {
    const a = cli(utf8Bom(valid));
    expect(a.code).toBe(0);
    expect(a).toEqual(cli(valid));
  });
  it("--strict exit 2 identical with BOM", () => {
    const w = JSON.stringify({ marketHolidays: { NSE: ["2026-01-03"] } });
    const a = cli(BOM + w, ["--strict"]);
    expect(a.code).toBe(2);
    expect(a).toEqual(cli(w, ["--strict"]));
  });
  it("schema errors after BOM: exit 1, errors on stderr, identical to no-BOM", () => {
    const bad = JSON.stringify({ maxQtyPerOrder: 0 });
    const a = cli(BOM + bad);
    expect(a.code).toBe(1);
    expect(a.out).toEqual([]);
    expect(a.err[0]).toBe("error: risk config is invalid");
    expect(a.err.join("\n")).toMatch(/maxQtyPerOrder/);
    expect(a).toEqual(cli(bad));
  });
  it("large BOM file: exit 0, identical", () => {
    const a = cli(BOM + large);
    expect(a.code).toBe(0);
    expect(a).toEqual(cli(large));
  });
  for (const [name, content] of rejected) {
    it(`rejects ${name}: exit 1, stderr not valid JSON, no stdout`, () => {
      const r = cli(content);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err).toEqual(["error: file is not valid JSON"]);
    });
  }
});
