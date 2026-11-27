import { describe, it, expect } from "vitest";
import { API_DOCS as ALL_DOCS, API_HEADER } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";

// Independent edge tests for TM2-32: the Rules block keeps the top 8 API_HEADER lines by number of DISTINCT query
// tokens contained (case-insensitive substring), ties to the earlier line, and outputs them in header order.

const HEADER_LINES = API_HEADER.split("\n");
const PREFIX = "// Rules:\n";
const SCOPES = ["full", "readonly"] as const;
const tokensOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Oracle: stable sort of indices by score desc (Array.prototype.sort is stable), keep 8, re-sort by index. */
function oracle(q: string): string[] {
  const uniq = [...new Set(tokensOf(q))];
  const scored = HEADER_LINES.map((l, i) => ({ i, s: uniq.reduce((n, t) => n + (l.toLowerCase().includes(t) ? 1 : 0), 0) }));
  const keep = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.i);
  return keep.sort((a, b) => a - b).map((i) => HEADER_LINES[i]);
}

function rulesOf(out: string): string[] {
  if (!out.startsWith(PREFIX)) return [];
  const body = out.slice(PREFIX.length);
  const cut = body.indexOf("\n\n");
  return (cut < 0 ? body : body.slice(0, cut)).split("\n");
}
const idxOf = (rules: string[]) => rules.map((l) => HEADER_LINES.indexOf(l));
const allBut = (...drop: number[]) => HEADER_LINES.map((_, i) => i).filter((i) => !drop.includes(i));

// Words that each occur in exactly one header line (asserted below), used to build precise score profiles.
const ONLY = ["await", "arguments", "broker", "ddmonyy", "product", "whole", "24x7", "violations", "sell"];
const ONLY2 = ["body", "plain", "futures", "strike"]; // second unique word for lines 0..3

describe("TM2-32 edge: fixture assumptions", () => {
  it("header has 9 lines and each ONLY/ONLY2 word hits exactly its own line", () => {
    expect(HEADER_LINES).toHaveLength(9);
    ONLY.forEach((w, i) => expect(idxOf(HEADER_LINES.filter((l) => l.toLowerCase().includes(w))), w).toEqual([i]));
    ONLY2.forEach((w, i) => expect(idxOf(HEADER_LINES.filter((l) => l.toLowerCase().includes(w))), w).toEqual([i]));
    expect(HEADER_LINES.map((l, i) => (l.toLowerCase().includes("ris") ? i : -1)).filter((i) => i >= 0)).toEqual([4, 5, 6, 7, 8]);
    expect(HEADER_LINES.map((l, i) => (l.toLowerCase().includes("risk") ? i : -1)).filter((i) => i >= 0)).toEqual([4, 5, 6, 7, 8]);
  });
});

describe("TM2-32 edge: repeated tokens count once", () => {
  it("'risk risk' gives exactly the output of 'risk' (both scopes)", () => {
    for (const s of SCOPES) expect(searchApi("risk risk", s)).toBe(searchApi("risk", s));
  });

  it("a repeated token cannot outrank lines: 8 unique words + 'sell sell' still drops the sell line (ties to earlier)", () => {
    // distinct scoring: every line scores 1, so the 9th (sell) line loses the tie. Counting repeats would give the
    // sell line 2 and drop line 7 instead.
    const q = `${ONLY.slice(0, 8).join(" ")} sell sell sell`;
    for (const s of SCOPES) expect(idxOf(rulesOf(searchApi(q, s)))).toEqual(allBut(8));
    expect(oracle(q)).toEqual(allBut(8).map((i) => HEADER_LINES[i]));
  });

  it("repeating every token of a broad query list changes nothing", () => {
    for (const q of ["e", "e sell", "risk denied", "is nfo", "crypto symbols qty", ONLY.join(" ")]) {
      const rep = `${q} ${q} ${q.toUpperCase()}`;
      for (const s of SCOPES) expect(searchApi(rep, s), q).toBe(searchApi(q, s));
    }
  });
});

describe("TM2-32 edge: mixed case", () => {
  it.each(["E SELL", "e Sell", "E sElL", "e sell"])("%j behaves like 'e sell' and keeps the sell line", (q) => {
    for (const s of SCOPES) {
      expect(searchApi(q, s)).toBe(searchApi("e sell", s));
      expect(idxOf(rulesOf(searchApi(q, s)))).toEqual(allBut(7));
    }
  });

  it("'SELL sell Sell' + 8 unique words: case variants are one distinct token", () => {
    const q = `${ONLY.slice(0, 8).map((w) => w.toUpperCase()).join(" ")} SELL sell Sell`;
    expect(idxOf(rulesOf(searchApi(q)))).toEqual(allBut(8));
  });
});

describe("TM2-32 edge: substring tokens", () => {
  it("'risk' and 'risk denied': 'risk risk denied' = 'risk denied'; the risk-denied line is included", () => {
    expect(searchApi("risk risk denied")).toBe(searchApi("risk denied"));
    expect(rulesOf(searchApi("risk denied")).some((l) => l.includes("'risk denied"))).toBe(true);
  });

  it("'ris' and 'risk' are two distinct tokens: both count, so risk lines outrank a line with one unique word", () => {
    // scores: lines 0-2 = e + 2 unique = 3; line 3 = e + 1 unique = 2; lines 4-7 = e + ris + risk = 3; line 8 = 4.
    // Distinct counting drops line 3. Collapsing substring tokens would score 4-7 as 2 and drop line 7.
    const q = "e ris risk await body arguments plain broker futures ddmonyy sell";
    for (const s of SCOPES) expect(idxOf(rulesOf(searchApi(q, s)))).toEqual(allBut(3));
    expect(idxOf(oracle(q))).toEqual(allBut(3));
  });
});

describe("TM2-32 edge: ties", () => {
  it.each(["e", "a", "o", "e a o", "E A O e"])("%j: all 9 lines tie, so the last (cap) line is dropped", (q) => {
    for (const s of SCOPES) expect(idxOf(rulesOf(searchApi(q, s)))).toEqual(allBut(8));
  });

  it("all 9 lines tie at score 9 (one unique word each): first 8 kept", () => {
    expect(idxOf(rulesOf(searchApi(ONLY.join(" "))))).toEqual(allBut(8));
    expect(idxOf(rulesOf(searchApi([...ONLY].reverse().join(" "))))).toEqual(allBut(8)); // token order irrelevant
  });

  it("one line scoring higher survives anywhere; among the 1-scorers the latest is dropped", () => {
    for (let k = 0; k < 9; k++) {
      const q = `e ${ONLY[k]}`;
      const dropped = k === 8 ? 7 : 8;
      expect(idxOf(rulesOf(searchApi(q))), q).toEqual(allBut(dropped));
    }
  });

  it("output is header order even when the top scorer is the last line", () => {
    const r = idxOf(rulesOf(searchApi("e sell maxShortOptionQtyPerOrder")));
    expect(r).toEqual(allBut(7));
    expect(r[r.length - 1]).toBe(8);
  });
});

describe("TM2-32 edge: 8 vs 9 matches", () => {
  it("exactly 8 matching lines ('is'): all 8, identical to header-order filter", () => {
    const exp = HEADER_LINES.filter((l) => l.toLowerCase().includes("is"));
    expect(exp).toHaveLength(8);
    for (const s of SCOPES) expect(rulesOf(searchApi("is", s))).toEqual(exp);
  });

  it("8 unique words for lines 1..8 (8 matches): all kept, including the cap line", () => {
    expect(idxOf(rulesOf(searchApi(ONLY.slice(1).join(" "))))).toEqual(allBut(0));
  });

  it("9 matches ('is nfo'): exactly one dropped, the lowest-scoring latest line (7)", () => {
    // line 8 has is+nfo = 2, every other line 1
    expect(idxOf(rulesOf(searchApi("is nfo")))).toEqual(allBut(7));
  });

  it("all 9 match with many tokens: always exactly 8, never more", () => {
    for (const q of ["e a o", "e risk crypto symbols", `${ONLY.join(" ")} e a o is the`]) expect(rulesOf(searchApi(q)), q).toHaveLength(8);
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
    expect(rulesOf(searchApi(q))).toHaveLength(8);
  });

  it("200 copies of one token is as fast and equals the single token", () => {
    const q = Array(200).fill("risk").join(" ");
    const t0 = performance.now();
    const out = searchApi(q);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out).toBe(searchApi("risk"));
  });
});
