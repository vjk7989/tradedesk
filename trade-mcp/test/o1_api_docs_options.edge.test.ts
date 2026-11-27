import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as docsMod from "../src/sdk/api-docs.js";
import { API_DOCS, API_HEADER, CRYPTO_NOTE } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";

const PY = path.resolve(__dirname, "../../bt-service/vibe_bt/backtest/engines/india_options.py");
const HAS_PY = existsSync(PY);
const run = API_DOCS.find((d) => d.ns === "backtest" && d.name === "run")!;
const doc = run.doc;
const optLine = doc.split("\n").find((l) => l.startsWith("F&O options"))!;

/** config.get("<key>", <numeric default>) for in_opt_* and opt_short_margin_pct. */
function engineDefaults(): Map<string, number> {
  const py = readFileSync(PY, "utf8").replace(/\r\n/g, "\n");
  const out = new Map<string, number>();
  const re = /config\.get\(\s*["'](in_opt_[a-z_]+|opt_short_margin_pct)["']\s*,\s*([-+0-9.eE]+)\s*\)/g;
  for (const m of py.matchAll(re)) out.set(m[1], Number(m[2]));
  return out;
}

/** Defaults as stated in the docs: first number inside "key (...)". */
function docDefaults(): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of doc.matchAll(/\b(in_opt_[a-z_]+) \(([^)]*)\)/g)) {
    const n = m[2].match(/\d+(?:\.\d+)?(?:e-?\d+)?/i);
    if (n) out.set(m[1], Number(n[0]));
  }
  const sm = doc.match(/opt_short_margin_pct \(default ([0-9.]+)\)/);
  if (sm) out.set("opt_short_margin_pct", Number(sm[1]));
  return out;
}

describe("O-1 edge: documented defaults equal india_options.py", () => {
  it("options line exists exactly once in the backtest.run doc", () => {
    expect(optLine).toBeDefined();
    expect(doc.split("\n").filter((l) => l.startsWith("F&O options")).length).toBe(1);
  });

  it.skipIf(!HAS_PY)("engine source parses to all six in_opt_* keys plus opt_short_margin_pct", () => {
    const e = engineDefaults();
    expect([...e.keys()].sort()).toEqual(
      [
        "in_opt_brokerage",
        "in_opt_exchange_txn",
        "in_opt_gst",
        "in_opt_sebi_fee",
        "in_opt_stamp_duty",
        "in_opt_stt",
        "opt_short_margin_pct",
      ].sort(),
    );
    for (const v of e.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it.skipIf(!HAS_PY)("every documented default equals the engine config.get default", () => {
    const e = engineDefaults();
    const d = docDefaults();
    for (const [k, v] of e) {
      expect(d.has(k), `docs state no default for ${k}`).toBe(true);
      expect(d.get(k), `default for ${k}`).toBe(v);
    }
  });

  it.skipIf(!HAS_PY)("no in_opt_* key in the engine is missing from the docs, and the reverse", () => {
    const py = readFileSync(PY, "utf8");
    const engineKeys = new Set(py.match(/in_opt_[a-z_]+/g) ?? []);
    const docKeys = new Set(doc.match(/in_opt_[a-z_]+/g) ?? []);
    expect(engineKeys.size).toBeGreaterThan(0);
    expect([...docKeys].sort()).toEqual([...engineKeys].sort());
  });

  it.skipIf(!HAS_PY)("each documented in_opt_* key has a stated default (none left bare)", () => {
    const docKeys = new Set(doc.match(/in_opt_[a-z_]+/g) ?? []);
    const d = docDefaults();
    for (const k of docKeys) expect(d.has(k), k).toBe(true);
  });

  it("in_opt_* keys appear only on the options line, in_fno_* only on the futures line", () => {
    for (const l of doc.split("\n")) {
      if (/in_opt_/.test(l)) expect(l.startsWith("F&O options")).toBe(true);
      if (/in_fno_/.test(l)) expect(l.startsWith("F&O futures")).toBe(true);
    }
  });

  it("skip notice when engine source is absent", () => {
    if (!HAS_PY) console.warn(`O-1 edge: engine cross-checks skipped, ${PY} not found`);
    expect(true).toBe(true);
  });
});

describe("O-1 edge: search tool finds the options text", () => {
  it.each(["options", "CE", "india_options", "short margin", "OPTIONS", "  india_options  ", "in_opt_stt"])(
    "searchApi(%j) returns backtest.run with the india_options line",
    (q) => {
      const s = searchApi(q);
      expect(s).toContain("declare namespace backtest");
      expect(s).toContain("function run(");
      expect(s).toContain(optLine);
    },
  );

  it("readonly scope also returns the options text (backtest is not trade)", () => {
    expect(searchApi("india_options", "readonly")).toContain(optLine);
  });

  it("hit cap (20 in search.ts) cannot cut backtest.run for broad queries like 'CE'", () => {
    expect(API_DOCS.length).toBeLessThanOrEqual(20);
  });

  it("near-miss query does not falsely match", () => {
    expect(searchApi("india_optionz")).toContain("No API entries match");
  });
});

describe("O-1 edge: stale wording removed", () => {
  it("no 'options are not supported' (any case) anywhere in API docs or header", () => {
    const all = [API_HEADER, CRYPTO_NOTE, ...API_DOCS.map((d) => `${d.signature}\n${d.doc}`)].join("\n");
    expect(all).not.toMatch(/options\s+are\s+not\s+supported/i);
    expect(all).not.toMatch(/options?\s+(?:is|are)\s+(?:not|un)\s*supported/i);
  });

  it("FUT routing stays on india_fno and options route to india_options", () => {
    const fut = doc.split("\n").find((l) => l.startsWith("F&O futures"))!;
    expect(fut).toContain("india_fno");
    expect(fut).not.toContain("india_options");
    expect(optLine).toContain("india_options");
    expect(optLine).toMatch(/CE\|PE@NFO\|BFO/);
  });
});

describe("O-1 edge: size", () => {
  // No explicit api-docs size limit exists in src (search.ts caps hits at 20, not bytes; server.ts
  // MAX_CODE_BYTES applies to user code). Guard the only related bound: the backtest.run doc must
  // stay below the 100KB code cap so a full search response stays reasonable.
  it("backtest.run doc and the full rendered search stay well under 100KB", () => {
    expect(Buffer.byteLength(doc, "utf8")).toBeLessThan(100 * 1024);
    expect(Buffer.byteLength(searchApi("e"), "utf8")).toBeLessThan(100 * 1024);
  });
});

// ---- untouched sections compared against main ----
function mainSource(): string | null {
  const repo = path.resolve(__dirname, "../..");
  for (const ref of ["origin/main", "main"]) {
    try {
      return execFileSync("git", ["show", `${ref}:trade-mcp/src/sdk/api-docs.ts`], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      /* try next ref */
    }
  }
  return null;
}
const MAIN_SRC = mainSource();
// O-3 changed these on purpose: the busy text is now the exact client message, and audit.recent is new.
const fixBusy = (t: string) => t.split("'busy, retry later'").join("'backtest service busy, retry later'");
const O3_NEW = (d: { ns: string; name: string }) => d.ns === "audit" && d.name === "recent";

describe.skipIf(!MAIN_SRC)("O-1 edge: walkForward and crypto sections unchanged vs main", () => {
  let main: typeof docsMod;
  let tmp = "";
  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "o1-main-"));
    const f = path.join(tmp, "api-docs-main.ts");
    writeFileSync(f, MAIN_SRC!);
    main = (await import(/* @vite-ignore */ pathToFileURL(f).href)) as typeof docsMod;
    return () => rmSync(tmp, { recursive: true, force: true });
  });

  it("CRYPTO_NOTE and API_HEADER identical", () => {
    expect(CRYPTO_NOTE).toBe(main.CRYPTO_NOTE);
    expect(API_HEADER).toBe(main.API_HEADER);
  });

  it("walkForward entry identical (signature and doc)", () => {
    const a = API_DOCS.find((d) => d.ns === "backtest" && d.name === "walkForward")!;
    const b = main.API_DOCS.find((d) => d.ns === "backtest" && d.name === "walkForward")!;
    expect(a).toBeDefined();
    expect(a.signature).toBe(b.signature);
    expect(a.doc).toBe(fixBusy(b.doc));
    expect(a.doc).toContain("'backtest service busy, retry later'");
    expect(a.doc).not.toContain("'busy, retry later'");
  });

  it("every entry other than backtest.run is identical, same order", () => {
    const strip = (xs: docsMod.ApiDoc[]) => xs.filter((d) => !(d.ns === "backtest" && d.name === "run") && !O3_NEW(d));
    expect(strip(API_DOCS)).toEqual(strip(main.API_DOCS).map((d) => ({ ...d, doc: fixBusy(d.doc) })));
    const key = (d: docsMod.ApiDoc) => `${d.ns}.${d.name}`;
    expect(API_DOCS.filter((d) => !O3_NEW(d)).map(key)).toEqual(main.API_DOCS.filter((d) => !O3_NEW(d)).map(key));
    // audit.recent is the one new entry, directly before risk.status
    const names = API_DOCS.map(key);
    expect(names.filter((n) => n === "audit.recent")).toHaveLength(1);
    expect(names.indexOf("audit.recent")).toBe(names.indexOf("risk.status") - 1);
  });

  it("backtest.run: crypto costs line and all other non-F&O lines unchanged; only the options line is new", () => {
    const mainRun = main.API_DOCS.find((d) => d.ns === "backtest" && d.name === "run")!;
    expect(run.signature).toBe(mainRun.signature);
    const isFno = (l: string) => l.startsWith("F&O ");
    const cur = doc.split("\n");
    const old = fixBusy(mainRun.doc).split("\n");
    if (old.some((l) => l.startsWith("F&O options"))) {
      // already merged into main: nothing to diff beyond equality
      expect(cur).toEqual(old);
      return;
    }
    expect(cur.filter((l) => !isFno(l))).toEqual(old.filter((l) => !isFno(l)));
    expect(cur.length).toBe(old.length + 1);
    const crypto = cur.find((l) => l.startsWith("Crypto costs keys"));
    expect(crypto).toBe(old.find((l) => l.startsWith("Crypto costs keys")));
    // options line sits directly after the futures line
    expect(cur.indexOf(optLine)).toBe(cur.findIndex((l) => l.startsWith("F&O futures")) + 1);
  });
});
