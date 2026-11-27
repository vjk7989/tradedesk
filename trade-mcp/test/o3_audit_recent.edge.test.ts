import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBindings } from "../src/sdk/bindings.js";
import { appendAudit } from "../src/risk/audit.js";
import { API_DOCS } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";

// Realistic secret values: random-looking, and none of them contains a key-name word
// (token/secret/...), so audit.ts key-name redaction cannot be what hides them.
const S = {
  mcpToken: "q7Zr2Kx9Lm4Wp8Vb3Nc6Hd1Fg5Jt0Ys",
  mcpTokenReadonly: "R0aa9fe1c2b7d84e6f3a5c0b9d8e7f6a",
  openalgoApiKey: "oa_5f2e8d1c9b7a6e4d3c2b1a0f9e8d7c6b",
  btToken: "bt-X4y8Z2w6V0u3T7s1R5q9P",
  oauthHash: "scrypt$16384$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
};
const SECRETS = Object.values(S);
const NAMES = ["mcpToken", "mcpTokenReadonly", "openalgoApiKey", "btToken", "OAUTH_PASSWORD_HASH"];

let dir: string;
let file: string;
let prevHash: string | undefined;
let prevMax: string | undefined;

const cfgOf = (over: Record<string, unknown> = {}) =>
  ({ mcpToken: S.mcpToken, mcpTokenReadonly: S.mcpTokenReadonly, openalgoApiKey: S.openalgoApiKey, btToken: S.btToken, ...over }) as any;
const mk = (scope?: "full" | "readonly", cfg: any = cfgOf()) =>
  createBindings({ client: {} as any, risk: {} as any, cfg, auditFile: file, scope }, { id: "r-edge" }) as any;
const recent = (args?: unknown, scope?: "full" | "readonly", cfg?: any) => mk(scope, cfg).audit.recent(args);
const line = (o: object) => JSON.stringify(o) + "\n";
const lastAuditLine = () => JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!);
/** JSON \uXXXX escape of every char of s (valid JSON string body). */
const uesc = (s: string) => [...s].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "o3e-"));
  file = path.join(dir, "audit.jsonl");
  prevHash = process.env.OAUTH_PASSWORD_HASH;
  prevMax = process.env.AUDIT_MAX_BYTES;
  process.env.OAUTH_PASSWORD_HASH = S.oauthHash;
  delete process.env.AUDIT_MAX_BYTES;
});
afterEach(() => {
  if (prevHash === undefined) delete process.env.OAUTH_PASSWORD_HASH;
  else process.env.OAUTH_PASSWORD_HASH = prevHash;
  if (prevMax === undefined) delete process.env.AUDIT_MAX_BYTES;
  else process.env.AUDIT_MAX_BYTES = prevMax;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- secrets
describe("O-3 edge: configured secret values never leak from audit.recent", () => {
  // Each placement writes one raw JSONL line holding secret s (bypassing write-time redaction).
  const placements: [string, (s: string) => string][] = [
    ["nested string", (s) => line({ action: "x", a: { b: { c: { d: s } } } })],
    ["substring of a longer string", (s) => line({ action: "x", error: `upstream said: bad auth tok=${s}; retry` })],
    ["array element", (s) => line({ action: "x", list: ["a", s, ["deep", s]] })],
    ["object key", (s) => line({ action: "x", args: { [s]: 1 } })],
    ["top-level object key", (s) => line({ action: "x", [s]: "v" })],
    ["value repeated many times", (s) => line({ action: "x", msg: Array.from({ length: 500 }, () => s).join("") + "|" + Array(50).fill(s).join(" ") })],
    ["fully \\u-escaped in the stored JSON", (s) => `{"action":"x","msg":"pre ${uesc(s)} post"}\n`],
    ["split: half raw, half \\u-escaped", (s) => `{"action":"x","msg":"${s.slice(0, 7)}${uesc(s.slice(7))}"}\n`],
  ];

  for (const [label, plant] of placements) {
    it.each(SECRETS.map((s, i) => [NAMES[i], s]))(`${label}: %s is scrubbed`, async (_name, s) => {
      writeFileSync(file, plant(s));
      const r = await recent();
      expect(r.entries).toHaveLength(1);
      expect(r.skipped).toBe(0);
      const out = JSON.stringify(r);
      for (const x of SECRETS) expect(out).not.toContain(x);
    });
  }

  it("all five secrets planted together in one entry, every placement at once", async () => {
    writeFileSync(file, placements.map(([, p]) => SECRETS.map(p).join("")).join(""));
    const r = await recent({ limit: 200 });
    expect(r.entries.length).toBe(placements.length * SECRETS.length);
    const out = JSON.stringify(r);
    for (const x of SECRETS) expect(out).not.toContain(x);
    expect(out).toContain("[REDACTED]");
  });

  it("secrets in the topped-up rotated file are scrubbed too", async () => {
    writeFileSync(path.join(dir, "audit.2026-11-01.jsonl"), line({ action: "old", msg: SECRETS.join(",") }));
    writeFileSync(file, "");
    const r = await recent();
    expect(r.entries.map((e: any) => e.action)).toEqual(["old"]);
    const out = JSON.stringify(r);
    for (const x of SECRETS) expect(out).not.toContain(x);
  });

  it("secret passed as a bad limit is audited raw, but a later recent() does not return it", async () => {
    await expect(recent({ limit: S.mcpToken })).rejects.toThrow(/audit\.recent/);
    const out = JSON.stringify(await recent({}, "readonly"));
    expect(out).not.toContain(S.mcpToken);
  });

  it("scrubbed in readonly scope as well", async () => {
    writeFileSync(file, line({ action: "x", e: SECRETS.join(" ") }));
    const out = JSON.stringify(await recent({}, "readonly"));
    for (const x of SECRETS) expect(out).not.toContain(x);
  });

  it("OAUTH_PASSWORD_HASH is read at call time (changed env after binding creation)", async () => {
    const b = mk();
    process.env.OAUTH_PASSWORD_HASH = "later-set-hash-value-0001";
    writeFileSync(file, line({ action: "x", m: "h=later-set-hash-value-0001" }));
    expect(JSON.stringify(await b.audit.recent())).not.toContain("later-set-hash-value-0001");
  });

  it("documented limit: secrets shorter than 8 chars are not scrubbed; exactly 8 are", async () => {
    const cfg = cfgOf({ btToken: "abc1234", openalgoApiKey: "xyz98765" });
    writeFileSync(file, line({ action: "x", m: "abc1234 xyz98765" }));
    const out = JSON.stringify(await recent({}, undefined, cfg));
    expect(out).toContain("abc1234"); // 7 chars: left as is
    expect(out).not.toContain("xyz98765"); // 8 chars: scrubbed
  });

  it("unset / empty secrets do not scrub everything (no empty-string split)", async () => {
    delete process.env.OAUTH_PASSWORD_HASH;
    const cfg = { mcpToken: S.mcpToken, mcpTokenReadonly: undefined, openalgoApiKey: "", btToken: undefined };
    writeFileSync(file, line({ action: "plain", m: "hello" }));
    expect((await recent({}, undefined, cfg)).entries).toEqual([{ action: "plain", m: "hello" }]);
  });

  it("all-digit secret stored as a JSON number is scrubbed", async () => {
    // A configured token that happens to be digits only and was logged as a number.
    const cfg = cfgOf({ btToken: "987654321012" });
    writeFileSync(file, `{"action":"x","n":987654321012}\n`);
    expect(JSON.stringify(await recent({}, undefined, cfg))).not.toContain("987654321012");
  });
});

// ---------------------------------------------------------------- scope
describe("O-3 edge: scope", () => {
  it("readonly token scope can call it, and has no trade namespace", async () => {
    appendAudit(file, { action: "a" });
    const b = mk("readonly");
    expect(b.trade).toBeUndefined();
    await expect(b.audit.recent()).resolves.toMatchObject({ entries: [{ action: "a" }], skipped: 0 });
  });

  it("trade (full) scope and undefined scope can call it", async () => {
    appendAudit(file, { action: "a" });
    for (const sc of ["full", undefined] as const) {
      const r = await recent({ limit: 1 }, sc);
      expect(r.entries).toHaveLength(1);
      expect(typeof r.skipped).toBe("number");
    }
  });

  it("api-docs: listed in readonly and full search for 'audit'", () => {
    for (const sc of ["readonly", "full"] as const) {
      const s = searchApi("audit", sc);
      expect(s).toContain("recent(args?: { limit?: number }): Promise<{ entries: object[]; skipped: number }>");
    }
  });
});

// ---------------------------------------------------------------- limits
describe("O-3 edge: limit validation", () => {
  beforeEach(() => {
    for (let i = 0; i < 250; i++) appendFileSync(file, line({ action: "x", i }));
  });

  it("default is 20 (no args, {}, null args, explicit undefined)", async () => {
    for (const a of [undefined, {}, null, { limit: undefined }]) {
      const r = await recent(a);
      expect(r.entries).toHaveLength(20);
    }
  });

  it("1 and 200 accepted (both sides of each limit)", async () => {
    const one = await recent({ limit: 1 });
    expect(one.entries).toHaveLength(1);
    expect(one.entries[0].i).toBe(249);
    const max = await recent({ limit: 200 });
    expect(max.entries).toHaveLength(200);
    // the limit:1 call above appended its own audit line, which is now the newest
    expect(max.entries[0].i).toBe(51);
    expect(max.entries[198].i).toBe(249);
    expect(max.entries[199]).toMatchObject({ action: "audit.recent", count: 1 });
  });

  it.each([0, -1, 201, 1.5, 199.9999, Number.MAX_SAFE_INTEGER])("rejects out-of-range / non-integer %s", async (limit) => {
    await expect(recent({ limit })).rejects.toThrow('audit.recent: "limit" must be an integer from 1 to 200');
  });

  it.each([NaN, Infinity, -Infinity, "5", "", null, true, [5], { n: 5 }])("rejects non-number %s with the finite-number message", async (limit) => {
    await expect(recent({ limit })).rejects.toThrow('audit.recent: "limit" must be a finite number');
  });

  it("rejects unknown fields and non-object args in the existing style", async () => {
    await expect(recent({ limit: 5, extra: 1 })).rejects.toThrow('audit.recent: unknown field "extra"');
    for (const a of [[], "x", 5]) await expect(recent(a)).rejects.toThrow("audit.recent: args must be an object");
  });

  it("a rejection is audited as decision=error", async () => {
    await expect(recent({ limit: 0 })).rejects.toThrow();
    expect(lastAuditLine()).toMatchObject({ action: "audit.recent", decision: "error", error: expect.stringContaining("limit") });
  });
});

// ---------------------------------------------------------------- files
describe("O-3 edge: file contents", () => {
  it("missing file, empty file, only newlines / whitespace -> {entries: [], skipped: 0}", async () => {
    expect(await recent()).toEqual({ entries: [], skipped: 0 });
    for (const body of ["", "\n", "\n\n\n\n", "\r\n\r\n", "  \n\t\n"]) {
      const f = path.join(mkdtempSync(path.join(tmpdir(), "o3e-")), "audit.jsonl");
      writeFileSync(f, body);
      const b = createBindings({ client: {} as any, risk: {} as any, cfg: cfgOf(), auditFile: f }, { id: "r" }) as any;
      expect(await b.audit.recent()).toEqual({ entries: [], skipped: 0 });
    }
  });

  it("missing directory too", async () => {
    file = path.join(dir, "nope", "deeper", "audit.jsonl");
    expect(await recent()).toEqual({ entries: [], skipped: 0 });
  });

  it("corrupt lines (garbage, array, scalar, null, string) are counted in skipped", async () => {
    writeFileSync(file, [line({ action: "a" }), "{bad\n", "[1,2]\n", "42\n", "null\n", '"str"\n', "true\n", line({ action: "b" })].join(""));
    const r = await recent();
    expect(r.entries.map((e: any) => e.action)).toEqual(["a", "b"]);
    expect(r.skipped).toBe(6);
  });

  it("skipped counts corrupt lines in the whole window, not only within the last `limit`", async () => {
    writeFileSync(file, "{bad\n" + Array.from({ length: 10 }, (_, i) => line({ i })).join(""));
    const r = await recent({ limit: 2 });
    expect(r.entries.map((e: any) => e.i)).toEqual([8, 9]);
    expect(r.skipped).toBe(1);
  });

  it("5 MB file: tail-bounded (garbage head is never parsed) and fast", async () => {
    // ~4 MB of corrupt lines at the head, then ~0.9 MB of valid lines at the tail.
    const garbage = ("{not json " + "g".repeat(1000) + "\n").repeat(4300);
    const pad = "p".repeat(880);
    const valid = Array.from({ length: 1000 }, (_, i) => line({ action: "bulk", i, pad })).join("");
    writeFileSync(file, garbage + valid);
    expect(readFileSync(file).length).toBeGreaterThan(5 * 1024 * 1024);
    const t0 = performance.now();
    const r = await recent({ limit: 200 });
    const ms = performance.now() - t0;
    expect(r.skipped).toBeLessThanOrEqual(200); // only garbage inside the last ~1 MB, never ~4100
    expect(r.entries).toHaveLength(200);
    expect(r.entries[199].i).toBe(999);
    expect(r.entries[0].i).toBe(800);
    expect(ms).toBeLessThan(2000);
  });

  it("5 MB file of valid lines: window entries all well-formed, first cut line dropped", async () => {
    const pad = "p".repeat(900);
    writeFileSync(file, Array.from({ length: 5600 }, (_, i) => line({ action: "bulk", i, pad })).join(""));
    const r = await recent({ limit: 200 });
    expect(r.skipped).toBe(0); // the cut-off first line is dropped, not counted as corrupt
    expect(r.entries.every((e: any) => e.action === "bulk" && e.pad === pad)).toBe(true);
  });

  for (const offsetInChar of [1, 2]) {
    it(`multi-byte UTF-8 char split at the 1 MB boundary (byte ${offsetInChar} of 3): no bogus entry`, async () => {
      const MB = 1024 * 1024;
      const tail = Array.from({ length: 50 }, (_, i) => line({ action: "tail", i, s: "€ü日" })).join("");
      const tailBytes = Buffer.byteLength(tail);
      // window start = size - 1 MB. Bytes inside the window from the pre line: (3 - offsetInChar) of a split
      // euro, k whole euros, `fill` ascii bytes and the closing quote/brace/newline; so the start lands mid-euro.
      const head = '{"action":"pre","s":"';
      const end = '"}\n';
      const need = MB - tailBytes;
      const k = Math.floor((need - end.length - (3 - offsetInChar)) / 3);
      const fill = need - end.length - (3 - offsetInChar) - 3 * k;
      const body = head + "€".repeat(k + 10) + "a".repeat(fill) + end + tail;
      writeFileSync(file, "x".repeat(100) + "\n" + body);
      const buf = readFileSync(file);
      const start = buf.length - MB;
      // the byte at the window start is a UTF-8 continuation byte
      expect(buf[start] & 0xc0).toBe(0x80);
      const r = await recent({ limit: 200 });
      expect(r.skipped).toBe(0);
      expect(r.entries.map((e: any) => e.action)).toEqual(Array(50).fill("tail"));
      expect(JSON.stringify(r)).not.toContain("Fffd");
      expect(r.entries[49]).toEqual({ action: "tail", i: 49, s: "€ü日" });
    });
  }

  it("window starting exactly on a line boundary: whole first line dropped, nothing bogus", async () => {
    const MB = 1024 * 1024;
    const l = line({ action: "z", pad: "q".repeat(1000) });
    const n = Math.floor(MB / Buffer.byteLength(l)) - 1;
    const fill = MB - n * Buffer.byteLength(l); // one first line of exactly `fill` bytes
    const first = '{"action":"first","p":"' + "f".repeat(fill - 26) + '"}\n';
    expect(Buffer.byteLength(first)).toBe(fill);
    writeFileSync(file, line({ action: "outside" }) + first + l.repeat(n));
    const r = await recent({ limit: 200 });
    expect(r.skipped).toBe(0);
    expect(r.entries.every((e: any) => e.action === "z")).toBe(true);
  });

  it("partial last line while a write is in progress: complete lines returned, partial counted in skipped", async () => {
    writeFileSync(file, line({ action: "a" }) + line({ action: "b" }) + '{"action":"c","args":{"sym');
    const r = await recent();
    expect(r.entries.map((e: any) => e.action)).toEqual(["a", "b"]);
    expect(r.skipped).toBe(1);
    expect(JSON.stringify(r)).not.toContain('"c"');
  });

  it("CRLF line endings parse cleanly", async () => {
    writeFileSync(file, [{ action: "a" }, { action: "b" }, { action: "c" }].map((o) => JSON.stringify(o)).join("\r\n") + "\r\n");
    const r = await recent();
    expect(r).toEqual({ entries: [{ action: "a" }, { action: "b" }, { action: "c" }], skipped: 0 });
  });

  it("concurrent calls all return the stable shape", async () => {
    for (let i = 0; i < 30; i++) appendAudit(file, { action: "x", i });
    const rs = await Promise.all(Array.from({ length: 10 }, () => recent({ limit: 5 })));
    for (const r of rs) {
      expect(Object.keys(r).sort()).toEqual(["entries", "skipped"]);
      expect(r.entries).toHaveLength(5);
      expect(r.skipped).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- rotation
describe("O-3 edge: rotation top-up", () => {
  const w = (name: string, ...xs: object[]) => writeFileSync(path.join(dir, name), xs.map(line).join(""));

  it("empty current file + rotated -> entries from rotated, oldest to newest", async () => {
    w("audit.2026-11-27.jsonl", { i: 1 }, { i: 2 }, { i: 3 });
    writeFileSync(file, "");
    expect(await recent()).toEqual({ entries: [{ i: 1 }, { i: 2 }, { i: 3 }], skipped: 0 });
  });

  it("missing current file + rotated -> entries from rotated", async () => {
    w("audit.2026-11-27.jsonl", { i: 1 }, { i: 2 });
    expect((await recent()).entries).toEqual([{ i: 1 }, { i: 2 }]);
  });

  it("only the newest rotated file is used (date beats suffix; suffix compared numerically)", async () => {
    w("audit.2026-11-26.jsonl", { f: "26" });
    w("audit.2026-11-27.jsonl", { f: "27" });
    w("audit.2026-11-27.9.jsonl", { f: "27.9" });
    w("audit.2026-11-27.10.jsonl", { f: "27.10" });
    w("audit.2026-11-25.99.jsonl", { f: "25.99" });
    writeFileSync(file, "");
    expect((await recent({ limit: 200 })).entries).toEqual([{ f: "27.10" }]);
  });

  it("current file short of limit is topped up: rotated tail first, then current", async () => {
    w("audit.2026-11-27.jsonl", ...Array.from({ length: 10 }, (_, i) => ({ r: i })));
    writeFileSync(file, line({ c: 0 }) + line({ c: 1 }));
    const r = await recent({ limit: 5 });
    expect(r.entries).toEqual([{ r: 7 }, { r: 8 }, { r: 9 }, { c: 0 }, { c: 1 }]);
  });

  it("current file already holds limit entries: rotated is not read", async () => {
    w("audit.2026-11-27.jsonl", { r: 0 }, "x" as any);
    writeFileSync(file, line({ c: 0 }) + line({ c: 1 }));
    expect(await recent({ limit: 2 })).toEqual({ entries: [{ c: 0 }, { c: 1 }], skipped: 0 });
  });

  it("skipped sums corrupt lines from current and the rotated top-up", async () => {
    writeFileSync(path.join(dir, "audit.2026-11-27.jsonl"), "{bad\n" + line({ r: 1 }));
    writeFileSync(file, "nope\n" + line({ c: 1 }));
    expect(await recent()).toEqual({ entries: [{ r: 1 }, { c: 1 }], skipped: 2 });
  });

  it("non-matching siblings are ignored (other base, bad date shape, wrong extension, prefix lookalike)", async () => {
    w("other.2026-11-27.jsonl", { bad: 1 });
    w("audit.2026-1-27.jsonl", { bad: 2 });
    w("audit.2026-11-27.jsonl.bak", { bad: 3 });
    w("audit.2026-11-27.log", { bad: 4 });
    w("xaudit.2026-11-28.jsonl", { bad: 5 });
    w("audit.2026-11-27.x.jsonl", { bad: 6 });
    writeFileSync(file, "");
    expect(await recent()).toEqual({ entries: [], skipped: 0 });
  });

  it("regex-special characters in the audit base name are escaped", async () => {
    file = path.join(dir, "a(1)+.jsonl");
    w("a(1)+.2026-11-27.jsonl", { ok: 1 });
    w("a1+.2026-11-28.jsonl", { bad: 1 });
    expect((await recent()).entries).toEqual([{ ok: 1 }]);
  });

  it("file names produced by audit.ts rotation (date change, then size, with .N suffix) are recognised", async () => {
    // date-change rotation: the existing file is renamed to audit.<mtime IST date>.jsonl
    appendAudit(file, { action: "day1" });
    const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    appendAudit(file, { action: "day2" }, () => tomorrow);
    expect(await recent({ limit: 2 })).toMatchObject({ entries: [{ action: "day1" }, { action: "day2" }], skipped: 0 });

    // size rotation on the same day: audit.D.jsonl, audit.D.1.jsonl, audit.D.2.jsonl
    const d2 = mkdtempSync(path.join(tmpdir(), "o3e-rot-"));
    file = path.join(d2, "audit.jsonl");
    process.env.AUDIT_MAX_BYTES = "1";
    for (const a of ["e0", "e1", "e2", "e3"]) appendAudit(file, { action: a });
    delete process.env.AUDIT_MAX_BYTES;
    const r = await recent({ limit: 5 });
    // current holds e3; only the newest rotated (.2 = e2) tops it up, e0/e1 are older files
    expect(r.entries.map((e: any) => e.action)).toEqual(["e2", "e3"]);
  });
});

// ---------------------------------------------------------------- self-audit + docs
describe("O-3 edge: self-audit and docs", () => {
  it("the call is audited, and the audited entry does not contain the returned entries", async () => {
    appendAudit(file, { action: "planted", marker: "PLANTED-MARKER-7731" });
    const r = await recent({ limit: 5 });
    expect(JSON.stringify(r)).toContain("PLANTED-MARKER-7731");
    const raw = readFileSync(file, "utf8").trim().split("\n");
    const self = JSON.parse(raw[raw.length - 1]);
    expect(self).toMatchObject({ action: "audit.recent", decision: "allowed", args: { limit: 5 }, count: 1, skipped: 0 });
    expect(self.entries).toBeUndefined();
    expect(raw[raw.length - 1]).not.toContain("PLANTED-MARKER-7731");
  });

  it("successive calls see the previous call's own audit entry", async () => {
    await recent();
    const r = await recent();
    expect(r.entries.map((e: any) => e.action)).toEqual(["audit.recent"]);
    expect(r.entries[0]).toMatchObject({ decision: "allowed", count: 0 });
  });

  it("api-docs entry: signature searchable for 'audit', exactly one, before risk.status", () => {
    const d = API_DOCS.filter((x) => x.ns === "audit");
    expect(d.map((x) => x.name)).toEqual(["recent"]);
    expect(d[0].signature).toMatch(/audit|recent/);
    expect(searchApi("audit")).toContain("declare namespace audit");
    expect(searchApi("AUDIT")).toContain("recent(");
    expect(d[0].doc).toMatch(/1-200/);
    expect(d[0].doc).toMatch(/default 20/);
  });

  it("busy text: exact client message everywhere it is quoted; no bare 'busy, retry later' left", () => {
    const all = API_DOCS.map((x) => `${x.signature}\n${x.doc}`).join("\n");
    const quoted = all.match(/'[^']*busy[^']*'/g) ?? [];
    expect(quoted.length).toBeGreaterThanOrEqual(2);
    for (const q of quoted) expect(q).toBe("'backtest service busy, retry later'");
    const client = readFileSync(path.resolve(__dirname, "../src/backtest/client.ts"), "utf8");
    expect(client).toContain("backtest service busy, retry later");
  });
});
