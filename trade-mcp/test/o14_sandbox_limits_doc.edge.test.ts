import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { API_HEADER } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";
import { loadConfig } from "../src/config.js";
import { runCode } from "../src/sandbox/quickjs.js";
import { createMcpServer } from "../src/server.js";

// O-14 edge tests: the sandbox-limits block in API_HEADER cannot drift from the code. Every number is compared
// with the live value (exported default, or the source constant when it is not exported), every quoted error
// string must exist verbatim in the source, every named global must be gone in a real sandbox run, and the
// TM2-25 Rules search must surface the block.

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
const QJS = read("../src/sandbox/quickjs.ts");
const SERVER = read("../src/server.ts");
const SRC = QJS + "\n" + SERVER;

const MB = 1024 * 1024;
const LINES = API_HEADER.split("\n");
const at = LINES.findIndex((l) => l.startsWith("Sandbox limits: "));
const BLOCK = LINES.slice(at, at + 3);
const [MEM_LINE, BIND_LINE, EXEC_LINE] = BLOCK;
const TEXT = BLOCK.join("\n");

/** Value of `const NAME = <a> * <b> ...;` (integer products only). */
function srcConst(src: string, name: string): number {
  const m = src.match(new RegExp(`const ${name} = ([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*);`));
  if (!m) throw new Error(`${name} not found in source`);
  return m[1].split("*").reduce((a, x) => a * Number(x.trim().replace(/_/g, "")), 1);
}
/** Integer product expression (e.g. `64 * 1024 * 1024`) to its value. */
const product = (e: string) => e.split("*").reduce((a, x) => a * Number(x.trim().replace(/_/g, "")), 1);

/** REMOVED_GLOBALS parsed from quickjs.ts (not exported). */
function removedGlobals(): string[] {
  const m = QJS.match(/const REMOVED_GLOBALS = \[([\s\S]*?)\];/);
  if (!m) throw new Error("REMOVED_GLOBALS not found");
  return [...m[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((x) => x[1]);
}
const isTypedArray = (g: string) => /^(Big)?(Int|Uint|Float)\d+(Clamped)?Array$/.test(g);
/** Globals the block names in "No A, B, C or D; use plain arrays". */
function namedGlobals(line: string): string[] {
  const m = line.match(/No ([^;]+); use plain arrays/);
  if (!m) return [];
  return m[1].split(/,\s*|\s+or\s+/).map((s) => s.trim()).filter(Boolean);
}
/** REMOVED_GLOBALS entries the doc line fails to cover ("TypedArray" covers the typed-array constructors). */
function uncovered(line: string): string[] {
  const named = new Set(namedGlobals(line));
  return removedGlobals().filter((g) => !(named.has(g) || (isTypedArray(g) && named.has("TypedArray"))));
}
/** Single-quoted strings in the block. */
const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
/** Doc template "a <n> b" -> regex for the source template literal "a ${...} b". */
const srcTemplateRe = (q: string) =>
  new RegExp(q.split(/<\w+>/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\$\\{[^}]+\\}"));
/** Doc template "a <n> b" -> regex for a live error text. */
const liveRe = (q: string) =>
  new RegExp("^" + q.split(/<\w+>/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(\\d+)") + "$");

const BASE_ENV = { OPENALGO_URL: "http://127.0.0.1:5000", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(32) };

describe("O-14 edge: block shape", () => {
  it("the block exists once: three lines, contiguous, Sandbox limits / Binding calls / Executes", () => {
    expect(at).toBeGreaterThan(0);
    expect(LINES.filter((l) => l.startsWith("Sandbox limits: "))).toHaveLength(1);
    expect(MEM_LINE.startsWith("Sandbox limits: ")).toBe(true);
    expect(BIND_LINE.startsWith("Binding calls: ")).toBe(true);
    expect(EXEC_LINE.startsWith("Executes: ")).toBe(true);
    for (const l of BLOCK) expect(l.trim()).toBe(l); // no stray whitespace
  });
});

describe("O-14 edge: every number equals the live value", () => {
  it("memory: '<n> MB per run' equals runCode's default memoryBytes, and the server passes no memoryBytes", () => {
    const n = Number(MEM_LINE.match(/memory (\d+) MB per run/)![1]);
    const m = QJS.match(/opts\.memoryBytes \?\? ([0-9_ *]+);/);
    expect(m, "default memoryBytes expression").not.toBeNull();
    expect(n * MB).toBe(product(m![1]));
    const call = SERVER.match(/runCode\([^;]*\);/)![0];
    expect(call).not.toMatch(/memoryBytes/); // so the default is what every execute gets
  });

  it("binding argument cap: '<n> MB JSON' equals MAX_ARG_BYTES", () => {
    const n = Number(BIND_LINE.match(/argument max (\d+) MB JSON/)![1]);
    expect(n * MB).toBe(srcConst(QJS, "MAX_ARG_BYTES"));
  });

  it("binding result cap: 'min(<n> MB, memory/<d>)' equals MAX_RESULT_BYTES and the resultCap divisor", () => {
    const m = BIND_LINE.match(/result max min\((\d+) MB, memory\/(\d+)\)/)!;
    expect(m).not.toBeNull();
    expect(Number(m[1]) * MB).toBe(srcConst(QJS, "MAX_RESULT_BYTES"));
    expect(QJS).toContain(`Math.min(MAX_RESULT_BYTES, Math.floor(memoryBytes / ${m[2]}))`);
  });

  it("concurrency: '(default <n>)' equals loadConfig's default and the server fallback", () => {
    const n = Number(EXEC_LINE.match(/EXECUTE_MAX_CONCURRENT \(default (\d+)\)/)![1]);
    expect(loadConfig(BASE_ENV).executeMaxConcurrent).toBe(n);
    expect(loadConfig({ ...BASE_ENV, EXECUTE_MAX_CONCURRENT: "" }).executeMaxConcurrent).toBe(n);
    expect(loadConfig({ ...BASE_ENV, EXECUTE_MAX_CONCURRENT: "abc" }).executeMaxConcurrent).toBe(n);
    expect(SERVER).toContain(`executeMaxConcurrent ?? ${n})`);
  });

  it("timeout: '(default <n> ms)' equals loadConfig's default and the server fallback", () => {
    const n = Number(EXEC_LINE.match(/EXECUTE_TIMEOUT_MS \(default (\d+) ms\)/)![1]);
    expect(loadConfig(BASE_ENV).executeTimeoutMs).toBe(n);
    expect(loadConfig({ ...BASE_ENV, EXECUTE_TIMEOUT_MS: " " }).executeTimeoutMs).toBe(n);
    expect(SERVER).toContain(`executeTimeoutMs ?? ${n} }`);
  });

  it("code cap: 'Code max <n> KB' equals MAX_CODE_BYTES and the error text's own number", () => {
    const n = Number(EXEC_LINE.match(/Code max (\d+) KB/)![1]);
    expect(n * 1024).toBe(srcConst(SERVER, "MAX_CODE_BYTES"));
    expect(EXEC_LINE).toContain(`'code exceeds ${n}KB limit'`);
  });

  it("strictness: the number helpers reject a wrong figure", () => {
    expect(8 * MB).not.toBe(srcConst(QJS, "MAX_ARG_BYTES"));
    expect(() => srcConst(QJS, "NO_SUCH_CONST")).toThrow();
  });
});

describe("O-14 edge: every quoted error string is in the source", () => {
  const qs = quoted(TEXT);

  it("the block quotes exactly the six known error texts", () => {
    expect(qs).toHaveLength(6);
    expect(qs.filter((q) => /<\w+>/.test(q))).toHaveLength(2); // the two templates
  });

  it.each(qs.map((q) => [q]))("%s", (q) => {
    if (/<\w+>/.test(q)) expect(SRC, q).toMatch(srcTemplateRe(q));
    else expect(SRC, q).toMatch(new RegExp(`["'\`]${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`));
  });

  it("strictness: an altered or reworded string is not found", () => {
    expect(SRC).not.toMatch(/["'`]memory limit exceed["'`]/);
    expect(SRC).not.toMatch(srcTemplateRe("timeout: execution exceeded <ms> ms"));
    expect(SRC).not.toMatch(srcTemplateRe("binding result too big (<n> chars, max <m>): narrow the query"));
    expect(SRC).not.toMatch(srcTemplateRe("binding result too large (<n> bytes, max <m>)"));
  });
});

describe("O-14 edge: disallowed globals", () => {
  it("REMOVED_GLOBALS parses to a non-empty list containing the core buffer globals", () => {
    const g = removedGlobals();
    expect(g.length).toBeGreaterThanOrEqual(5);
    for (const x of ["ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly", "Uint8Array"]) expect(g).toContain(x);
  });

  it("the doc covers every REMOVED_GLOBALS entry (typed arrays via 'TypedArray', the rest by name)", () => {
    expect(uncovered(MEM_LINE)).toEqual([]);
  });

  it("the doc names nothing outside REMOVED_GLOBALS (except the 'TypedArray' family name)", () => {
    const g = new Set(removedGlobals());
    const named = namedGlobals(MEM_LINE);
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(n === "TypedArray" || g.has(n), n).toBe(true);
    expect(removedGlobals().some(isTypedArray)).toBe(true); // 'TypedArray' does stand for something
  });

  it("strictness: dropping SharedArrayBuffer (or any name) from the line is detected", () => {
    expect(uncovered(MEM_LINE.replace("SharedArrayBuffer, ", ""))).toEqual(["SharedArrayBuffer"]);
    expect(uncovered(MEM_LINE.replace("TypedArray, ", "")).every(isTypedArray)).toBe(true);
    expect(uncovered(MEM_LINE.replace("TypedArray, ", "")).length).toBeGreaterThan(0);
    expect(uncovered(MEM_LINE.replace(" or WebAssembly", ""))).toEqual(["WebAssembly"]);
    expect(uncovered("no list at all")).toEqual(removedGlobals());
  });

  it("every named global and every REMOVED_GLOBALS entry is undefined in a real sandbox run", async () => {
    const names = [...new Set([...namedGlobals(MEM_LINE).filter((n) => n !== "TypedArray"), ...removedGlobals()])];
    const r = await runCode(
      `const n = ${JSON.stringify(names)};
       return { viaGlobal: n.filter((g) => globalThis[g] !== undefined), viaTypeof: n.filter((g) => eval("typeof " + g) !== "undefined") };`,
      {},
    );
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ viaGlobal: [], viaTypeof: [] });
  });

  it("plain arrays (the advised replacement) still work", async () => {
    const r = await runCode(`const a = [1, 2, 3]; return a.map((x) => x * 2).reduce((s, x) => s + x, 0);`, {});
    expect(r).toMatchObject({ ok: true, result: 12 });
  });
});

describe("O-14 edge: documented errors fire live with the documented text", () => {
  const echo = { t: { echo: async (a: unknown) => a, big: async (n: unknown) => "x".repeat(Number(n)) } };
  const ARG = 1024 * 1024; // JSON of a string of k chars is k + 2 bytes

  it("binding argument: exactly 1 MB JSON passes, one byte more is 'binding argument too large'", async () => {
    const ok = await runCode(`const r = await t.echo("x".repeat(${ARG - 2})); return r.length;`, echo);
    expect(ok).toMatchObject({ ok: true, result: ARG - 2 });
    const bad = await runCode(`try { await t.echo("x".repeat(${ARG - 1})); return "passed"; } catch (e) { return e.message; }`, echo);
    expect(bad.result).toBe(quoted(BIND_LINE)[0]);
  });

  it("binding result at default memory: max is 4 MB (min(4 MB, 64 MB/4)); exactly the cap passes, one char more fails", async () => {
    const cap = 4 * MB; // JSON of a k-char string is k + 2 chars
    const ok = await runCode(`return (await t.big(${cap - 2})).length;`, echo, { timeoutMs: 30_000 });
    expect(ok).toMatchObject({ ok: true, result: cap - 2 });
    const bad = await runCode(`try { await t.big(${cap - 1}); return "passed"; } catch (e) { return e.message; }`, echo, { timeoutMs: 30_000 });
    const m = String(bad.result).match(liveRe(quoted(BIND_LINE)[1]));
    expect(m, String(bad.result)).not.toBeNull();
    expect(Number(m![1])).toBe(cap + 1);
    expect(Number(m![2])).toBe(cap);
  });

  it("binding result with small memory: the memory/4 side of the min wins", async () => {
    const mem = 8 * MB;
    const bad = await runCode(`try { await t.big(${mem / 4}); return "passed"; } catch (e) { return e.message; }`, echo, { memoryBytes: mem });
    const m = String(bad.result).match(liveRe(quoted(BIND_LINE)[1]));
    expect(m, String(bad.result)).not.toBeNull();
    expect(Number(m![2])).toBe(mem / 4);
  });

  it("memory: going past the default limit fails with exactly 'memory limit exceeded'", async () => {
    const r = await runCode(`const s = "x".repeat(80 * 1024 * 1024); return s.length;`, {}, { timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(quoted(MEM_LINE)[0]);
  });

  it("timeout: a run over its limit fails with 'timeout: execution exceeded <ms>ms' carrying the limit", async () => {
    const r = await runCode(`while (true) {}`, {}, { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    const q = quoted(EXEC_LINE).find((x) => x.startsWith("timeout"))!;
    const m = r.error!.match(liveRe(q));
    expect(m, r.error).not.toBeNull();
    expect(Number(m![1])).toBe(200);
  });

  it("code cap via the real server: 100 KB passes the gate, 100 KB + 1 byte is 'code exceeds 100KB limit'", async () => {
    const cfg = { executeMaxConcurrent: 4, openalgoApiKey: "oa_secret_key_value_123", mcpToken: "t".repeat(32) } as any;
    const server = createMcpServer({ cfg, client: {} as any, risk: {} as any, auditFile: path.join(__dirname, "o14-unused.jsonl") });
    const [ct, sv] = InMemoryTransport.createLinkedPair();
    await server.connect(sv);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(ct);
    const body = (r: any) => JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{")));
    const code = (bytes: number) => {
      const head = "return 1;//";
      return head + "x".repeat(bytes - head.length);
    };
    const limit = 100 * 1024;
    const cap = quoted(EXEC_LINE).find((x) => x.startsWith("code exceeds"))!;
    const atLimit = body(await c.callTool({ name: "execute", arguments: { code: code(limit) } }));
    expect(atLimit.error).not.toBe(cap);
    expect(atLimit).toMatchObject({ ok: true, result: 1 });
    const over = body(await c.callTool({ name: "execute", arguments: { code: code(limit + 1) } }));
    expect(over).toMatchObject({ ok: false, error: cap });
    // byte count, not chars: 2-byte chars push a short string over the cap
    const wide = body(await c.callTool({ name: "execute", arguments: { code: "return 1;//" + "é".repeat(limit / 2) } }));
    expect(wide.error).toBe(cap);
    await c.close();
  });
});

describe("O-14 edge: TM2-25 Rules search returns the block", () => {
  const rulesOf = (out: string) => {
    if (!out.startsWith("// Rules:\n")) return [];
    const body = out.slice("// Rules:\n".length);
    const cut = body.indexOf("\n\n");
    return (cut < 0 ? body : body.slice(0, cut)).split("\n");
  };
  const CASES: [string, string[]][] = [
    ["memory", [MEM_LINE, BIND_LINE]],
    ["busy", [EXEC_LINE]],
    ["ArrayBuffer", [MEM_LINE]],
    ["concurrent", [EXEC_LINE]],
  ];

  for (const scope of ["full", "readonly"] as const) {
    for (const [q, want] of CASES) {
      it(`${scope}: "${q}" returns the matching block lines verbatim`, () => {
        const rules = rulesOf(searchApi(q, scope));
        for (const l of want) expect(rules, `${q} -> ${l.slice(0, 20)}`).toContain(l);
        // and only lines that really contain the token from the block
        for (const l of BLOCK) if (!want.includes(l)) expect(l.toLowerCase().includes(q.toLowerCase())).toBe(false);
      });
      it(`${scope}: "${q.toUpperCase()}" (case-insensitive) returns the same lines`, () => {
        expect(rulesOf(searchApi(q.toUpperCase(), scope))).toEqual(rulesOf(searchApi(q, scope)));
      });
    }
  }

  it("empty and whitespace queries list the header with the block, no Rules prefix", () => {
    for (const q of ["", "   "]) {
      const out = searchApi(q);
      expect(out.startsWith("// Rules:")).toBe(false);
      for (const l of BLOCK) expect(out).toContain(l);
    }
  });
});
