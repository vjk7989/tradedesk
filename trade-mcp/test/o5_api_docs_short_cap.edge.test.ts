import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API_DOCS, API_HEADER } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";
import { riskSchema } from "../src/config.js";

const KEY = "maxShortOptionQtyPerOrder";
const ENGINE = readFileSync(path.resolve(__dirname, "../src/risk/engine.ts"), "utf8").replace(/\r\n/g, "\n");
const EXAMPLE_PATH = path.resolve(__dirname, "../../deploy/risk.example.json");

const lines = API_HEADER.split("\n");
const capLines = lines.filter((l) => l.includes(KEY));
const sentence = capLines[0] ?? "";

/** The single template literal in engine.ts that emits the short-option denial. */
function engineTemplate(): string {
  const hits = [...ENGINE.matchAll(/`([^`]*\$\{c\.maxShortOptionQtyPerOrder\}[^`]*)`/g)].map((m) => m[1]);
  expect(hits).toHaveLength(1);
  return hits[0];
}

describe("O-5 edge: the sentence content", () => {
  it("exactly one header line mentions the key, directly after the 'risk denied' line", () => {
    expect(capLines).toHaveLength(1);
    const deniedIdx = lines.findIndex((l) => l.startsWith("Risk violations are thrown as Error('risk denied: ...')"));
    expect(deniedIdx).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(sentence)).toBe(deniedIdx + 1);
  });

  it.each(["NFO", "BFO", "CE", "PE", "SELL"])("names %s as a whole word", (w) => {
    expect(sentence).toMatch(new RegExp(`\\b${w}\\b`));
  });

  it("says SELL, not BUY (only sells are capped)", () => {
    expect(sentence).not.toMatch(/\bBUY\b/);
  });

  it("names no other exchange (the engine only checks NFO and BFO)", () => {
    for (const ex of ["NSE", "BSE", "MCX", "CDS", "CRYPTO"]) expect(sentence).not.toMatch(new RegExp(`\\b${ex}\\b`));
  });

  it("states the cap is optional and off when unset", () => {
    expect(sentence).toMatch(/\boptional\b/i);
    expect(sentence).toMatch(/off when unset/i);
    expect(sentence).not.toMatch(/default\s*[:=]?\s*\d/i);
  });

  it("says a closing SELL is capped too (conservative)", () => {
    expect(sentence).toMatch(/closes a long is capped too/);
    expect(sentence).toMatch(/conservative/);
  });

  it("is a single line with no leaked newline or tab", () => {
    expect(sentence).not.toMatch(/[\r\n\t]/);
    expect(sentence.trim()).toBe(sentence);
  });
});

describe("O-5 edge: denial text matches engine.ts", () => {
  it("the engine template prefix up to the first ${ is quoted verbatim in the docs", () => {
    const tpl = engineTemplate();
    const prefix = tpl.slice(0, tpl.indexOf("${"));
    expect(prefix).toBe("short option qty ");
    expect(sentence).toContain(`'${prefix}`);
  });

  it("the whole template, with ${...} as <placeholders>, matches the quoted text", () => {
    const tpl = engineTemplate();
    const quoted = sentence.match(/'(short option qty [^']*)'/);
    expect(quoted).not.toBeNull();
    const shape = (s: string) => s.replace(/\$\{[^}]*\}/g, "<>").replace(/<[^>]*>/g, "<>");
    expect(shape(quoted![1])).toBe(shape(tpl));
    expect(shape(tpl)).toBe(`short option qty <> exceeds ${KEY} <>`);
  });

  it("the quoted text sits inside the 'risk denied' path (engine pushes it as a reason)", () => {
    expect(ENGINE).toMatch(/r\.push\(`short option qty \$\{/);
  });
});

describe("O-5 edge: config schema and example file", () => {
  it("riskSchema has the key", () => {
    expect(Object.keys(riskSchema.shape)).toContain(KEY);
  });

  it("the key is optional: {} parses and leaves it undefined (cap off)", () => {
    const r = riskSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.success && r.data[KEY]).toBeUndefined();
    expect(r.success && KEY in r.data).toBe(false);
  });

  it.each([
    [1, true],
    [0, false],
    [-1, false],
    [1.5, false],
    ["5", false],
    [null, false],
  ])("value %j parses: %s", (v, ok) => {
    expect(riskSchema.safeParse({ [KEY]: v }).success).toBe(ok);
  });

  it("deploy/risk.example.json does not set the key (off by default)", () => {
    const raw = readFileSync(EXAMPLE_PATH, "utf8");
    expect(raw).not.toContain(KEY);
    const parsed = riskSchema.safeParse(JSON.parse(raw.replace(/^﻿/, "")));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[KEY]).toBeUndefined();
  });
});

describe("O-5 edge: search surfaces the sentence", () => {
  it.each(["full", "readonly"] as const)("empty query in %s scope returns the header with the sentence", (scope) => {
    expect(searchApi("", scope)).toContain(sentence);
    expect(searchApi("   ", scope)).toContain(sentence);
  });

  // KNOWN GAP (O-5): searchApi with a non-empty query renders only API_DOCS entries, never API_HEADER,
  // so the header sentence cannot be found by keyword. Marked it.fails: when search (or the doc placement)
  // is fixed these turn red, so drop `.fails` then.
  it.fails.each([
    ["short option", "full"],
    ["short option", "readonly"],
    [KEY, "full"],
    [KEY, "readonly"],
    [KEY.toLowerCase(), "readonly"],
  ] as const)("query %j in %s scope returns the sentence", (q, scope) => {
    const out = searchApi(q, scope);
    expect(out).not.toMatch(/^No API entries match/); // the miss message echoes the query
    expect(out).toContain("short option qty <q> exceeds");
  });

  it("no API_DOCS entry duplicates the key with a different wording", () => {
    const others = API_DOCS.filter((d) => d.doc.includes(KEY));
    for (const d of others) expect(d.doc).toContain(`'short option qty <q> exceeds ${KEY} <n>'`);
  });
});
