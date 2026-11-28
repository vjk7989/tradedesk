import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runGeminiTask = vi.fn();
vi.mock("../src/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/gemini.js")>()),
  runGeminiTask: (...a: unknown[]) => runGeminiTask(...a),
}));

import { parseJobs, DAYS } from "../src/jobs.js";
import { nextRun } from "../src/scheduler.js";
import { main } from "../src/main.js";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const FILE = here("../jobs.gemini-paper.example.json");
const READONLY_FILE = here("../jobs.example.json");
const load = (f: string) => JSON.parse(readFileSync(f, "utf8"));

// Token env names, read from the server's config code rather than hardcoded.
const serverConfig = readFileSync(here("../../trade-mcp/src/config.ts"), "utf8");
const FULL_TOKEN_ENV = /req\(env,\s*"(MCP_TOKEN)"\)/.exec(serverConfig)?.[1];
const READONLY_TOKEN_ENV = /env\.(MCP_TOKEN_READ\w+)/.exec(serverConfig)?.[1];

const jobs = parseJobs(load(FILE));
const job = jobs[0];
const prompt = job.prompt.toLowerCase();

describe("TM2-73 jobs.gemini-paper.example.json: shape", () => {
  it("parses through parseJobs with exactly one job, paper-crypto-gemini on api-gemini", () => {
    expect(jobs).toHaveLength(1);
    expect(job.name).toBe("paper-crypto-gemini");
    expect(job.backend).toBe("api-gemini");
  });

  it("has a valid UTC schedule that nextRun can use", () => {
    expect(job.schedule.tz).toBe("UTC");
    expect(job.schedule.days.length).toBeGreaterThan(0);
    for (const d of job.schedule.days) expect(DAYS).toContain(d);
    expect(job.schedule.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    const from = new Date("2026-11-28T12:00:00Z");
    const t = nextRun(job.schedule, from);
    expect(t.getTime()).toBeGreaterThan(from.getTime());
    expect(t.toISOString().slice(11, 16)).toBe(job.schedule.time);
  });

  it("uses the full MCP token env, not the read-only one (names taken from trade-mcp config)", () => {
    expect(FULL_TOKEN_ENV).toBe("MCP_TOKEN");
    expect(READONLY_TOKEN_ENV).toBeTruthy();
    expect(job.mcp.tokenEnv).toBe(FULL_TOKEN_ENV);
    expect(job.mcp.tokenEnv).not.toBe(READONLY_TOKEN_ENV);
  });

  it("mcp url is a placeholder https url (example.com or <DOMAIN>), no real domain", () => {
    const u = job.mcp.url;
    expect(u.startsWith("https://")).toBe(true);
    const host = u.includes("<DOMAIN>") ? "<DOMAIN>" : new URL(u).hostname;
    expect(host === "<DOMAIN>" || host === "example.com" || host.endsWith(".example.com")).toBe(true);
  });
});

describe("TM2-73 prompt safety", () => {
  it("checks risk.status() and mode first, and stops unless paper", () => {
    expect(prompt).toContain("risk.status()");
    expect(prompt).toMatch(/mode/);
    expect(prompt).toMatch(/"paper"|'paper'|\bpaper\b/);
    // risk.status/mode is the first thing the prompt asks for: before any market or trade call
    const firstRisk = prompt.indexOf("risk.status()");
    for (const later of ["market.search", "market.history", "trade.place"]) {
      expect(prompt.indexOf(later)).toBeGreaterThan(firstRisk);
    }
    expect(prompt).toMatch(/mode\s*!==?\s*"paper"[\s\S]{0,80}place nothing|place nothing[\s\S]{0,80}mode/);
    expect(prompt).toMatch(/\bstop\b/);
  });

  it("stops on the kill switch and on today.remainingOrders being 0", () => {
    expect(prompt).toMatch(/killswitch[\s\S]{0,80}(stop|place nothing)|(stop|place nothing)[\s\S]{0,80}killswitch/);
    expect(prompt).toMatch(/today\.remainingorders\s*(is|===?|==)\s*0/);
  });

  it("stops if risk.status() errors", () => {
    // "the call" in step 1 is risk.status(); the error case must lead to placing nothing
    expect(prompt).toMatch(/risk\.status\(\)[\s\S]{0,60}(if (the call|it|risk\.status\(\)) (errors|fails))[\s\S]{0,80}place nothing/);
  });

  it("at most ONE trade.place, quantity 1", () => {
    expect(prompt).toMatch(/at most one trade\.place/);
    expect(prompt).toMatch(/quantity 1\b/);
    expect(prompt).toMatch(/never more than 1\b/);
    expect(prompt).not.toMatch(/quantity\s*([2-9]|\d{2,})/);
  });

  it("never retries, and checks account.orders() read-only after a timeout or failure", () => {
    expect(prompt).toMatch(/never call trade\.place again|never retry|do not retry/);
    expect(prompt).toMatch(/timeout/);
    expect(prompt).toMatch(/failure|errors?/);
    expect(prompt).toMatch(/account\.orders\(\)[\s\S]{0,20}read-only/);
    // the account.orders check is tied to the failure/timeout case
    expect(prompt).toMatch(/(failure|timeout)[\s\S]{0,120}account\.orders\(\)/);
  });

  it("single symbol only, no loops", () => {
    expect(prompt).toMatch(/single symbol/);
    expect(prompt).toMatch(/never loop|no loops?/);
    expect(prompt).toMatch(/never trade any other instrument|no other (symbol|instrument)/);
  });

  it("forbids trade.cancel, trade.closePosition and trade.modify", () => {
    expect(prompt).toMatch(/never use trade\.cancel, trade\.closeposition or trade\.modify/);
  });

  it("states its reasoning", () => {
    expect(prompt).toMatch(/reasoning/);
    expect(prompt).toMatch(/always[\s\S]{0,40}reasoning/);
  });

  it("does NOT carry the read-only phrase, so it is never confused with jobs.example.json's rule", () => {
    expect(prompt).not.toContain("do not call trade");
  });
});

describe("TM2-73 separation from the read-only jobs.example.json", () => {
  const raw = load(READONLY_FILE);
  it("jobs.example.json has no api-gemini job and no paper-crypto-gemini", () => {
    for (const j of parseJobs(raw)) {
      expect(j.backend).not.toBe("api-gemini");
      expect(j.name).not.toBe("paper-crypto-gemini");
    }
  });
  it("every jobs.example.json prompt still says do not call trade", () => {
    expect(raw.length).toBeGreaterThan(0);
    for (const j of raw) expect(String(j.prompt).toLowerCase()).toContain("do not call trade");
  });
});

describe("TM2-73 --check on the new file (in-process main, as the other --check tests do)", () => {
  const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, MCP_TOKEN: process.env.MCP_TOKEN };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
    runGeminiTask.mockReset();
  });

  async function check() {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
    const exit = vi.fn();
    await main(["--jobs", FILE, "--check"], { exit, onSignal: vi.fn() });
    return { out: out.join("\n"), exit };
  }

  it("lists the job with MCP_TOKEN and GEMINI_API_KEY missing when unset, exits 1, runs nothing", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MCP_TOKEN;
    const { out, exit } = await check();
    const row = out.split("\n").find((l) => l.startsWith("paper-crypto-gemini"));
    expect(row).toBeDefined();
    expect(row).toContain("api-gemini");
    expect(row).toContain("MCP_TOKEN: missing");
    expect(row).toContain("GEMINI_API_KEY: missing");
    expect(exit).toHaveBeenCalledWith(1);
    expect(runGeminiTask).not.toHaveBeenCalled();
  });

  it("never prints secret values, even when set", async () => {
    const tok = "FAKE_tm2_73_mcp_token_value_do_not_print_123";
    const key = "FAKE_tm2_73_gemini_key_value_do_not_print_456";
    process.env.MCP_TOKEN = tok;
    delete process.env.GEMINI_API_KEY;
    let r = await check();
    expect(r.out).toContain("MCP_TOKEN: set");
    expect(r.out).toContain("GEMINI_API_KEY: missing");
    expect(r.out).not.toContain(tok);
    expect(r.exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();

    process.env.GEMINI_API_KEY = key;
    r = await check();
    expect(r.out).toContain("GEMINI_API_KEY: set");
    expect(r.out).not.toContain(tok);
    expect(r.out).not.toContain(key);
    expect(r.exit).toHaveBeenCalledWith(0);
    expect(runGeminiTask).not.toHaveBeenCalled();
  });
});
