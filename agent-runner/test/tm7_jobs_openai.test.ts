import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runOpenAiTask = vi.fn();
vi.mock("../src/openai.js", () => ({ runOpenAiTask: (...a: unknown[]) => runOpenAiTask(...a) }));

import { main } from "../src/main.js";
import { parseJobs } from "../src/jobs.js";

const job = (backend: string, outputDir = "/tmp/out") => ({
  name: "j", schedule: { days: ["Mon"], time: "08:45", tz: "UTC" }, backend, prompt: "p",
  mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN_TM7" }, outputDir,
});

afterEach(() => { runOpenAiTask.mockReset(); vi.restoreAllMocks(); });

describe("jobs backend api-openai", () => {
  it("parseJobs accepts api-openai", () => {
    expect(parseJobs([job("api-openai")])[0].backend).toBe("api-openai");
  });
  it.each([["openai"], ["API-OPENAI"], [""]])("rejects backend %j listing all five", (b) => {
    expect(() => parseJobs([job(b)])).toThrow("backend must be claude|codex|gemini|api|api-openai");
  });
  it("main --once routes an api-openai job to runOpenAiTask", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "tm7-"));
    const file = path.join(d, "jobs.json");
    writeFileSync(file, JSON.stringify([job("api-openai", path.join(d, "runs"))]));
    runOpenAiTask.mockResolvedValue({ ok: true, text: "hi", exitCode: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await main(["--jobs", file, "--once", "j"]);
    expect(runOpenAiTask).toHaveBeenCalledTimes(1);
    expect(runOpenAiTask.mock.calls[0][0]).toMatchObject({ backend: "api-openai", prompt: "p" });
  });
});
