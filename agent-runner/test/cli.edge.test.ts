import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTask } from "../src/cli.js";

type Chunk = { out?: string | Buffer; err?: string };
type Script = {
  chunks?: Chunk[];
  code?: number | null;
  error?: NodeJS.ErrnoException;
  errorAfterClose?: boolean;
  hang?: boolean;
};

const TOKEN = "s3cr3t-T0KEN-value-xyz";

function fake(script: Script) {
  const calls: { cmd: string; args: string[]; opts: any; files: Record<string, string> }[] = [];
  const kill = vi.fn(); // child ignores kill: never emits close afterwards
  const impl: any = (cmd: string, args: string[], opts: any) => {
    const files: Record<string, string> = {};
    const cfg = args.indexOf("--mcp-config");
    if (cfg >= 0 && existsSync(args[cfg + 1])) files[args[cfg + 1]] = readFileSync(args[cfg + 1], "utf8");
    const gs = opts?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    if (gs && existsSync(gs)) files[gs] = readFileSync(gs, "utf8");
    calls.push({ cmd, args, opts, files });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4321;
    child.kill = kill;
    if (cmd !== "taskkill") {
      setImmediate(() => {
        if (script.error && !script.errorAfterClose) return child.emit("error", script.error);
        if (script.hang) return;
        for (const c of script.chunks ?? []) {
          if (c.out !== undefined) child.stdout.emit("data", Buffer.isBuffer(c.out) ? c.out : Buffer.from(c.out));
          if (c.err !== undefined) child.stderr.emit("data", Buffer.from(c.err));
        }
        child.emit("close", script.code === undefined ? 0 : script.code);
        if (script.error && script.errorAfterClose) child.emit("error", script.error);
      });
    }
    return child;
  };
  return { impl, calls, kill };
}

const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" };
const okClaude = '{"type":"result","result":"done","total_cost_usd":0.5,"is_error":false}\n';
const enoent = () => Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
const backends = ["claude", "codex", "gemini"] as const;

function tempDirOf(call: { args: string[]; opts: any }): string | undefined {
  const i = call.args.indexOf("--mcp-config");
  if (i >= 0) return dirname(call.args[i + 1]);
  const g = call.opts?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  return g ? dirname(g) : undefined;
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MCP_TOKEN;
  process.env.MCP_TOKEN = TOKEN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_TOKEN;
  else process.env.MCP_TOKEN = saved;
});

const nasty: [string, string][] = [
  ["quotes", `he said "hi" and 'bye' \\" end`],
  ["newlines", "line1\nline2\r\nline3"],
  ["command substitution", "$(rm -rf /) `rm -rf ~` ; rm -rf / && echo pwned | cat"],
  ["flag text", "please --dangerously-skip-permissions --allowedTools Bash"],
  ["unicode", "héllo 世界 🚀 \u202e rtl"],
];

describe("prompt is a single, verbatim argv element", () => {
  for (const backend of backends) {
    for (const [label, prompt] of nasty) {
      it(`${backend}: ${label}`, async () => {
        const f = fake({ chunks: [{ out: okClaude }] });
        await runTask({ backend, prompt, mcp, spawnImpl: f.impl });
        const c = f.calls[0];
        expect(c.opts.shell).toBe(false);
        expect(c.args.filter((a) => a === prompt)).toHaveLength(1);
        expect(c.args).not.toContain("--dangerously-skip-permissions");
      });
    }

    it(`${backend}: very long prompt (100KB) passed intact`, async () => {
      const prompt = "x".repeat(100 * 1024);
      const f = fake({ chunks: [{ out: okClaude }] });
      await runTask({ backend, prompt, mcp, spawnImpl: f.impl });
      expect(f.calls[0].args).toContain(prompt);
    });
  }

  it("claude: leading '-' prompt sits directly after -p", async () => {
    const f = fake({ chunks: [{ out: okClaude }] });
    await runTask({ backend: "claude", prompt: "--help", mcp, spawnImpl: f.impl });
    const a = f.calls[0].args;
    expect(a[a.indexOf("-p") + 1]).toBe("--help");
  });

  it("gemini: leading '-' prompt sits directly after -p", async () => {
    const f = fake({ chunks: [{ out: '{"response":"r"}' }] });
    await runTask({ backend: "gemini", prompt: "-v", mcp, spawnImpl: f.impl });
    const a = f.calls[0].args;
    expect(a[a.indexOf("-p") + 1]).toBe("-v");
  });

  it("codex: leading '-' positional prompt is preceded by '--'", async () => {
    const f = fake({ chunks: [] });
    await runTask({ backend: "codex", prompt: "--version", mcp, spawnImpl: f.impl });
    const a = f.calls[0].args;
    const i = a.indexOf("--version");
    expect(i).toBeGreaterThan(0);
    expect(a[i - 1]).toBe("--");
  });
});

describe("mcp spec validation", () => {
  const bad: [string, Partial<typeof mcp>][] = [
    ["name with space", { name: "trade desk" }],
    ["name with dot", { name: "trade.desk" }],
    ["name with quote", { name: 'trade"desk' }],
    ["name with __", { name: "trade__desk" }],
    ["empty name", { name: "" }],
    ["url with double quote", { url: 'https://x.com/"a' }],
    ["url with single quote", { url: "https://x.com/'a" }],
    ["url non-http scheme (file)", { url: "file:///etc/passwd" }],
    ["url javascript scheme", { url: "javascript:alert(1)" }],
    ["empty url", { url: "" }],
    ["tokenEnv with =", { tokenEnv: "MCP_TOKEN=abc" }],
    ["tokenEnv with space", { tokenEnv: "MCP TOKEN" }],
    ["empty tokenEnv", { tokenEnv: "" }],
  ];
  for (const backend of backends) {
    for (const [label, patch] of bad) {
      it(`${backend}: rejects ${label} without spawning`, async () => {
        const f = fake({ chunks: [{ out: okClaude }] });
        const r = await runTask({ backend, prompt: "x", mcp: { ...mcp, ...patch }, spawnImpl: f.impl });
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
        expect(f.calls).toHaveLength(0);
      });
    }
  }

  it("boundary: 64-char name accepted, 65 rejected", async () => {
    const f = fake({ chunks: [{ out: okClaude }] });
    const r1 = await runTask({ backend: "claude", prompt: "x", mcp: { ...mcp, name: "a".repeat(64) }, spawnImpl: f.impl });
    expect(r1.ok).toBe(true);
    const g = fake({ chunks: [{ out: okClaude }] });
    const r2 = await runTask({ backend: "claude", prompt: "x", mcp: { ...mcp, name: "a".repeat(65) }, spawnImpl: g.impl });
    expect(r2.ok).toBe(false);
    expect(g.calls).toHaveLength(0);
  });

  it("accepts http:// url", async () => {
    const f = fake({ chunks: [{ out: okClaude }] });
    const r = await runTask({ backend: "claude", prompt: "x", mcp: { ...mcp, url: "http://localhost:8080/mcp" }, spawnImpl: f.impl });
    expect(r.ok).toBe(true);
  });
});

describe("token value never leaks", () => {
  for (const backend of backends) {
    it(`${backend}: not in argv, temp files, extra env, or result`, async () => {
      const f = fake({ chunks: [{ err: "auth failed\n" }], code: 1 });
      const r = await runTask({ backend, prompt: "x", mcp, spawnImpl: f.impl });
      const c = f.calls[0];
      for (const a of c.args) expect(a).not.toContain(TOKEN);
      for (const body of Object.values(c.files)) {
        expect(body).not.toContain(TOKEN);
        expect(body).toContain("MCP_TOKEN");
      }
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      for (const [k, v] of Object.entries(c.opts.env ?? {})) {
        if (k !== "MCP_TOKEN") expect(String(v)).not.toContain(TOKEN);
      }
    });
  }
});

describe("claude allowedTools", () => {
  it("contains only the two MCP tools, no built-ins", async () => {
    const f = fake({ chunks: [{ out: okClaude }] });
    await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    const a = f.calls[0].args;
    const tools = a[a.indexOf("--allowedTools") + 1].split(/[ ,]+/).filter(Boolean);
    expect(tools.sort()).toEqual(["mcp__tradedesk__execute", "mcp__tradedesk__search"]);
    for (const b of ["Bash", "Edit", "Write", "Read", "WebFetch"]) expect(a.join(" ")).not.toMatch(new RegExp(`\\b${b}\\b`));
    expect(a).toContain("--strict-mcp-config");
    expect(a).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose"]));
  });
});

describe("stdout parsing", () => {
  it("claude: exit 0 but no result line -> ok:false", async () => {
    const f = fake({ chunks: [{ out: '{"type":"system"}\n{"type":"assistant"}\n' }] });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: false, exitCode: 0 });
    expect(r.error).toBeTruthy();
  });

  it("claude: empty stdout -> ok:false", async () => {
    const f = fake({ chunks: [] });
    expect((await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("claude: is_error:true -> ok:false", async () => {
    const f = fake({ chunks: [{ out: '{"type":"result","result":"bad","total_cost_usd":0.1,"is_error":true}\n' }] });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("claude: malformed JSON lines interleaved are skipped", async () => {
    const f = fake({ chunks: [{ out: '{"type":"system"\nnot json\n{broken\n' + okClaude + "{trailing garbage\n" }] });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: true, text: "done", costUsd: 0.5 });
  });

  it("claude: result line split across chunks, incl. mid UTF-8 sequence", async () => {
    const buf = Buffer.from('{"type":"result","result":"héllo 世界","total_cost_usd":0.2,"is_error":false}\n');
    const idx = buf.indexOf(Buffer.from("世")) + 1;
    const f = fake({ chunks: [{ out: buf.subarray(0, 10) }, { out: buf.subarray(10, idx) }, { out: buf.subarray(idx) }] });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: true, text: "héllo 世界", costUsd: 0.2 });
  });

  it("claude: huge stdout (~20MB) before result still parses", async () => {
    const noise = '{"type":"assistant","message":"' + "y".repeat(1000) + '"}\n';
    const chunks: Chunk[] = Array.from({ length: 20000 }, () => ({ out: noise }));
    chunks.push({ out: okClaude });
    const f = fake({ chunks });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: true, text: "done" });
  }, 30000);

  it("claude: last result line wins", async () => {
    const f = fake({ chunks: [{ out: '{"type":"result","result":"a","is_error":true}\n' + okClaude }] });
    expect(await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl })).toMatchObject({ ok: true, text: "done" });
  });

  it("codex: multiple agent messages -> last one", async () => {
    const m = (t: string) => `{"type":"item.completed","item":{"type":"agent_message","text":"${t}"}}\n`;
    const f = fake({
      chunks: [{ out: m("one") + '{"type":"item.completed","item":{"type":"reasoning","text":"think"}}\n' + m("two") }, { out: m("three") }],
    });
    expect(await runTask({ backend: "codex", prompt: "x", mcp, spawnImpl: f.impl })).toMatchObject({ ok: true, text: "three" });
  });

  it("codex: no agent message -> ok:false", async () => {
    const f = fake({ chunks: [{ out: '{"type":"thread.started"}\n' }] });
    expect((await runTask({ backend: "codex", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("codex: turn.failed -> ok:false", async () => {
    const f = fake({ chunks: [{ out: '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.failed"}\n' }] });
    expect((await runTask({ backend: "codex", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("codex: -c overrides for url and bearer_token_env_var", async () => {
    const f = fake({ chunks: [] });
    await runTask({ backend: "codex", prompt: "x", mcp, spawnImpl: f.impl });
    const a = f.calls[0].args;
    expect(a.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(a.filter((x) => x === "-c")).toHaveLength(2);
    expect(a.some((x) => x.startsWith("mcp_servers.tradedesk.url="))).toBe(true);
    expect(a.some((x) => x.startsWith("mcp_servers.tradedesk.bearer_token_env_var="))).toBe(true);
  });

  it("gemini: response missing -> ok:false", async () => {
    const f = fake({ chunks: [{ out: '{"stats":{}}' }] });
    expect((await runTask({ backend: "gemini", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("gemini: non-JSON stdout -> ok:false", async () => {
    const f = fake({ chunks: [{ out: "just text" }] });
    expect((await runTask({ backend: "gemini", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("gemini: error object -> ok:false", async () => {
    const f = fake({ chunks: [{ out: '{"error":{"message":"nope"}}' }] });
    expect((await runTask({ backend: "gemini", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("gemini: settings file holds server url under its name", async () => {
    const f = fake({ chunks: [{ out: '{"response":"ok"}' }] });
    await runTask({ backend: "gemini", prompt: "x", mcp, spawnImpl: f.impl });
    const cfg = JSON.parse(Object.values(f.calls[0].files)[0]);
    expect(JSON.stringify(cfg.mcpServers.tradedesk)).toContain("https://mcp.example.com/mcp");
  });
});

describe("exit / error handling", () => {
  it("non-zero exit: stderr tail is at most 20 lines (the last ones)", async () => {
    const err = Array.from({ length: 50 }, (_, i) => `err line ${i}`).join("\n") + "\n";
    const f = fake({ chunks: [{ err }], code: 2 });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
    const lines = r.error!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines[lines.length - 1]).toBe("err line 49");
    expect(lines).not.toContain("err line 29");
  });

  it("non-zero exit with exactly 20 stderr lines keeps all", async () => {
    const f = fake({ chunks: [{ err: Array.from({ length: 20 }, (_, i) => `e${i}`).join("\n") }], code: 1 });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r.error!.split("\n")).toHaveLength(20);
  });

  it("non-zero exit with empty stderr still has an error", async () => {
    const f = fake({ chunks: [], code: 3 });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
    expect(r.error).toBeTruthy();
  });

  it("non-zero exit even with a good result line -> ok:false", async () => {
    const f = fake({ chunks: [{ out: okClaude }], code: 1 });
    expect((await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  it("null exit code (killed by signal) -> ok:false", async () => {
    const f = fake({ chunks: [{ out: okClaude }], code: null });
    expect((await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl })).ok).toBe(false);
  });

  for (const backend of backends) {
    it(`${backend}: ENOENT -> install hint`, async () => {
      const f = fake({ error: enoent() });
      const r = await runTask({ backend, prompt: "x", mcp, spawnImpl: f.impl });
      expect(r).toEqual({ ok: false, text: "", error: `${backend} CLI not found — install and log in`, exitCode: null });
    });
  }

  it("synchronous throw from spawnImpl is returned as ok:false, not thrown", async () => {
    const impl: any = () => {
      throw enoent();
    };
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: impl });
    expect(r.ok).toBe(false);
  });

  it("'error' emitted after close: first outcome wins", async () => {
    const f = fake({ chunks: [{ out: okClaude }], error: enoent(), errorAfterClose: true });
    const r = await runTask({ backend: "claude", prompt: "x", mcp, spawnImpl: f.impl });
    expect(r).toMatchObject({ ok: true, text: "done" });
  });

  it("timeout while child ignores kill: resolves once with timeout", async () => {
    const f = fake({ hang: true });
    const t0 = Date.now();
    const r = await runTask({ backend: "claude", prompt: "x", mcp, timeoutMs: 30, spawnImpl: f.impl });
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(f.kill.mock.calls.length > 0 || f.calls.some((c) => c.cmd === "taskkill")).toBe(true);
  });

  it("kill helper also spawns without a shell", async () => {
    const f = fake({ hang: true });
    await runTask({ backend: "claude", prompt: "x", mcp, timeoutMs: 10, spawnImpl: f.impl });
    for (const c of f.calls) expect(c.opts.shell).toBe(false);
  });

  it("passes a Windows cwd with spaces through unchanged", async () => {
    const f = fake({ chunks: [{ out: okClaude }] });
    await runTask({ backend: "claude", prompt: "x", mcp, cwd: "C:\\Work Dir\\proj", spawnImpl: f.impl });
    expect(f.calls[0].opts.cwd).toBe("C:\\Work Dir\\proj");
  });
});

describe("temp dir cleanup", () => {
  const cases: [string, Script, number?][] = [
    ["success", { chunks: [{ out: okClaude }] }],
    ["failure exit", { chunks: [{ err: "x" }], code: 1 }],
    ["timeout", { hang: true }, 20],
    ["ENOENT", { error: enoent() }],
  ];
  for (const backend of ["claude", "gemini"] as const) {
    for (const [label, script, timeoutMs] of cases) {
      it(`${backend}: removed after ${label}`, async () => {
        const f = fake(script);
        await runTask({ backend, prompt: "x", mcp, timeoutMs, spawnImpl: f.impl });
        const main = f.calls.find((c) => c.cmd === backend)!;
        const dir = tempDirOf(main)!;
        expect(dir).toBeTruthy();
        expect(Object.keys(main.files)).toHaveLength(1);
        expect(existsSync(dir)).toBe(false);
      });
    }
  }
});
