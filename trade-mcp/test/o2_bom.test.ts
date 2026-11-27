import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";
import { main } from "../src/risk/lint.js";

const base = {
  OPENALGO_URL: "http://localhost:5000/",
  OPENALGO_API_KEY: "secret-api-key-value",
  MCP_TOKEN: "t".repeat(24),
};
const BOM = "﻿";
const body = "{}";

function file(content: string | Buffer): string {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "bom-")), "risk.json");
  writeFileSync(p, content);
  return p;
}
function lint(p: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main([p, "--today", "2026-01-01"], { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } as never);
  return { code, out, err };
}

describe("O-2 BOM", () => {
  it("loadConfig: BOM file equals no-BOM file", () => {
    const a = loadConfig({ ...base, RISK_CONFIG: file(BOM + body) });
    const b = loadConfig({ ...base, RISK_CONFIG: file(body) });
    expect(a.risk).toEqual(b.risk);
  });
  it("loadConfig: double BOM, mid-file BOM, UTF-16 rejected", () => {
    expect(() => loadConfig({ ...base, RISK_CONFIG: file(BOM + BOM + body) })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RISK_CONFIG: file('{"a":' + BOM + "1}") })).toThrow(ConfigError);
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
    expect(() => loadConfig({ ...base, RISK_CONFIG: file(u16) })).toThrow(/not valid JSON/);
  });
  it("risk:lint: BOM file equals no-BOM file", () => {
    const a = lint(file(BOM + body));
    const b = lint(file(body));
    expect(a).toEqual({ ...b, err: a.err });
    expect(a.code).toBe(b.code);
    expect(a.err).toEqual(b.err);
  });
  it("risk:lint: double BOM and UTF-16 rejected", () => {
    const d = lint(file(BOM + BOM + body));
    expect(d.code).toBe(1);
    expect(d.err.join()).toMatch(/not valid JSON/);
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
    const u = lint(file(u16));
    expect(u.code).toBe(1);
    expect(u.err.join()).toMatch(/not valid JSON/);
  });
});
