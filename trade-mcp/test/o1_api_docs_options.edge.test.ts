import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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

// ---- protected sections pinned to a fixed baseline (O-7) ----
// Baseline = api-docs.ts on main at 5daeac0 (before O-7). It is stored in this file, not read from git, so the check
// no longer depends on which commit a branch was cut from. Intended changes since the baseline: the risk.status entry
// (O-7, TM2-27 shape) and one kill-switch header line (O-7); trade.place may carry the O-5 short-option cap sentence;
// backtest.walkForward carries the O-12 partial-fold sentence exactly once, appended to its "Result:" line (TM2-38).
// Anything else fails. To accept a future intended change, update the baseline here in the same PR.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const key = (d: { ns: string; name: string }) => `${d.ns}.${d.name}`;
const PLACE_CAP =
  /Optional risk cap maxShortOptionQtyPerOrder limits NFO\/BFO CE\/PE SELL qty \(off when unset; also caps a SELL that closes a long\), denied with 'short option qty <q> exceeds maxShortOptionQtyPerOrder <n>'\. /;
/** O-12: the one sentence allowed on top of the walkForward baseline, appended (after one space) to the "Result:" line. */
const WF_PARTIAL =
  " On ok:false, `folds` holds only the folds completed before the failure (possibly empty); summary and oosEquity are empty; check ok and error.";
/** Header lines added on purpose after the baseline. Each may appear at most once. */
const ALLOWED_ADDED_HEADER = [/^Kill switch: /];

const BASE_CRYPTO_NOTE = [
  "Crypto (Delta via OpenAlgo): exchange \"CRYPTO\" (Delta Exchange is OpenAlgo's only crypto broker); futures, perpetuals and options only.",
  "Symbols: option BTC28FEB2580000CE (underlying+DDMONYY+strike+CE|PE); dated future BTC28FEB25FUT; perpetual is the Delta symbol plus FUT per the master-contract code (e.g. BTCUSDFUT; its docs also mention BTCUSD.P) - confirm with market.search({query:\"BTCUSD\", exchange:\"CRYPTO\"}).",
  "Product: Delta has no CNC/NRML/MIS distinction (the value is passed through), but risk requires it to be in allowedProducts, so use NRML or MIS as configured.",
  "Quantity is a whole number of contracts for derivatives, NOT units of the underlying; each contract = contract_value units (e.g. 0.01 ETH for ETHUSD perpetual). Notional is therefore qty * contract_value * price; the risk engine uses qty * contractValues[SYMBOL] * price, defaulting contract_value to 1 when unset - set contractValues in risk.json for accurate USD caps.",
  "Risk: per-order cap is maxNotionalPerOrderUsd (not INR); CRYPTO trades 24x7 so market hours never block it.",
].join("\n");

/** API_HEADER lines of the baseline, CRYPTO_NOTE lines excluded (checked via BASE_CRYPTO_NOTE). */
const BASE_HEADER = [
  "Code is the body of an async JS function: use `await`, `return` a value, and console.log for output.",
  "Arguments are plain objects. Symbols use OpenAlgo format, e.g. RELIANCE / NSE, NIFTY28NOV2524000CE / NFO, BTC28FEB2580000CE / CRYPTO.",
  "Risk violations are thrown as Error('risk denied: ...'); nothing is placed in that case.",
  "Optional risk cap maxShortOptionQtyPerOrder (off when unset) limits the quantity of NFO/BFO CE/PE SELL orders; a SELL that closes a long is capped too (conservative), and a breach is denied with 'short option qty <q> exceeds maxShortOptionQtyPerOrder <n>'.",
];

const BASE_WALKFORWARD = {
  signature:
    "walkForward(args: { code: string; symbols: string[]; start: string; end: string; trainDays: number; testDays: number; candidates: object[]; metric?: 'sharpe' | 'total_return' | 'calmar'; interval?: string; capital?: number; costs?: object; source?: string }): Promise<{ ok: boolean; metric: string | null; folds: { train: string[]; test: string[]; chosen: object; trainScore: number | null; testMetrics: object }[]; oosEquity: { date: string; value: number | null }[]; summary: object; warnings: string[]; error: string | null }>",
  doc: [
    "Walk-forward validation: signal parameters are tuned on each train window only and frozen for the following out-of-sample test window. Never touches the broker or risk engine; each call is audited with code length and sha256 only. Throws 'backtest service not configured' if unavailable; 'backtest service busy, retry later' when the service is saturated.",
    "trainDays >= 20 and testDays >= 5 are calendar days. candidates is 1-10 parameter objects (passed to the engine as signal_parameters); at most 60 backtest runs in total; the server enforces a 10-minute budget. metric is one of sharpe, total_return, calmar (default sharpe).",
    "Note: execute has a time limit (EXECUTE_TIMEOUT_MS, default 60 s); for walk-forward the operator should set EXECUTE_TIMEOUT_MS >= 660000, and your MCP client may have its own tool-call timeout.",
    "Result: metric, folds (train/test dates, chosen params, trainScore, testMetrics), oosEquity (chained out-of-sample equity, downsampled to <=100 points), summary (folds, scored_folds, mean_test_<metric>, positive_folds), warnings, error (null on success).",
  ].join("\n"),
};

/** Baseline entry order. */
const BASE_ORDER = [
  "market.quote",
  "market.depth",
  "market.history",
  "market.search",
  "market.optionChain",
  "account.funds",
  "account.positions",
  "account.holdings",
  "account.orders",
  "account.trades",
  "trade.place",
  "trade.modify",
  "trade.cancel",
  "trade.closePosition",
  "backtest.run",
  "backtest.walkForward",
  "audit.recent",
  "risk.status",
];

/** sha256(signature + "\n" + doc) per entry; backtest.run, backtest.walkForward, trade.place, risk.status are checked separately. */
const BASE_ENTRY_SHA: [string, string][] = [
  ["market.quote", "e21db937f7e5dd071d1d544c4382d61fc82ecd6ae775b9d7b5a058748e0a9312"],
  ["market.depth", "fa105e31d2ded881cd69c6aa7655755af28aa6fd8cc3f144cf6b584f21ac499a"],
  ["market.history", "01905559cc53dca0b9986df9a411af72a604c5d2ac4dc67478536493a0cb3057"],
  ["market.search", "5df1fc8708aaf9c2271997d64690ba68e492de0b99efe3e0382ef872a501e87d"],
  ["market.optionChain", "3e8a8651467bcb9d115c7f3d0e826fbcf4a6507b997e5c3053f7fe6b634dac81"],
  ["account.funds", "b4a796f53a4fdc23f500e9d1d3c321d9db026abba17eca8fd291c543fdd76263"],
  ["account.positions", "877fdd328ed962086791cb5eefdb1de58a47e540b4f72eee91ae5575f1a9adee"],
  ["account.holdings", "609d32445f83fefc1c8e587d28d65105f284c2b5a1959e12815bce3f9f2970a8"],
  ["account.orders", "f3ca6a65bb33319aa97fa60f62d114462069de3015c3dbbaef326596a8aaa924"],
  ["account.trades", "24362169fcb9f5c9593b460cec2db8a27d36d6e95bd9825b6c86978d79bb7400"],
  ["trade.modify", "699e901a720cfd1fba0ea92ccef959aba96cc7c63cdfe1ecf34c6840243ee7a2"],
  ["trade.cancel", "5a616ad8f47db81380285a173f982acddff8ce246e96f4aa725e710bb2492f3d"],
  ["trade.closePosition", "7754d0130f23eb9be3f77b1480c6a8e44b8a3f28ab207b0adc123ba4bdcd4fb7"],
  ["audit.recent", "49dc92ecc44e28c9ab1842ad4d674dd98a34e5009f52e0b12268b7a672c01dcd"],
];
const BASE_WALKFORWARD_SHA = "cd568d9d727bd34f369c6a2daea0913c083c3577c9edb19b456ba8fd8de7b08f";
/** walkForward doc minus the O-12 sentence equals the baseline; the sentence sits exactly once, at the end of "Result:". */
const wfDocOk = (d: string) => {
  if (d.split(WF_PARTIAL).length !== 2) return false;
  const res = d.split("\n").find((l) => l.startsWith("Result: "));
  return !!res && res.endsWith(WF_PARTIAL) && d.replace(WF_PARTIAL, "") === BASE_WALKFORWARD.doc;
};
const BASE_PLACE_SHA_WITHOUT_CAP = "a83d9ee4b7aabbb0f98325db329804e65d2be71c6afd76b1367778174e4e0b46";
const BASE_RUN_SIGNATURE_SHA = "2da0ef813764de127e06ce218174e74bf88198f15e9cf07b447ea9d9b741498d";
const BASE_RUN_NON_FNO_SHA = "8ce2c834324f5e3363640eda966aa3db3e396c1dd5efda38c80d4341d56fc287";
const BASE_CRYPTO_COSTS =
  "Crypto costs keys: leverage (default 1), maker_rate (0.0002), taker_rate (0.0005), slippage (0.0005), commission (fallback for both fee sides; explicit maker_rate/taker_rate win), funding_rate (fixed rate per settlement, default 0.0001). Symbols ending -PERP or -SWAP get funding; bare spot pairs get none unless a nonzero funding_rate is given.";
const BASE_RISK_STATUS_SIGNATURE = "status(): Promise<{ mode: string; killSwitch: boolean; limits: object; today: { date: string; orders: number; notional: number } }>";

/** Split API_HEADER into baseline lines and added lines (CRYPTO_NOTE lines removed). */
function headerDiff(header: string): { matched: number; added: string[] } {
  const cryptoLines = new Set(BASE_CRYPTO_NOTE.split("\n"));
  let matched = 0;
  const added: string[] = [];
  for (const l of header.split("\n").filter((x) => !cryptoLines.has(x))) {
    if (matched < BASE_HEADER.length && l === BASE_HEADER[matched]) matched++;
    else added.push(l);
  }
  return { matched, added };
}
const headerOk = (header: string) => {
  const { matched, added } = headerDiff(header);
  return (
    matched === BASE_HEADER.length &&
    added.every((l) => ALLOWED_ADDED_HEADER.some((re) => re.test(l))) &&
    ALLOWED_ADDED_HEADER.every((re) => added.filter((l) => re.test(l)).length <= 1)
  );
};

describe("O-1 edge: walkForward and crypto sections unchanged vs pinned baseline", () => {
  it("baseline self-check: pinned tables are complete, ordered and well-formed", () => {
    expect(BASE_ORDER).toHaveLength(18);
    const sep = ["backtest.run", "backtest.walkForward", "trade.place", "risk.status"];
    expect(BASE_ENTRY_SHA.map(([k]) => k)).toEqual(BASE_ORDER.filter((k) => !sep.includes(k)));
    for (const [, h] of BASE_ENTRY_SHA) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha(BASE_WALKFORWARD.signature + "\n" + BASE_WALKFORWARD.doc)).toBe(BASE_WALKFORWARD_SHA);
    expect(BASE_HEADER.length).toBeGreaterThan(0);
  });

  it("CRYPTO_NOTE identical; API_HEADER keeps every baseline line in order, adding only known lines", () => {
    expect(CRYPTO_NOTE).toBe(BASE_CRYPTO_NOTE);
    expect(API_HEADER).toContain(CRYPTO_NOTE); // contiguous block
    const { matched, added } = headerDiff(API_HEADER);
    expect(matched).toBe(BASE_HEADER.length); // all baseline lines present, same order, unedited
    for (const l of added) expect(ALLOWED_ADDED_HEADER.some((re) => re.test(l)), `unexpected header line: ${l}`).toBe(true);
    expect(added.length).toBeLessThanOrEqual(ALLOWED_ADDED_HEADER.length);
    expect(headerOk(API_HEADER)).toBe(true);
  });

  it("strictness: an edited, dropped, reordered, unknown or duplicated header line is rejected", () => {
    const ls = API_HEADER.split("\n");
    const risk = ls.findIndex((l) => l.startsWith("Risk violations"));
    const kill = ls.findIndex((l) => l.startsWith("Kill switch: "));
    expect(risk).toBeGreaterThanOrEqual(0);
    const edit = [...ls];
    edit[0] = edit[0].replace("await", "awaits");
    expect(headerOk(edit.join("\n"))).toBe(false);
    expect(headerOk(ls.filter((_, j) => j !== risk).join("\n"))).toBe(false);
    const swapped = [...ls];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(headerOk(swapped.join("\n"))).toBe(false);
    expect(headerOk([...ls, "Some new rule nobody reviewed."].join("\n"))).toBe(false);
    if (kill >= 0) expect(headerOk([...ls, ls[kill]].join("\n"))).toBe(false);
    expect(headerOk(API_HEADER.replace(CRYPTO_NOTE, CRYPTO_NOTE + " "))).toBe(false);
  });

  it("walkForward entry identical (signature and doc) except the one O-12 partial-fold sentence", () => {
    const a = API_DOCS.find((d) => d.ns === "backtest" && d.name === "walkForward")!;
    expect(a).toBeDefined();
    expect(a.signature).toBe(BASE_WALKFORWARD.signature);
    expect(a.doc.split(WF_PARTIAL)).toHaveLength(2); // exactly once
    expect(a.doc.replace(WF_PARTIAL, "")).toBe(BASE_WALKFORWARD.doc);
    expect(a.doc.split("\n").find((l) => l.startsWith("Result: "))!.endsWith(WF_PARTIAL)).toBe(true);
    expect(a.doc.split("\n")).toHaveLength(BASE_WALKFORWARD.doc.split("\n").length);
    expect(wfDocOk(a.doc)).toBe(true);
    expect(a.doc).toContain("'backtest service busy, retry later'");
  });

  it("strictness: walkForward without, with two, an edited or a moved O-12 sentence, or any other edit, is rejected", () => {
    const cur = API_DOCS.find((d) => d.ns === "backtest" && d.name === "walkForward")!.doc;
    expect(wfDocOk(BASE_WALKFORWARD.doc)).toBe(false); // sentence missing
    expect(wfDocOk(cur + WF_PARTIAL)).toBe(false); // duplicated
    expect(wfDocOk(cur.replace("(possibly empty)", "(never empty)"))).toBe(false); // sentence edited
    expect(wfDocOk(cur.replace("summary and oosEquity are empty", "summary is empty"))).toBe(false);
    expect(wfDocOk(BASE_WALKFORWARD.doc.replace("calendar days.", "calendar days." + WF_PARTIAL))).toBe(false); // wrong line
    expect(wfDocOk(cur + "\nExtra line.")).toBe(false);
    expect(wfDocOk(cur.replace("10-minute budget", "20-minute budget"))).toBe(false); // other text edited
    expect(wfDocOk(cur.replace(WF_PARTIAL, WF_PARTIAL.trimStart()))).toBe(false); // spacing
  });

  it("every entry identical except the intended changes (risk.status; trade.place cap; walkForward O-12 sentence), same order", () => {
    expect(API_DOCS.map(key)).toEqual(BASE_ORDER);
    const byKey = new Map(API_DOCS.map((d) => [key(d), d] as const));
    for (const [k, h] of BASE_ENTRY_SHA) {
      const d = byKey.get(k)!;
      expect(sha(d.signature + "\n" + d.doc), `${k} changed`).toBe(h);
    }
    // backtest.walkForward: with the O-12 sentence removed (exactly one copy), it equals the baseline
    const wf = byKey.get("backtest.walkForward")!;
    expect(wf.doc.split(WF_PARTIAL)).toHaveLength(2);
    expect(sha(wf.signature + "\n" + wf.doc.replace(WF_PARTIAL, ""))).toBe(BASE_WALKFORWARD_SHA);
    // trade.place: with the O-5 cap sentence removed (at most one copy), it equals the baseline
    const place = byKey.get("trade.place")!;
    expect((place.doc.match(new RegExp(PLACE_CAP.source, "g")) ?? []).length).toBeLessThanOrEqual(1);
    expect(sha(place.signature + "\n" + place.doc.replace(PLACE_CAP, ""))).toBe(BASE_PLACE_SHA_WITHOUT_CAP);
    // risk.status: the intended change; it must really replace the old vague shape
    const rs = byKey.get("risk.status")!;
    expect(rs.signature).not.toBe(BASE_RISK_STATUS_SIGNATURE);
    expect(rs.signature).not.toContain("limits: object");
  });

  it("backtest.run: crypto costs line and all other non-F&O lines unchanged; one options line after futures", () => {
    const isFno = (l: string) => l.startsWith("F&O ");
    const cur = doc.split("\n");
    expect(sha(run.signature)).toBe(BASE_RUN_SIGNATURE_SHA);
    expect(sha(cur.filter((l) => !isFno(l)).join("\n"))).toBe(BASE_RUN_NON_FNO_SHA);
    expect(cur.find((l) => l.startsWith("Crypto costs keys"))).toBe(BASE_CRYPTO_COSTS);
    expect(cur.filter((l) => l.startsWith("F&O options"))).toHaveLength(1);
    expect(cur.indexOf(optLine)).toBe(cur.findIndex((l) => l.startsWith("F&O futures")) + 1);
  });
});
