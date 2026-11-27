import { describe, it, expect } from "vitest";
import { searchApi } from "../src/sdk/search.js";
import { API_HEADER } from "../src/sdk/api-docs.js";

const lines = API_HEADER.split("\n");

describe("TM2-25 search matches API_HEADER rules", () => {
  it("risk denied shows a Rules block with header lines verbatim", () => {
    const out = searchApi("risk denied");
    expect(out.startsWith("// Rules:\n")).toBe(true);
    expect(out).toContain("Risk violations are thrown as Error('risk denied: ...')");
    const block = out.split("\n\n")[0].split("\n").slice(1);
    expect(block.length).toBeLessThanOrEqual(8);
    for (const l of block) expect(lines).toContain(l);
  });
  it("maxShortOptionQtyPerOrder returns the cap line before entries", () => {
    const out = searchApi("maxShortOptionQtyPerOrder");
    expect(out).toContain("// Rules:\nOptional risk cap maxShortOptionQtyPerOrder");
  });
  it("market closed and kill switch still return entries", () => {
    expect(searchApi("market closed")).toContain("// Rules:");
    expect(searchApi("kill switch")).toContain("killSwitch");
  });
  it("readonly scope still shows rules", () => {
    expect(searchApi("risk denied", "readonly")).toContain("// Rules:");
  });
  it("only header matches: rules without the no-match message", () => {
    const out = searchApi("maxShortOptionQtyPerOrder", "readonly");
    expect(out).toContain("// Rules:");
    expect(out).not.toContain("No API entries match");
  });
  it("no match anywhere keeps the old message", () => {
    expect(searchApi("zzzqqq")).toBe('No API entries match "zzzqqq".');
  });
  it("query matching no header line has no Rules block", () => {
    expect(searchApi("cancel")).not.toContain("// Rules:");
  });
});
