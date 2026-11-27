import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runTask = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runTask: (...a: unknown[]) => runTask(...a),
}));

import { main } from "../src/main.js";

afterEach(() => { runTask.mockReset(); vi.restoreAllMocks(); });

describe("TM-6 --once exit guard", () => {
  it("two signals call exit(0) exactly once", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tm6-"));
    const file = path.join(dir, "jobs.json");
    writeFileSync(file, JSON.stringify([{
      name: "a", schedule: { days: ["Mon"], time: "08:45", tz: "Asia/Kolkata" }, backend: "claude", prompt: "p",
      mcp: { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN_TM6" },
      timeoutMs: 1234, outputDir: path.join(dir, "runs"),
    }]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers = new Map<string, () => void>();
    const onSignal = (s: string, fn: () => void) => void handlers.set(s, fn);
    const exit = vi.fn();
    runTask.mockReturnValue(new Promise(() => {}));
    void main(["--jobs", file, "--once", "a"], { exit, onSignal });
    await Promise.resolve();
    handlers.get("SIGINT")!();
    handlers.get("SIGTERM")!();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
