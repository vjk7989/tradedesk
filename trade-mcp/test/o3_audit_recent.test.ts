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
    expect(await recent()).toEqual({ entries: [], skipped: 0 });
    writeFileSync(file, "");
    expect(await recent({})).toEqual({ entries: [], skipped: 0 });
  });

  it("returns last N, newest last, default 20; the call itself is audited", async () => {
    for (let i = 0; i < 30; i++) appendAudit(file, { action: "x", i });
    const r = ((await recent()) as any).entries as any[];
    expect(r).toHaveLength(20);
    expect(r[19].i).toBe(29);
    expect(r[0].i).toBe(10);
    expect((((await recent({ limit: 2 })) as any).entries as any[]).map((e) => e.i ?? e.action)).toEqual([29, "audit.recent"]);
    const last = readFileSync(file, "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last)).toMatchObject({ action: "audit.recent", decision: "allowed", count: 2 });
  });

  it("rejects invalid limits (not clamped)", async () => {
    for (const limit of [0, -1, 1.5, 201, NaN, "5"]) await expect(recent({ limit })).rejects.toThrow(/audit\.recent/);
    await expect(recent({ limit: 200 })).resolves.toMatchObject({ skipped: 0 });
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
    expect(((await recent()) as any).skipped).toBe(2);
  });

  it("reads only the tail of a 5 MB file", async () => {
    const pad = "p".repeat(900);
    const lines: string[] = [];
    for (let i = 0; i < 5500; i++) lines.push(JSON.stringify({ action: "bulk", i, pad }));
    writeFileSync(file, lines.join("\n") + "\n");
    const r = ((await recent({ limit: 200 })) as any).entries as any[];
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
    for (const n of ["run", "walkForward"]) {
      expect(API_DOCS.find((d) => d.ns === "backtest" && d.name === n)!.doc).toContain("backtest service busy, retry later");
    }
  });

  it("scrubs configured secret values nested in strings (key-name redaction misses them)", async () => {
    const secrets = ["MCPTOKEN-aaaaaaaa", "ROTOKEN-bbbbbbbb", "OAKEY-cccccccc", "BTTOKEN-dddddddd", "scrypt:hashhashhash"];
    const prev = process.env.OAUTH_PASSWORD_HASH;
    process.env.OAUTH_PASSWORD_HASH = secrets[4];
    try {
      appendAudit(file, { action: "x", error: { detail: ["boom " + secrets.join(" | ")] }, note: "short abc" });
      const b = createBindings(
        { client: {} as any, risk: {} as any, cfg: { mcpToken: secrets[0], mcpTokenReadonly: secrets[1], openalgoApiKey: secrets[2], btToken: secrets[3] } as any, auditFile: file },
        { id: "r1" },
      ) as any;
      const out = JSON.stringify(await b.audit.recent());
      for (const x of secrets) expect(out).not.toContain(x);
      expect(out).toContain("[REDACTED]");
      expect(out).toContain("short abc");
    } finally {
      if (prev === undefined) delete process.env.OAUTH_PASSWORD_HASH;
      else process.env.OAUTH_PASSWORD_HASH = prev;
    }
  });

  it("tops up from the newest rotated file, oldest to newest", async () => {
    const dir = path.dirname(file);
    writeFileSync(path.join(dir, "audit.2026-01-01.jsonl"), JSON.stringify({ i: "oldest" }) + "\n");
    writeFileSync(path.join(dir, "audit.2026-02-01.jsonl"), JSON.stringify({ i: "a" }) + "\n" + JSON.stringify({ i: "b" }) + "\n");
    writeFileSync(path.join(dir, "audit.2026-02-01.1.jsonl"), JSON.stringify({ i: "c" }) + "\n" + JSON.stringify({ i: "d" }) + "\n");
    writeFileSync(file, "");
    const r = (await recent({ limit: 3 })) as any;
    expect(r.entries.map((e: any) => e.i)).toEqual(["c", "d"]);
    writeFileSync(file, JSON.stringify({ i: "cur" }) + "\n");
    const r2 = (await recent({ limit: 3 })) as any;
    expect(r2.entries.map((e: any) => e.i)).toEqual(["c", "d", "cur"]);
  });
});
