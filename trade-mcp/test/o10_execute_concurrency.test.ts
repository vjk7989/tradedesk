import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";

const gates: Array<(mode: "ok" | "throw" | "timeout") => void> = [];
let started = 0;
vi.mock("../src/sandbox/quickjs.js", () => ({
  runCode: vi.fn(() => {
    started++;
    return new Promise((resolve, reject) => {
      gates.push((mode) => {
        if (mode === "throw") reject(new Error("boom"));
        else if (mode === "timeout") resolve({ ok: false, logs: [], error: "timeout: execution exceeded 1ms" });
        else resolve({ ok: true, result: 1, logs: [] });
      });
    });
  }),
}));
vi.mock("../src/sdk/bindings.js", () => ({ createBindings: () => ({}) }));

import { createMcpServer } from "../src/server.js";

async function connect(max?: number) {
  const cfg = { executeMaxConcurrent: max } as any;
  const server = createMcpServer({ cfg, client: {} as any, risk: {} as any, auditFile: "x" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(ct);
  return c;
}
const call = (c: Client) => c.callTool({ name: "execute", arguments: { code: "return 1" } }) as Promise<any>;
const parse = (r: any) => JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{")));
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => { gates.length = 0; started = 0; });

describe("O-10 execute concurrency cap", () => {
  it("N+1 concurrent calls give exactly N runs and 1 busy", async () => {
    const c = await connect(3);
    const ps = [call(c), call(c), call(c), call(c)];
    await tick();
    expect(started).toBe(3);
    const busy = parse(await ps[3]);
    expect(busy).toEqual({ ok: false, error: "busy: too many concurrent executes, retry shortly" });
    gates.forEach((g) => g("ok"));
    for (const p of ps.slice(0, 3)) expect(parse(await p).ok).toBe(true);
  });

  it.each(["ok", "throw", "timeout"] as const)("slot is freed after %s", async (mode) => {
    const c = await connect(1);
    const p = call(c);
    await tick();
    expect(parse(await call(c)).error).toMatch(/^busy/);
    gates[0](mode);
    await p.catch(() => {});
    const p2 = call(c);
    await tick();
    expect(started).toBe(2);
    gates[1]("ok");
    expect(parse(await p2).ok).toBe(true);
  });

  it("search is unaffected while saturated", async () => {
    const c = await connect(1);
    const p = call(c);
    await tick();
    const r: any = await c.callTool({ name: "search", arguments: { query: "" } });
    expect(r.isError).toBeFalsy();
    gates[0]("ok");
    await p;
  });
});

describe("O-10 EXECUTE_MAX_CONCURRENT parsing", () => {
  const base = { OPENALGO_URL: "http://localhost:5000", OPENALGO_API_KEY: "k", MCP_TOKEN: "t".repeat(32) };
  const get = (v?: string) => loadConfig({ ...base, ...(v === undefined ? {} : { EXECUTE_MAX_CONCURRENT: v }) }).executeMaxConcurrent;
  it.each([
    [undefined, 4], ["0", 1], ["1", 1], ["32", 32], ["33", 32], ["-1", 1], ["abc", 4], ["1.5", 4], ["", 4], [" 8 ", 8],
  ])("%j -> %j", (v, want) => {
    expect(get(v as any)).toBe(want);
  });
});
