import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API_DOCS } from "../src/sdk/api-docs.js";

// O-12: the WALKFORWARD_NOTE partial-fold sentence must match what the service really returns.
// The claims are checked against source (walkforward.py builds the reply, bindings.ts maps it).
const PY = path.resolve(__dirname, "../../bt-service/bt_service/walkforward.py");
const BINDINGS = path.resolve(__dirname, "../src/sdk/bindings.ts");
const SENTENCE =
  "On ok:false, `folds` holds only the folds completed before the failure (possibly empty); summary and oosEquity are empty; check ok and error.";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Every `return {...}` dict literal in the Python source, brace-balanced (strings in it hold no braces we care about). */
function returnDicts(py: string): string[] {
  const out: string[] = [];
  const re = /\breturn\s*\{/g;
  for (let m = re.exec(py); m; m = re.exec(py)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < py.length; i++) {
      if (py[i] === "{") depth++;
      else if (py[i] === "}" && --depth === 0) break;
    }
    out.push(py.slice(m.index, i + 1));
  }
  return out;
}

const isFailure = (d: string) => /["']ok["']\s*:\s*False\b/.test(d);

/** The sentence's claims hold for this source: failure dicts carry no summary/oos_equity and only `folds` itself. */
function failureClaimsHold(py: string): boolean {
  const fails = returnDicts(py).filter(isFailure);
  if (fails.length === 0) return false;
  for (const d of fails) {
    if (/["'](summary|oos_equity)["']\s*:/.test(d)) return false;
    const f = d.match(/["']folds["']\s*:\s*([^,}\n]+)/);
    if (f && f[1].trim() !== "folds") return false;
  }
  return fails.some((d) => /["']folds["']\s*:\s*folds\b/.test(d));
}

describe("O-12 edge: walkForward partial-fold note matches walkforward.py", () => {
  const py = read(PY);
  const wf = API_DOCS.find((d) => d.ns === "backtest" && d.name === "walkForward")!;

  it("the note carries the sentence exactly once, at the end of the Result line", () => {
    expect(wf).toBeDefined();
    expect(wf.doc.split(SENTENCE)).toHaveLength(2);
    const res = wf.doc.split("\n").find((l) => l.startsWith("Result: "));
    expect(res?.endsWith(" " + SENTENCE)).toBe(true);
  });

  it("every ok:False return keeps only the completed `folds` list and never sets summary/oos_equity", () => {
    const fails = returnDicts(py).filter(isFailure);
    expect(fails.length).toBeGreaterThanOrEqual(3);
    expect(failureClaimsHold(py)).toBe(true);
    // the fold-test failure path: returns the completed folds (and warnings), nothing else from the run
    const testFail = fails.find((d) => /test run failed/.test(d));
    expect(testFail, "fold test-run failure return").toBeDefined();
    expect(testFail).toMatch(/["']folds["']\s*:\s*folds\b/);
    // the success return is the only one that sets summary and oos_equity
    const ok = returnDicts(py).filter((d) => /["']summary["']\s*:/.test(d));
    expect(ok).toHaveLength(1);
    expect(isFailure(ok[0])).toBe(false);
    expect(ok[0]).toMatch(/["']oos_equity["']\s*:/);
  });

  it("`folds` starts empty and a fold is appended only after its test run succeeded (possibly empty, completed only)", () => {
    expect(py).toMatch(/\bfolds\s*:\s*list\[dict\]\s*=\s*\[\]/);
    const guard = py.search(/if not test_res\.get\(["']ok["']\)\s*:/);
    const appends = [...py.matchAll(/\bfolds\.append\(/g)].map((m) => m.index!);
    expect(guard).toBeGreaterThan(0);
    expect(appends).toHaveLength(1);
    expect(appends[0]).toBeGreaterThan(guard);
  });

  it("bindings.ts maps a missing summary/oos_equity/folds to empty values", () => {
    const b = read(BINDINGS);
    expect(b).toMatch(/summary:\s*r\.summary\s*\?\?\s*\{\}/);
    expect(b).toMatch(/oosEquity:\s*downsample\(\s*r\.oos_equity\s*\?\?\s*\[\]/);
    expect(b).toMatch(/\(r\.folds\s*\?\?\s*\[\]\)/);
  });

  it("strictness: a failure return that sets summary/oos_equity or a different folds value is rejected", () => {
    const tf = /"folds": folds,\n(\s*)"warnings": warnings,/;
    expect(py).toMatch(tf);
    expect(failureClaimsHold(py.replace(tf, '"folds": folds,\n$1"summary": {},\n$1"warnings": warnings,'))).toBe(false);
    expect(failureClaimsHold(py.replace(tf, '"folds": folds,\n$1"oos_equity": [],\n$1"warnings": warnings,'))).toBe(false);
    expect(failureClaimsHold(py.replace(tf, '"folds": [],\n$1"warnings": warnings,'))).toBe(false);
    expect(failureClaimsHold(py.replace(/"folds": folds/g, '"folds": None'))).toBe(false);
    expect(failureClaimsHold("")).toBe(false);
  });
});
