import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBindings } from "../src/sdk/bindings.js";
import { appendAudit } from "../src/risk/audit.js";
import { API_DOCS } from "../src/sdk/api-docs.js";
import { searchApi } from "../src/sdk/search.js";

let file: string;
const mk = (scope?: "full" | "readonly") =>
  createBindings({ client: {} as any, risk: {} as any, cfg: {} as any, auditFile: file, scope }, { id: "r1" }) as any;
const recent = (args?: unknown, scope?: "full" | "readonly") => mk(scope).audit.recent(args);

beforeEach(() => {
  file = path.join(mkdtempSync(path.join(tmpdir(), "o3-")), "audit.jsonl");
});

describe("O-3 audit.recent", () => {
  it("missing or empty file returns []", async () => {
    expect(await recent()).toEqual([]);
    writeFileSync(file, "");
    expect(await recent({})).toEqual([]);
  });

  it("returns last N, newest last, default 20; the call itself is audited", async () => {
    for (let i = 0; i < 30; i++) appendAudit(file, { action: "x", i });
    const r = (await recent()) as any[];
    expect(r).toHaveLength(20);
    expect(r[19].i).toBe(29);
    expect(r[0].i).toBe(10);
    expect(((await recent({ limit: 2 })) as any[]).map((e) => e.i ?? e.action)).toEqual([29, "audit.recent"]);
    const last = readFileSync(file, "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last)).toMatchObject({ action: "audit.recent", decision: "allowed", count: 2 });
  });

  it("rejects invalid limits (not clamped)", async () => {
    for (const limit of [0, -1, 1.5, 201, NaN, "5"]) await expect(recent({ limit })).rejects.toThrow(/audit\.recent/);
    await expect(recent({ limit: 200 })).resolves.toBeInstanceOf(Array);
    await expect(recent({ nope: 1 })).rejects.toThrow(/unknown field/);
    await expect(recent([])).rejects.toThrow(/object/);
  });

  it("skips corrupt lines and reports skipped", async () => {
    appendAudit(file, { action: "a" });
    writeFileSync(file, readFileSync(file, "utf8") + "{not json\n[1]\n");
    appendAudit(file, { action: "b" });
    const r = (await recent()) as any;
    expect(r.skipped).toBe(2);
    expect(r.entries.map((e: any) => e.action)).toEqual(["a", "b"]);
  });

  it("reads only the tail of a 5 MB file", async () => {
    const pad = "p".repeat(900);
    const lines: string[] = [];
    for (let i = 0; i < 5500; i++) lines.push(JSON.stringify({ action: "bulk", i, pad }));
    writeFileSync(file, lines.join("\n") + "\n");
    const r = (await recent({ limit: 200 })) as any[];
    expect(r).toHaveLength(200);
    expect(r[199].i).toBe(5499);
    expect(r[0].i).toBe(5300);
  });

  it("works in the readonly scope and never returns raw secrets", async () => {
    appendAudit(file, { action: "t", args: { apiKey: "SECRET123", token: "TOK" } });
    const r = await recent({}, "readonly");
    expect(JSON.stringify(r)).not.toMatch(/SECRET123|TOK"/);
    expect(mk("readonly").trade).toBeUndefined();
  });

  it("is documented and searchable; busy text is exact", () => {
    expect(API_DOCS.some((d) => d.ns === "audit" && d.name === "recent")).toBe(true);
    expect(searchApi("audit", "readonly")).toContain("recent(");
    for (const n of ["run"]) {
      expect(API_DOCS.find((d) => d.ns === "backtest" && d.name === n)!.doc).toContain("backtest service busy, retry later");
    }
  });
});
