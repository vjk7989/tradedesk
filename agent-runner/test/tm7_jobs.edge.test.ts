import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runOpenAiTask = vi.fn();
vi.mock("../src/openai.js", () => ({ runOpenAiTask: (...a: unknown[]) => runOpenAiTask(...a) }));

import { main } from "../src/main.js";
import { JobsError, parseJobs } from "../src/jobs.js";

const TOKEN_ENV = "MCP_TOKEN_TM7_EDGE";
const TOKEN = "tm7-secret-token-XYZ";
const tmp = () => mkdtempSync(path.join(tmpdir(), "tm7-edge-"));
const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: TOKEN_ENV };
const job = (backend: unknown, extra: Record<string, unknown> = {}) => ({
  name: "j", schedule: { days: ["Mon"], time: "08:45", tz: "UTC" }, backend, prompt: "p", mcp, outputDir: "/tmp/out", ...extra,
});
const SIX = "backend must be claude|codex|gemini|api|api-openai|api-gemini"; // six backends since TM2-3

afterEach(() => {
  runOpenAiTask.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env[TOKEN_ENV];
});

describe("TM-7 parseJobs backend api-openai (edges)", () => {
  it("accepts api-openai and keeps mcp + timeoutMs", () => {
    const [j] = parseJobs([job("api-openai", { timeoutMs: 4321 })]);
    expect(j).toMatchObject({ backend: "api-openai", mcp, timeoutMs: 4321 });
  });
  it("still accepts the four existing backends", () => {
    for (const b of ["claude", "codex", "gemini", "api"]) expect(parseJobs([job(b)])[0].backend).toBe(b);
  });
  it.each([["API-OPENAI"], ["Api-OpenAI"], [" api-openai "], ["api-openai "], ["api_openai"], ["openai"], [""], [null], [undefined], [5]])(
    "rejects backend %j with the six-backend message",
    (b) => {
      let err: unknown;
      try {
        parseJobs([job(b)]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(JobsError);
      expect((err as Error).message).toBe(`jobs[0]: ${SIX}`);
    },
  );
  it("reports the index of the bad job when an api-openai job precedes it", () => {
    expect(() => parseJobs([job("api-openai"), { ...job("API-OPENAI"), name: "k" }])).toThrow(`jobs[1]: ${SIX}`);
  });
});

describe("TM-7 api-openai jobs through main (mocked runOpenAiTask, no network)", () => {
  const writeJobs = (dir: string, extra: Record<string, unknown> = {}) => {
    const file = path.join(dir, "jobs.json");
    writeFileSync(file, JSON.stringify([job("api-openai", { timeoutMs: 1234, outputDir: path.join(dir, "runs"), ...extra })]));
    return file;
  };

  it("--once passes the job's mcp and timeoutMs and the report redacts the token", async () => {
    process.env[TOKEN_ENV] = TOKEN;
    const d = tmp();
    const file = writeJobs(d);
    runOpenAiTask.mockResolvedValue({ ok: false, text: `answer with ${TOKEN} inside`, error: `boom ${TOKEN}`, exitCode: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await main(["--jobs", file, "--once", "j"]);
    expect(runOpenAiTask).toHaveBeenCalledTimes(1);
    expect(runOpenAiTask.mock.calls[0][0]).toMatchObject({ backend: "api-openai", prompt: "p", mcp, timeoutMs: 1234 });
    const out = readdirSync(path.join(d, "runs", "j"));
    expect(out).toHaveLength(1);
    const report = readFileSync(path.join(d, "runs", "j", out[0]), "utf8");
    expect(report).not.toContain(TOKEN);
    expect(report).toContain("answer with [redacted] inside");
    expect(report).toContain("- error: boom [redacted]");
    expect(report).toContain("- status: error");
  });

  it("--once records a rejected runOpenAiTask as an error report instead of crashing", async () => {
    process.env[TOKEN_ENV] = TOKEN;
    const d = tmp();
    const file = writeJobs(d);
    runOpenAiTask.mockRejectedValue(new Error(`network down ${TOKEN}`));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await main(["--jobs", file, "--once", "j"]);
    const out = readdirSync(path.join(d, "runs", "j"));
    const report = readFileSync(path.join(d, "runs", "j", out[0]), "utf8");
    expect(report).toContain("- error: network down [redacted]");
    expect(report).not.toContain(TOKEN);
  });

  it("the scheduler runs a due api-openai job with its mcp + timeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-30T08:44:59.000Z")); // Monday, 1 s before the 08:45 UTC slot
    const d = tmp();
    const file = writeJobs(d, { timeoutMs: 777 });
    const handlers: Record<string, () => void> = {};
    const exit = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    runOpenAiTask.mockImplementation(async () => {
      handlers.SIGINT(); // stop after this job: the scheduler finishes the running job, then exits
      return { ok: true, text: "scheduled-result", exitCode: null };
    });
    const p = main(["--jobs", file], { exit, onSignal: (s, fn) => void (handlers[s] = fn) });
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(runOpenAiTask).toHaveBeenCalledTimes(1);
    expect(runOpenAiTask.mock.calls[0][0]).toMatchObject({ backend: "api-openai", prompt: "p", mcp, timeoutMs: 777 });
    expect(exit).toHaveBeenCalledWith(0);
    const out = readdirSync(path.join(d, "runs", "j"));
    expect(out).toEqual(["2026-11-30.md"]);
    expect(readFileSync(path.join(d, "runs", "j", out[0]), "utf8")).toContain("scheduled-result");
  });
});

describe("TM-7 jobs.example.json", () => {
  it("still parses with the five-backend list", () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../jobs.example.json", import.meta.url)), "utf8"));
    const jobs = parseJobs(raw);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(["claude", "codex", "gemini", "api", "api-openai"]).toContain(j.backend);
  });
});
