import { describe, it, expect } from "vitest";
import { API_DOCS as ALL_DOCS, API_HEADER } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";

// Independent edge tests for TM2-32: the Rules block keeps the top 8 API_HEADER lines by number of DISTINCT query
// tokens contained (case-insensitive substring), ties to the earlier line, and outputs them in header order.
// Layout-independent: line count, indexes and per-line unique words are all derived from API_HEADER at test time.

const CAP = 8;
const HEADER_LINES = API_HEADER.split("\n");
const LOW = HEADER_LINES.map((l) => l.toLowerCase());
const N = HEADER_LINES.length;
const BIG = N > CAP; // ranking only differs from "all matches" when more than CAP lines can match
const PREFIX = "// Rules:\n";
const SCOPES = ["full", "readonly"] as const;
const tokensOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const hitsOf = (t: string) => LOW.map((l, i) => (l.includes(t.toLowerCase()) ? i : -1)).filter((i) => i >= 0);

/** Oracle: stable sort of indices by score desc (Array.prototype.sort is stable), keep CAP, re-sort by index. */
function oracle(q: string): string[] {
  const uniq = [...new Set(tokensOf(q))];
  const scored = LOW.map((l, i) => ({ i, s: uniq.reduce((n, t) => n + (l.includes(t) ? 1 : 0), 0) }));
  const keep = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, CAP).map((x) => x.i);
  return keep.sort((a, b) => a - b).map((i) => HEADER_LINES[i]);
}

/** Expected indexes for a designed score profile (score per line): top CAP by score, ties to the earlier, header order. */
function fromProfile(score: number[]): number[] {
  const order = score.map((s, i) => [s, i] as const).filter(([s]) => s > 0);
  order.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return order.slice(0, CAP).map(([, i]) => i).sort((a, b) => a - b);
}

function rulesOf(out: string): string[] {
  if (!out.startsWith(PREFIX)) return [];
  const body = out.slice(PREFIX.length);
  const cut = body.indexOf("\n\n");
  return (cut < 0 ? body : body.slice(0, cut)).split("\n");
}
const idxOf = (rules: string[]) => rules.map((l) => HEADER_LINES.indexOf(l));
const ruleIdx = (q: string, scope: (typeof SCOPES)[number] = "full") => idxOf(rulesOf(searchApi(q, scope)));
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);

// Words (letters/digits/_ only, length >= 3) that occur as a substring in exactly one header line, in line order.
const UNIQUE: string[][] = LOW.map((l, i) => [
  ...new Set(l.split(/[^a-z0-9_]+/).filter((w) => w.length >= 3 && hitsOf(w).length === 1 && hitsOf(w)[0] === i)),
]);
const one = (i: number) => UNIQUE[i][0];
const ALL_ONE = range(0, N).map(one); // query where every line scores exactly 1
const LINES_WITH_TWO = range(0, N).filter((i) => UNIQUE[i].length >= 2);

describe("TM2-32 edge: fixture assumptions (derived from API_HEADER)", () => {
  it("every header line has a word unique to it, and each derived word hits only its line", () => {
    for (let i = 0; i < N; i++) {
      expect(UNIQUE[i].length, `line ${i} has no unique word: ${HEADER_LINES[i]}`).toBeGreaterThan(0);
      for (const w of UNIQUE[i]) expect(hitsOf(w), w).toEqual([i]);
    }
  });

  // Skip-with-assert: if the header ever shrinks to <= CAP lines, the ranking tests below are skipped, and this
  // test asserts the remaining behaviour (every matching line is shown) so nothing passes silently.
  it.runIf(!BIG)(`header has <= ${CAP} lines: ranking cannot drop anything, every matching line is shown`, () => {
    expect(ruleIdx(ALL_ONE.join(" "))).toEqual(range(0, N));
  });
  it.runIf(BIG)(`header has > ${CAP} lines, so the ranking cases below are live`, () => {
    expect(N).toBeGreaterThan(CAP);
    expect(LINES_WITH_TWO.some((i) => i >= CAP)).toBe(true); // a line beyond the first CAP can be boosted
  });
});

describe.runIf(BIG)("TM2-32 edge: repeated tokens count once", () => {
  it("'risk risk' gives exactly the output of 'risk' (both scopes)", () => {
    for (const s of SCOPES) expect(searchApi("risk risk", s)).toBe(searchApi("risk", s));
  });

  it("repeating the last line's word cannot lift it: every line scores 1, so the first CAP lines are kept", () => {
    // Counting repeats would score the last line 3 and keep it, dropping line CAP-1 instead.
    const last = one(N - 1);
    const q = `${ALL_ONE.join(" ")} ${last} ${last}`;
    for (const s of SCOPES) expect(ruleIdx(q, s)).toEqual(range(0, CAP));
    expect(idxOf(oracle(q))).toEqual(range(0, CAP));
  });

  it("repeating every token of a query (in any case) changes nothing", () => {
    for (const q of ["e", "risk denied", "crypto symbols qty", ALL_ONE.join(" "), `e ${one(N - 1)}`]) {
      const rep = `${q} ${q} ${q.toUpperCase()}`;
      for (const s of SCOPES) expect(searchApi(rep, s), q).toBe(searchApi(q, s));
    }
  });
});

describe.runIf(BIG)("TM2-32 edge: mixed case", () => {
  const variants = (w: string) => [w.toUpperCase(), w[0].toUpperCase() + w.slice(1), [...w].map((c, k) => (k % 2 ? c.toUpperCase() : c)).join("")];

  it("upper/mixed-case variants of a boosting query give identical output and keep the boosted last line", () => {
    const k = N - 1;
    const base = `${ALL_ONE.join(" ")} ${UNIQUE[k][1]}`;
    expect(ruleIdx(base)).toContain(k);
    for (const v of variants(base)) for (const s of SCOPES) expect(searchApi(v, s), v).toBe(searchApi(base, s));
  });

  it("case variants of one word are one distinct token (no boost)", () => {
    const last = one(N - 1);
    const q = `${ALL_ONE.join(" ")} ${variants(last).join(" ")}`;
    expect(ruleIdx(q)).toEqual(range(0, CAP));
  });
});

describe.runIf(BIG)("TM2-32 edge: substring tokens", () => {
  it("'risk' and 'risk denied': 'risk risk denied' = 'risk denied'; the risk-denied line is included", () => {
    expect(searchApi("risk risk denied")).toBe(searchApi("risk denied"));
    expect(rulesOf(searchApi("risk denied")).some((l) => l.includes("'risk denied"))).toBe(true);
    for (const q of ["ris risk", "ris risk denied e", "risk risk denied den"]) expect(rulesOf(searchApi(q)), q).toEqual(oracle(q));
  });

  it("a token and its own prefix are two distinct tokens: both count, which lifts a line past the cut", () => {
    // Find a line k >= CAP whose unique word w has a proper prefix p (len >= 3) also unique to line k.
    let found: { k: number; w: string; p: string } | undefined;
    for (let k = CAP; k < N && !found; k++)
      for (const w of UNIQUE[k])
        for (let n = w.length - 1; n >= 3 && !found; n--) {
          const p = w.slice(0, n);
          const h = hitsOf(p);
          if (h.length === 1 && h[0] === k) found = { k, w, p };
        }
    expect(found, "no prefix-pair fixture found").toBeDefined();
    const { k, w, p } = found!;
    // w is one(k) or another unique word of k; build: every line scores 1, line k gets w + p = 2 (if w != one(k), 3).
    const q = `${ALL_ONE.join(" ")} ${w} ${p}`;
    const prof = range(0, N).map((i) => (i === k ? new Set([one(k), w, p]).size : 1));
    expect(fromProfile(prof)).toContain(k);
    for (const s of SCOPES) expect(ruleIdx(q, s), q).toEqual(fromProfile(prof));
    // Collapsing p into w would leave line k at score 1 (if w = one(k)) and drop it; distinct counting keeps it.
  });
});

describe.runIf(BIG)("TM2-32 edge: ties", () => {
  it.each(["e", "a", "o", "e a", "E A O e"])("%j: matched lines all tie, so the earliest CAP matched lines are kept", (q) => {
    const uniq = [...new Set(tokensOf(q))];
    const prof = LOW.map((l) => uniq.filter((t) => l.includes(t)).length);
    for (const s of SCOPES) expect(ruleIdx(q, s)).toEqual(fromProfile(prof));
    if (prof.every((x) => x === prof[0]) && prof[0] > 0) expect(ruleIdx(q)).toEqual(range(0, CAP));
  });

  it("all N lines tie (one unique word each): first CAP kept, whatever the token order", () => {
    expect(ruleIdx(ALL_ONE.join(" "))).toEqual(range(0, CAP));
    expect(ruleIdx([...ALL_ONE].reverse().join(" "))).toEqual(range(0, CAP));
  });

  it("boosting any one line keeps it; among the tied 1-scorers the latest are dropped", () => {
    expect(LINES_WITH_TWO.length).toBeGreaterThan(0);
    for (const k of LINES_WITH_TWO) {
      const q = `${ALL_ONE.join(" ")} ${UNIQUE[k][1]}`;
      const exp = [...new Set([k, ...range(0, N).filter((i) => i !== k).slice(0, CAP - 1)])].sort((a, b) => a - b);
      for (const s of SCOPES) expect(ruleIdx(q, s), q).toEqual(exp);
    }
  });

  it("output is header order even when the top scorer is the last line", () => {
    const k = N - 1;
    expect(UNIQUE[k].length).toBeGreaterThanOrEqual(2);
    const r = ruleIdx(`${UNIQUE[k][1]} ${ALL_ONE.join(" ")}`); // boosting token placed first in the query
    expect(r).toEqual([...range(0, CAP - 1), k]);
    expect(r[r.length - 1]).toBe(k);
  });
});

describe.runIf(BIG)("TM2-32 edge: CAP vs CAP+1 and more matches", () => {
  it("first m lines matched (m = 1..N): min(m, CAP) kept; for m <= CAP identical to the header-order filter", () => {
    for (let m = 1; m <= N; m++) {
      const q = ALL_ONE.slice(0, m).join(" ");
      expect(ruleIdx(q), `m=${m}`).toEqual(range(0, Math.min(m, CAP)));
    }
  });

  it("last m lines matched (m = 1..N): all kept up to CAP (incl. the last line), then the earliest CAP", () => {
    for (let m = 1; m <= N; m++) {
      const q = ALL_ONE.slice(N - m).join(" ");
      expect(ruleIdx(q), `m=${m}`).toEqual(range(N - m, N - m + Math.min(m, CAP)));
    }
  });

  it("exactly CAP matches vs CAP+1: one line drops only once CAP+1 match", () => {
    const capQ = ALL_ONE.slice(N - CAP).join(" ");
    expect(ruleIdx(capQ)).toEqual(range(N - CAP, N));
    const plus = ALL_ONE.slice(N - CAP - 1).join(" ");
    expect(ruleIdx(plus)).toEqual(range(N - CAP - 1, N - 1)); // the last (latest tie) is dropped
  });

  it("many tokens matching everything: always exactly CAP, never more", () => {
    for (const q of ["e a o", "e risk crypto symbols", `${ALL_ONE.join(" ")} e a o is the`]) expect(rulesOf(searchApi(q)), q).toHaveLength(CAP);
  });
});

// Broad deterministic query list: words, pairs and triples drawn from the header and the docs.
const WORDS = [...new Set((API_HEADER + " " + ALL_DOCS.map((d) => `${d.ns} ${d.name} ${d.doc}`).join(" ")).split(/[^A-Za-z0-9_.]+/))]
  .filter((w) => w.length > 0)
  .slice(0, 400);
const BROAD: string[] = [];
for (let i = 0; i < WORDS.length; i++) {
  BROAD.push(WORDS[i]);
  BROAD.push(`${WORDS[i]} ${WORDS[(i * 7 + 3) % WORDS.length]}`);
  BROAD.push(`e ${WORDS[(i * 13 + 5) % WORDS.length]} ${WORDS[(i * 31 + 1) % WORDS.length]}`);
}
BROAD.push("zzzz-nothing", "risk denied", "market closed", "kill switch", "e maxShortOptionQtyPerOrder", "trade place");

describe("TM2-32 edge: broad query list", () => {
  it("every query matches the oracle in both scopes, and the Rules block is scope-independent", () => {
    expect(BROAD.length).toBeGreaterThan(500);
    for (const q of BROAD) {
      const f = rulesOf(searchApi(q, "full"));
      const r = rulesOf(searchApi(q, "readonly"));
      expect(f, q).toEqual(oracle(q));
      expect(r, q).toEqual(f);
    }
  });

  it("readonly never renders a trade.* entry", () => {
    const tradeDocs = ALL_DOCS.filter((d) => d.ns === "trade");
    for (const q of [...BROAD, "place", "modify", "cancel", "closePosition", "trade", "kill switch on", "square off"]) {
      const out = searchApi(q, "readonly");
      expect(out, q).not.toContain("declare namespace trade");
      expect(out, q).not.toMatch(/function (place|modify|cancel|closePosition)\(/);
      for (const d of tradeDocs) expect(out, q).not.toContain(d.signature);
    }
  });

  it("deterministic: repeated calls give identical output", () => {
    for (const q of BROAD.slice(0, 200)) for (const s of SCOPES) {
      const a = searchApi(q, s);
      expect(searchApi(q, s), q).toBe(a);
      expect(searchApi(q, s), q).toBe(a);
    }
  });
});

describe("TM2-32 edge: performance", () => {
  it("200 distinct tokens finish quickly and still match the oracle", () => {
    const q = WORDS.slice(0, 200).join(" ");
    expect(new Set(tokensOf(q)).size).toBeGreaterThan(150);
    searchApi(q); // warm-up
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) searchApi(q, i % 2 ? "readonly" : "full");
    expect((performance.now() - t0) / 10).toBeLessThan(50);
    expect(rulesOf(searchApi(q))).toEqual(oracle(q));
    expect(rulesOf(searchApi(q))).toHaveLength(Math.min(CAP, oracle(q).length));
  });

  it("200 copies of one token is as fast and equals the single token", () => {
    const q = Array(200).fill("risk").join(" ");
    const t0 = performance.now();
    const out = searchApi(q);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out).toBe(searchApi("risk"));
  });
});
