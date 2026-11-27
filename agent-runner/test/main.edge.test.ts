import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runTask = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => runTask(...a),
}));

import { main } from "../src/main.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "main-edge-"));
const writeJobs = (dir: string, names: string[]) => {
  const file = path.join(dir, "jobs.json");
  writeFileSync(file, JSON.stringify(names.map((name) => ({
    name, schedule: { days: ["Mon"], time: "08:45", tz: "Asia/Kolkata" }, backend: "claude", prompt: `prompt ${name}`,
    mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN_MAIN_EDGE" },
    timeoutMs: 1234, outputDir: path.join(dir, "runs"),
  }))));
  return file;
};

afterEach(() => { runTask.mockReset(); vi.restoreAllMocks(); });

describe("main", () => {
  it.each([["--help"], ["-h"]])("%s prints usage and does not read jobs", async (flag) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main([flag, "--jobs", "/does/not/exist.json"])).resolves.toBeUndefined();
    expect(log.mock.calls[0][0]).toMatch(/--jobs .*--once/);
    expect(runTask).not.toHaveBeenCalled();
  });
  it("--once <name> runs exactly that job once and writes its output", async () => {
    const d = tmp();
    const file = writeJobs(d, ["a", "b"]);
    runTask.mockResolvedValue({ ok: true, text: "result-text", exitCode: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await main(["--jobs", file, "--once", "b"]);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0][0]).toMatchObject({ backend: "claude", prompt: "prompt b", timeoutMs: 1234 });
    const out = readdirSync(path.join(d, "runs", "b"));
    expect(out).toHaveLength(1);
    expect(readFileSync(path.join(d, "runs", "b", out[0]), "utf8")).toContain("result-text");
  });
  it("--once unknown rejects with 'no such job' and runs nothing", async () => {
    const file = writeJobs(tmp(), ["a"]);
    await expect(main(["--jobs", file, "--once", "nope"])).rejects.toThrow("no such job: nope");
    expect(runTask).not.toHaveBeenCalled();
  });
  it("missing jobs file rejects", async () => {
    await expect(main(["--jobs", path.join(tmp(), "missing.json"), "--once", "a"])).rejects.toThrow();
  });
  it("invalid jobs file rejects before running anything", async () => {
    const d = tmp();
    const file = path.join(d, "jobs.json");
    writeFileSync(file, JSON.stringify([{ name: "../x" }]));
    await expect(main(["--jobs", file, "--once", "../x"])).rejects.toThrow(/name/);
    writeFileSync(file, "{not json");
    await expect(main(["--jobs", file, "--once", "a"])).rejects.toThrow();
    expect(runTask).not.toHaveBeenCalled();
  });
  it("--once with a Windows-style absolute jobs path works", async () => {
    const d = tmp();
    const file = writeJobs(d, ["a"]).split(path.sep).join(path.win32.sep);
    runTask.mockResolvedValue({ ok: true, text: "", exitCode: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (process.platform === "win32") {
      await main(["--jobs", file, "--once", "a"]);
      expect(runTask).toHaveBeenCalledTimes(1);
    }
  });
  it("importing main.ts does not auto-run (no runTask call on import)", () => {
    expect(runTask).not.toHaveBeenCalled();
  });
});
