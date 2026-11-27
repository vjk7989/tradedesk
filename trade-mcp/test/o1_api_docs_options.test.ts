import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { API_DOCS } from "../src/sdk/api-docs.js";

const KEYS = [
  "in_opt_brokerage",
  "in_opt_stt",
  "in_opt_exchange_txn",
  "in_opt_sebi_fee",
  "in_opt_stamp_duty",
  "in_opt_gst",
];
const doc = API_DOCS.find((d) => d.ns === "backtest" && d.name === "run")!.doc;
const PY = path.resolve(__dirname, "../../bt-service/vibe_bt/backtest/engines/india_options.py");

describe("O-1 api-docs india_options", () => {
  it("documents every in_opt_* key and opt_short_margin_pct", () => {
    for (const k of [...KEYS, "opt_short_margin_pct"]) expect(doc).toContain(k);
  });
  it("no longer says options are unsupported", () => {
    expect(doc).not.toContain("options are not supported");
  });
  it.skipIf(!existsSync(PY))("every documented in_opt_* key exists in india_options.py (skips if ../bt-service is absent)", () => {
    const py = readFileSync(PY, "utf8");
    const documented = doc.match(/in_opt_[a-z_]+/g) ?? [];
    expect(documented.length).toBeGreaterThan(0);
    for (const k of documented) expect(py).toContain(k);
  });
});
