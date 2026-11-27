import { describe, it, expect } from "vitest";
import { API_HEADER } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";

const LINES = API_HEADER.split("\n");
const rulesOf = (out: string) =>
  out.startsWith("// Rules:\n") ? out.slice("// Rules:\n".length).split("\n\n")[0].split("\n") : [];

describe("TM2-32 rank Rules lines by tokens matched", () => {
  it("includes the cap line for a broad + specific query", () => {
    const cap = LINES.filter((l) => l.toLowerCase().includes("maxshortoptionqtyperorder"));
    expect(cap.length).toBeGreaterThan(0);
    const r = rulesOf(searchApi("e maxShortOptionQtyPerOrder"));
    for (const c of cap) expect(r).toContain(c);
    expect(r.length).toBeLessThanOrEqual(8);
  });
  it("outputs in header order", () => {
    const r = rulesOf(searchApi("e maxShortOptionQtyPerOrder"));
    const idx = r.map((l) => LINES.indexOf(l));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it("<=8 matches keep header order and all lines", () => {
    const r = rulesOf(searchApi("maxShortOptionQtyPerOrder"));
    expect(r).toEqual(LINES.filter((l) => l.toLowerCase().includes("maxshortoptionqtyperorder")));
  });
  it("duplicate tokens count once", () => {
    expect(searchApi("e e e maxShortOptionQtyPerOrder")).toBe(searchApi("e maxShortOptionQtyPerOrder"));
  });
  it("no header match is unchanged", () => {
    expect(searchApi("zzzz-nothing")).toBe('No API entries match "zzzz-nothing".');
  });
  it("readonly renders no trade entry", () => {
    expect(searchApi("e maxShortOptionQtyPerOrder", "readonly")).not.toMatch(/namespace trade/);
  });
});
