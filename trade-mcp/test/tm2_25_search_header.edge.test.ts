import { describe, it, expect } from "vitest";
import { API_DOCS as ALL_DOCS, API_HEADER, type ApiDoc } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";

// Independent edge tests for TM2-25: a non-empty query also matches API_HEADER line by line and prepends a
// "// Rules:" block of up to 8 verbatim matching lines before the rendered entries.

const HEADER_LINES = API_HEADER.split("\n");
const PREFIX = "// Rules:\n";
const SCOPES = ["full", "readonly"] as const;
type Scope = (typeof SCOPES)[number];

/** Inline copy of searchApi as it is on main (before TM2-25): the byte-identity oracle. */
function mainSearchApi(query: string, scope: Scope = "full"): string {
  const API_DOCS = ALL_DOCS.filter((d) => scope === "full" || d.ns !== "trade");
  const render = (entries: ApiDoc[]): string => {
    const byNs = new Map<string, ApiDoc[]>();
    for (const e of entries) byNs.set(e.ns, [...(byNs.get(e.ns) ?? []), e]);
    return [...byNs]
      .map(
        ([ns, es]) =>
          `declare namespace ${ns} {\n` + es.map((e) => `  /** ${e.doc} */\n  function ${e.signature};`).join("\n") + "\n}",
      )
      .join("\n\n");
  };
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    const nss = [...new Set(API_DOCS.map((d) => d.ns))];
    const index = nss.map((ns) => `${ns}: ${API_DOCS.filter((d) => d.ns === ns).map((d) => d.name).join(", ")}`).join("\n");
    return `${API_HEADER}\n\nNamespaces:\n${index}`;
  }
  const hits = API_DOCS.filter((d) => {
    const hay = `${d.ns} ${d.name} ${d.doc}`.toLowerCase();
    return tokens.some((t) => hay.includes(t));
  }).slice(0, 20);
  return hits.length ? render(hits) : `No API entries match "${query}".`;
}

const tokensOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** Header lines a query should match (plain substring, case-insensitive), in header order. */
const expectedRuleLines = (q: string) => HEADER_LINES.filter((l) => tokensOf(q).some((t) => l.toLowerCase().includes(t)));
/**
 * TM2-32 oracle (independent of search.ts): score = distinct tokens a line contains; take score levels from the
 * highest down, filling up to 8 slots in header order within each level (= ties to the earlier line); emit in header order.
 */
function rankedRuleLines(q: string): string[] {
  const uniq = Array.from(new Set(tokensOf(q)));
  const scores = HEADER_LINES.map((l) => {
    let n = 0;
    for (const t of uniq) if (l.toLowerCase().indexOf(t) !== -1) n++;
    return n;
  });
  const chosen = new Set<number>();
  for (let level = uniq.length; level >= 1 && chosen.size < 8; level--) {
    for (let i = 0; i < HEADER_LINES.length && chosen.size < 8; i++) if (scores[i] === level) chosen.add(i);
  }
  return HEADER_LINES.filter((_, i) => chosen.has(i));
}

function split(out: string): { rules: string[]; rest: string } {
  if (!out.startsWith(PREFIX)) return { rules: [], rest: out };
  const body = out.slice(PREFIX.length);
  const cut = body.indexOf("\n\n");
  return cut < 0 ? { rules: body.split("\n"), rest: "" } : { rules: body.slice(0, cut).split("\n"), rest: body.slice(cut + 2) };
}

const QUERIES = [
  "risk denied", "market closed", "kill switch", "maxShortOptionQtyPerOrder", "maxshortoptionqtyperorder",
  "short option", "SHORT OPTION", "place", "trade", "trade.place", "order", "sell", "SELL", "orders", "cancel",
  "modify", "closePosition", "position", "funds", "quote", "risk", "crypto", "NFO", "CE", "e", "a", "options",
  "india_options", "backtest", "walk", "audit", "await", "return", "console.log", "notional", "contract_value",
  "24x7", "denied", "exceeds", "qty", "killSwitch", "risk denied short option qty exceeds",
  ".*", "(", ")", "[", "]", "\\", "^", "$", "+", "?", "{", "|", "'", "\"", "<q>", "e maxShortOptionQtyPerOrder",
  "zzzz-nothing", "india_optionz", "\t risk \n denied  ",
];

describe("TM2-25 edge: Rules block shape", () => {
  it.each(SCOPES.flatMap((s) => QUERIES.map((q) => [q, s] as const)))("query %j (%s): rule lines are verbatim header lines", (q, scope) => {
    const out = searchApi(q, scope);
    const { rules } = split(out);
    for (const l of rules) {
      expect(HEADER_LINES, `non-verbatim rule line: ${l}`).toContain(l);
      // each rule line really contains one of the tokens (literal, case-insensitive)
      expect(tokensOf(q).some((t) => l.toLowerCase().includes(t))).toBe(true);
    }
    expect(rules.length).toBeLessThanOrEqual(8);
    expect(new Set(rules).size).toBe(rules.length); // no duplicates
    // rule lines keep header order
    const idx = rules.map((l) => HEADER_LINES.indexOf(l));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    // "// Rules:" appears at most once and only at the very start
    expect(out.split("// Rules:").length - 1).toBe(rules.length ? 1 : 0);
  });

  // TM2-32 AC change: was "exactly the first 8 matching header lines"; now the top 8 by distinct-token score
  // (ties to the earlier line), output in header order. With <=8 matches it must still equal the first-8 set.
  it.each(SCOPES)("%s: Rules block is the top 8 header lines by distinct-token score, in header order", (scope) => {
    let ranked = 0;
    for (const q of QUERIES) {
      const exp = rankedRuleLines(q);
      expect(split(searchApi(q, scope)).rules, q).toEqual(exp);
      if (expectedRuleLines(q).length <= 8) expect(exp, q).toEqual(expectedRuleLines(q));
      else ranked++;
    }
    expect(ranked).toBeGreaterThan(0); // the >8-match path is exercised
  });

  it("a broad query is capped at 8 rule lines (header has more than 8 lines)", () => {
    expect(HEADER_LINES.length).toBeGreaterThan(8);
    expect(expectedRuleLines("e").length).toBeGreaterThan(8);
    expect(split(searchApi("e")).rules).toHaveLength(8);
  });

  // TM2-32 AC change (flipped): the cap is by relevance now, so a broad token can no longer push out the cap line.
  it("cap is by relevance: 'e maxShortOptionQtyPerOrder' includes the cap line (last header line)", () => {
    const capLine = HEADER_LINES.find((l) => l.includes("maxShortOptionQtyPerOrder"))!;
    expect(HEADER_LINES.indexOf(capLine)).toBeGreaterThanOrEqual(8);
    expect(expectedRuleLines("e maxShortOptionQtyPerOrder").length).toBeGreaterThan(8);
    for (const scope of SCOPES) {
      const rules = split(searchApi("e maxShortOptionQtyPerOrder", scope)).rules;
      expect(rules).toContain(capLine);
      expect(rules).toHaveLength(8);
      expect(rules[rules.length - 1]).toBe(capLine); // still in header order: cap line is last
    }
  });

  it("rules block is followed by exactly one blank line, then the entries", () => {
    const out = searchApi("risk denied");
    const { rules, rest } = split(out);
    expect(rules.length).toBeGreaterThan(0);
    expect(rest.startsWith("declare namespace ")).toBe(true);
    expect(out).toBe(`${PREFIX}${rules.join("\n")}\n\n${rest}`);
  });
});

describe("TM2-25 edge: compatibility with main", () => {
  it.each(SCOPES)("%s: every query = optional Rules block + main's output (entries unchanged, 20 cap kept)", (scope) => {
    for (const q of QUERIES) {
      const out = searchApi(q, scope);
      const old = mainSearchApi(q, scope);
      const exp = rankedRuleLines(q);
      // <=8 matches: the ranked block is byte-identical to TM2-25's first-8 block
      if (expectedRuleLines(q).length <= 8) expect(exp, q).toEqual(expectedRuleLines(q).slice(0, 8));
      if (!exp.length) expect(out, q).toBe(old);
      else if (old.startsWith("No API entries match")) expect(out, q).toBe(`${PREFIX}${exp.join("\n")}`);
      else expect(out, q).toBe(`${PREFIX}${exp.join("\n")}\n\n${old}`);
    }
  });

  it.each(SCOPES)("%s: queries matching no header line are byte-identical to main and have no Rules block", (scope) => {
    const none = QUERIES.filter((q) => tokensOf(q).length && !expectedRuleLines(q).length);
    expect(none.length).toBeGreaterThan(5);
    for (const q of none) {
      const out = searchApi(q, scope);
      expect(out, q).toBe(mainSearchApi(q, scope));
      expect(out).not.toContain("// Rules:");
    }
  });

  it.each(["", " ", "   ", "\t", "\n", " \t\n "])("empty/whitespace query %j is unchanged (full header + index, no Rules block)", (q) => {
    for (const scope of SCOPES) {
      const out = searchApi(q, scope);
      expect(out).toBe(mainSearchApi(q, scope));
      expect(out.startsWith(`${API_HEADER}\n\nNamespaces:\n`)).toBe(true);
      expect(out).not.toContain("// Rules:");
    }
  });

  it("20-entry cap is kept for entries even when a Rules block is prepended", () => {
    const docs = [...ALL_DOCS];
    // a token present in every doc's hay ("ns name doc" contains a space-free letter shared by all)
    const out = searchApi("e");
    const { rules, rest } = split(out);
    expect(rules.length).toBe(8);
    const fns = (rest.match(/^  function /gm) ?? []).length;
    expect(fns).toBe(Math.min(20, docs.filter((d) => `${d.ns} ${d.name} ${d.doc}`.toLowerCase().includes("e")).length));
    expect(fns).toBeLessThanOrEqual(20);
  });
});

describe("TM2-25 edge: matching semantics", () => {
  it.each(["RISK DENIED", "Risk Denied", "risk denied", "rIsK dEnIeD"])("case-insensitive: %j gives the same output", (q) => {
    expect(searchApi(q)).toBe(searchApi("risk denied"));
    expect(searchApi(q, "readonly")).toBe(searchApi("risk denied", "readonly"));
  });

  it("header matching is case-insensitive in the header too ('RISK' matches 'Risk:' and 'risk requires')", () => {
    const r = split(searchApi("RISK")).rules;
    expect(r.some((l) => l.startsWith("Risk:"))).toBe(true);
    expect(r.some((l) => l.includes("risk requires"))).toBe(true);
  });

  it.each([".*", "(", "[", "\\", "^", "$", "+", "?", "{", "|", ")", "]", "(.*)", "[a-z]+", "a|b", "\\d"])(
    "regex metacharacters %j do not throw and do not match everything",
    (q) => {
      for (const scope of SCOPES) {
        let out = "";
        expect(() => (out = searchApi(q, scope))).not.toThrow();
        const { rules } = split(out);
        expect(rules.length).toBeLessThan(HEADER_LINES.length);
        for (const l of rules) expect(l.toLowerCase()).toContain(q.toLowerCase()); // literal match only
        if (!HEADER_LINES.some((l) => l.toLowerCase().includes(q.toLowerCase()))) expect(out).not.toContain("// Rules:");
      }
    },
  );

  it("'.*' matches nothing (literal), so it keeps main's miss message", () => {
    expect(searchApi(".*")).toBe(`No API entries match ".*".`);
  });

  it("duplicate tokens do not duplicate rule lines", () => {
    expect(searchApi("risk risk RISK")).toBe(searchApi("risk"));
  });
});

describe("TM2-25 edge: header-only matches", () => {
  it("a token found only in the header returns just the Rules block, not 'No API entries match'", () => {
    // pick tokens that hit a header line but no (scoped) API_DOCS entry
    const candidates = ["await", "console.log", "24x7", "openalgo format", "allowedproducts"];
    let tested = 0;
    for (const scope of SCOPES) {
      for (const q of candidates) {
        if (!expectedRuleLines(q).length || !mainSearchApi(q, scope).startsWith("No API entries match")) continue;
        const out = searchApi(q, scope);
        expect(out.startsWith(PREFIX)).toBe(true);
        expect(out).not.toContain("No API entries match");
        expect(out).not.toContain("declare namespace");
        expect(out).toBe(`${PREFIX}${expectedRuleLines(q).slice(0, 8).join("\n")}`);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(0);
  });

  it("a query matching neither keeps the exact miss message", () => {
    expect(searchApi("zzzz-nothing")).toBe(`No API entries match "zzzz-nothing".`);
    expect(searchApi("india_optionz", "readonly")).toBe(`No API entries match "india_optionz".`);
  });
});

describe("TM2-25 edge: readonly never renders a trade.* entry", () => {
  const TRADE_QUERIES = [
    ...QUERIES, "place order", "trade place", "modify cancel", "closeposition", "square off", "kill switch on",
    "risk checks", "LTP", "triggerPrice", "SL-M", "priceType", "paper mode", "analyzer", "Throws on risk denial",
    "declare namespace trade", "function place(",
  ];
  it.each(TRADE_QUERIES)("readonly %j: no trade namespace, signature or doc in the entries", (q) => {
    const { rules, rest } = split(searchApi(q, "readonly"));
    for (const l of rules) expect(HEADER_LINES).toContain(l);
    expect(rest).not.toContain("declare namespace trade");
    expect(rest).not.toMatch(/function (place|modify|cancel|closePosition)\(/);
    for (const d of ALL_DOCS.filter((x) => x.ns === "trade")) {
      expect(rest).not.toContain(d.signature);
      expect(rest).not.toContain(d.doc);
    }
    // and the Rules block itself never smuggles a trade signature
    expect(rules.join("\n")).not.toMatch(/function (place|modify|cancel|closePosition)\(/);
  });
});

describe("TM2-25 edge: acceptance-criteria queries surface rule lines", () => {
  const capLine = HEADER_LINES.find((l) => l.includes("maxShortOptionQtyPerOrder"))!;
  const deniedLine = HEADER_LINES.find((l) => l.startsWith("Risk violations are thrown as Error('risk denied"))!;
  const hoursLine = HEADER_LINES.find((l) => l.includes("market hours never block it"))!;

  it.each(SCOPES)("%s: 'risk denied' includes the risk-denied line", (scope) => {
    expect(split(searchApi("risk denied", scope)).rules).toContain(deniedLine);
  });

  it.each(SCOPES)("%s: 'market closed' includes the market-hours line", (scope) => {
    expect(split(searchApi("market closed", scope)).rules).toContain(hoursLine);
  });

  it.each(SCOPES)("%s: 'maxShortOptionQtyPerOrder' includes the cap line (any case)", (scope) => {
    for (const q of ["maxShortOptionQtyPerOrder", "maxshortoptionqtyperorder", "MAXSHORTOPTIONQTYPERORDER"]) {
      expect(split(searchApi(q, scope)).rules).toEqual([capLine]);
    }
  });

  // Was a documented AC gap (no kill-switch header line); O-7 added the line, so 'kill switch' now gets a Rules block.
  it.each(SCOPES)("%s: 'kill switch' gives a Rules block with the kill-switch header line", (scope) => {
    const killLines = HEADER_LINES.filter((l) => /^Kill switch: /.test(l));
    expect(killLines).toHaveLength(1);
    const { rules, rest } = split(searchApi("kill switch", scope));
    expect(rules).toContain(killLines[0]);
    expect(rules).toEqual(expectedRuleLines("kill switch"));
    expect(rest).toContain("killSwitch"); // the risk.status entry is still rendered after the block
  });
});
