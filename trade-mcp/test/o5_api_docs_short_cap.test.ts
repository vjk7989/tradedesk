import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API_HEADER } from "../src/sdk/api-docs.js";

const engine = readFileSync(path.resolve(__dirname, "../src/risk/engine.ts"), "utf8");

describe("O-5 api-docs short option qty cap", () => {
  it("mentions maxShortOptionQtyPerOrder", () => {
    expect(API_HEADER).toContain("maxShortOptionQtyPerOrder");
  });
  it("quotes the denial prefix that engine.ts emits", () => {
    const m = engine.match(/`(short option qty )\$\{/);
    expect(m).not.toBeNull();
    expect(engine).toContain("`" + m![1] + "${");
    expect(API_HEADER).toContain(m![1]);
  });
});
