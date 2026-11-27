import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runTask } from "../src/cli.js";

type Script = { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException; hang?: boolean };

function fake(script: Script) {
  const calls: { cmd: string; args: string[]; opts: any }[] = [];
  const kill = vi.fn();
  const impl: any = (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1234;
    child.kill = kill;
    if (cmd !== "taskkill") {
      setImmediate(() => {
        if (script.error) return child.emit("error", script.error);
        if (script.hang) return;
        if (script.stdout) child.stdout.emit("data", Buffer.from(script.stdout));
        if (script.stderr) child.stderr.emit("data", Buffer.from(script.stderr));
        child.emit("close", script.code ?? 0);
      });
    }
    return child;
  };
  return { impl, calls, kill };
}

const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" };

describe("runTask", () => {
  it("claude: argv shape and result parse", async () => {
    const f = fake({
      stdout: '{"type":"system"}\n{"type":"result","result":"done","total_cost_usd":0.12,"is_error":false}\n',
    });
    const r = await runTask({ backend: "claude", prompt: "hi", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: true, text: "done", costUsd: 0.12, exitCode: 0 });
    const c = f.calls[0];
    expect(c.cmd).toBe("claude");
    expect(c.opts.shell).toBe(false);
    expect(c.args.slice(0, 2)).toEqual(["-p", "hi"]);
    expect(c.args).toContain("--strict-mcp-config");
    expect(c.args[c.args.indexOf("--allowedTools") + 1]).toBe("mcp__tradedesk__search mcp__tradedesk__execute");
  });

  it("claude: is_error result is not ok", async () => {
    const f = fake({ stdout: '{"type":"result","result":"boom","is_error":true}\n' });
    expect((await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("codex: argv shape and last agent message", async () => {
    const f = fake({
      stdout:
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}\n',
    });
    const r = await runTask({ backend: "codex", prompt: "go", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: true, text: "final" });
    const a = f.calls[0].args;
    expect(a.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(a).toContain('mcp_servers.tradedesk.url="https://mcp.example.com/mcp"');
    expect(a).toContain('mcp_servers.tradedesk.bearer_token_env_var="MCP_TOKEN"');
    expect(a[a.length - 1]).toBe("go");
  });

  it("gemini: argv shape, settings env and response parse", async () => {
    const f = fake({ stdout: 'warn\n{"response":"hello"}' });
    const r = await runTask({ backend: "gemini", prompt: "yo", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: true, text: "hello" });
    expect(f.calls[0].args).toEqual(["-p", "yo", "--output-format", "json", "--allowed-mcp-server-names", "tradedesk"]);
    expect(f.calls[0].opts.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toMatch(/settings\.json$/);
  });

  it("timeout kills the child", async () => {
    const f = fake({ hang: true });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, timeoutMs: 20, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
    const killed = f.kill.mock.calls.length > 0 || f.calls.some((c) => c.cmd === "taskkill");
    expect(killed).toBe(true);
  });

  it("ENOENT gives install hint", async () => {
    const err: any = new Error("nope");
    err.code = "ENOENT";
    const f = fake({ error: err });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: false, error: "claude CLI not found — install and log in" });
  });

  it("non-zero exit returns stderr tail (max 20 lines)", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `e${i}`).join("\n");
    const f = fake({ stderr: lines, code: 2 });
    const r = await runTask({ backend: "codex", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.error!.split("\n")).toHaveLength(20);
    expect(r.error!.endsWith("e29")).toBe(true);
  });
});
