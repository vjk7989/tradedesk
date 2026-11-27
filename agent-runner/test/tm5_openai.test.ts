import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTask } from "../src/cli.js";
import { runOpenAiTask } from "../src/openai.js";

const TOKEN = "s3cr3t-openai-token-xyz";
const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" };

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { MCP_TOKEN: process.env.MCP_TOKEN, OPENAI_MODEL: process.env.OPENAI_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.MCP_TOKEN = TOKEN;
  delete process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "sk-test";
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const client = (create: ReturnType<typeof vi.fn>): any => ({ responses: { create } });
const done = (text: string) => ({ status: "completed", output_text: text, output: [] });

describe("runOpenAiTask request shape", () => {
  it("sends the mcp tool with bearer header, never-approval and default model", async () => {
    const create = vi.fn().mockResolvedValue(done("hello"));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r).toEqual({ ok: true, text: "hello", exitCode: null });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe("gpt-5.5");
    expect(body.input).toBe("p");
    expect(body.tools).toEqual([
      {
        type: "mcp",
        server_label: "tradedesk",
        server_url: "https://mcp.example.com/mcp",
        headers: { Authorization: `Bearer ${TOKEN}` },
        require_approval: "never",
      },
    ]);
    expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("model: option beats OPENAI_MODEL beats default", async () => {
    const create = vi.fn().mockResolvedValue(done("x"));
    process.env.OPENAI_MODEL = "env-model";
    await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    await runOpenAiTask({ prompt: "p", mcp, model: "opt-model", client: client(create) });
    expect(create.mock.calls[0][0].model).toBe("env-model");
    expect(create.mock.calls[1][0].model).toBe("opt-model");
  });
});

describe("runOpenAiTask refusals before any call", () => {
  it.each([
    ["missing token env", { ...mcp, tokenEnv: "NOPE_UNSET_ENV" }],
    ["http url", { ...mcp, url: "http://mcp.example.com/mcp" }],
    ["bad name", { ...mcp, name: "bad name!" }],
  ])("%s", async (_n, spec) => {
    const create = vi.fn().mockResolvedValue(done("x"));
    const r = await runOpenAiTask({ prompt: "p", mcp: spec, client: client(create) });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("empty token env", async () => {
    process.env.MCP_TOKEN = "";
    const create = vi.fn();
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("runOpenAiTask redaction, status, timeout", () => {
  it("redacts the token in errors", async () => {
    const create = vi.fn().mockRejectedValue(new Error(`401 bad Bearer ${TOKEN}`));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(TOKEN);
    expect(r.error).toContain("[redacted]");
  });

  it("redacts the token in returned text", async () => {
    const create = vi.fn().mockResolvedValue(done(`leak ${TOKEN} end`));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("leak [redacted] end");
  });

  it("incomplete status is not ok", async () => {
    const create = vi.fn().mockResolvedValue({ status: "incomplete", output_text: `part ${TOKEN}`, output: [] });
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("part [redacted]");
  });

  it("refusal is not ok", async () => {
    const create = vi.fn().mockResolvedValue({
      status: "completed",
      output_text: "",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
    });
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r).toEqual({ ok: false, text: "", error: "refused", exitCode: null });
  });

  it("times out even when the client ignores the abort signal", async () => {
    const create = vi.fn().mockReturnValue(new Promise(() => {}));
    const r = await runOpenAiTask({ prompt: "p", mcp, timeoutMs: 30, client: client(create) });
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
  });
});

describe("runTask routing", () => {
  it("api-openai goes to runOpenAiTask", async () => {
    delete process.env.MCP_TOKEN;
    const r = await runTask({ backend: "api-openai", prompt: "p", mcp });
    expect(r.error).toBe("MCP token env MCP_TOKEN is not set");
  });
});
