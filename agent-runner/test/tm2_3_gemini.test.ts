import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportArgs: any[] = [];
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(...a: any[]) {
      transportArgs.push(a);
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn().mockResolvedValue({ tools: [] });
  },
}));

import { runTask } from "../src/cli.js";
import { DEFAULT_GEMINI_MODEL, runGeminiTask } from "../src/gemini.js";
import { parseJobs } from "../src/jobs.js";

const TOKEN = "s3cr3t-gemini-mcp-token";
const KEY = "AIza-test-key-value-123";
const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" };

let saved: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  saved = { MCP_TOKEN: process.env.MCP_TOKEN, GEMINI_MODEL: process.env.GEMINI_MODEL, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
  process.env.MCP_TOKEN = TOKEN;
  process.env.GEMINI_API_KEY = KEY;
  delete process.env.GEMINI_MODEL;
  transportArgs.length = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ai = (generateContent: ReturnType<typeof vi.fn>): any => ({ models: { generateContent } });
const done = (text: string) => ({ text, candidates: [{ finishReason: "STOP" }] });
const fakeTool: any = { tool: vi.fn(), callTool: vi.fn().mockResolvedValue([]) };
const factory = () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const connectMcp = vi.fn().mockResolvedValue({ tool: fakeTool, close });
  return { close, connectMcp };
};

describe("request shape", () => {
  it("wires model, prompt, MCP tool, url and bearer header; closes client", async () => {
    const gen = vi.fn().mockResolvedValue(done("hello"));
    const { close, connectMcp } = factory();
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r).toEqual({ ok: true, text: "hello", exitCode: null });
    expect(connectMcp).toHaveBeenCalledWith("https://mcp.example.com/mcp", { Authorization: `Bearer ${TOKEN}` });
    const req = gen.mock.calls[0][0];
    expect(req.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(req.contents).toBe("p");
    expect(req.config.tools).toHaveLength(1);
    expect(typeof req.config.tools[0].callTool).toBe("function");
    expect(req.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("model: option beats GEMINI_MODEL beats default; blank env uses default", async () => {
    const gen = vi.fn().mockResolvedValue(done("x"));
    const { connectMcp } = factory();
    process.env.GEMINI_MODEL = "env-model";
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    await runGeminiTask({ prompt: "p", mcp, model: "opt-model", client: ai(gen), connectMcp });
    process.env.GEMINI_MODEL = "   ";
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(gen.mock.calls.map((c) => c[0].model)).toEqual(["env-model", "opt-model", DEFAULT_GEMINI_MODEL]);
  });

  it("default MCP factory builds a Streamable HTTP transport with the Authorization header", async () => {
    const gen = vi.fn().mockResolvedValue(done("ok"));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen) });
    expect(r.ok).toBe(true);
    const [url, init] = transportArgs[0];
    expect(String(url)).toBe("https://mcp.example.com/mcp");
    expect(init).toEqual({ requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  });
});

describe("refusals before any call", () => {
  it.each([
    ["http url", { ...mcp, url: "http://mcp.example.com/mcp" }],
    ["missing token env", { ...mcp, tokenEnv: "NOPE_UNSET_ENV" }],
    ["bad name", { ...mcp, name: "bad name!" }],
  ])("%s", async (_n, spec) => {
    const gen = vi.fn();
    const { connectMcp } = factory();
    const r = await runGeminiTask({ prompt: "p", mcp: spec, client: ai(gen), connectMcp });
    expect(r.ok).toBe(false);
    expect(gen).not.toHaveBeenCalled();
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("token %j", async (v) => {
    process.env.MCP_TOKEN = v;
    const gen = vi.fn();
    const { connectMcp } = factory();
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r.ok).toBe(false);
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "  "])("GEMINI_API_KEY %j", async (v) => {
    if (v === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = v;
    const gen = vi.fn();
    const { connectMcp } = factory();
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r).toEqual({ ok: false, text: "", error: "GEMINI_API_KEY is not set", exitCode: null });
    expect(connectMcp).not.toHaveBeenCalled();
  });
});

describe("redaction, tool errors, timeout", () => {
  it("redacts token and key in thrown errors", async () => {
    const gen = vi.fn().mockRejectedValue(new Error(`401 Bearer ${TOKEN} key=${KEY}`));
    const { connectMcp, close } = factory();
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(TOKEN);
    expect(r.error).not.toContain(KEY);
    expect(r.error).toContain("[redacted]");
    expect(close).toHaveBeenCalled();
  });

  it("redacts token and key in output text", async () => {
    const gen = vi.fn().mockResolvedValue(done(`a ${TOKEN} b ${KEY} c`));
    const { connectMcp } = factory();
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r).toEqual({ ok: true, text: "a [redacted] b [redacted] c", exitCode: null });
  });

  it("redacts secrets in connect errors", async () => {
    const connectMcp = vi.fn().mockRejectedValue(new Error(`boom ${TOKEN}`));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(vi.fn()), connectMcp });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom [redacted]");
  });

  it("tool error -> ok:false 'tool error: ...' redacted", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error(`upstream failed ${TOKEN}`));
    const connectMcp = vi.fn().mockResolvedValue({ tool: { tool: vi.fn(), callTool }, close: vi.fn() });
    const gen = vi.fn().mockImplementation(async (req: any) => {
      await req.config.tools[0].callTool([{ name: "x" }]);
      return done("never");
    });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r).toEqual({ ok: false, text: "", error: "tool error: upstream failed [redacted]", exitCode: null });
  });

  it("in-band isError tool result -> ok:false 'tool error: ...' redacted", async () => {
    const callTool = vi.fn().mockResolvedValue([
      {
        functionResponse: {
          name: "x",
          response: { error: { isError: true, content: [{ type: "text", text: `denied for ${TOKEN}` }] } },
        },
      },
    ]);
    const connectMcp = vi.fn().mockResolvedValue({ tool: { tool: vi.fn(), callTool }, close: vi.fn() });
    const gen = vi.fn().mockImplementation(async (req: any) => {
      await req.config.tools[0].callTool([{ name: "x" }]);
      return done(`model says ${KEY}`);
    });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r).toEqual({ ok: false, text: "model says [redacted]", error: "tool error: denied for [redacted]", exitCode: null });
  });

  it("non-error function responses stay ok", async () => {
    const callTool = vi.fn().mockResolvedValue([{ functionResponse: { name: "x", response: { content: [{ type: "text", text: "fine" }] } } }]);
    const connectMcp = vi.fn().mockResolvedValue({ tool: { tool: vi.fn(), callTool }, close: vi.fn() });
    const gen = vi.fn().mockImplementation(async (req: any) => {
      await req.config.tools[0].callTool([{ name: "x" }]);
      return done("fine");
    });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r.ok).toBe(true);
  });

  it("times out even when the client ignores the abort signal", async () => {
    const gen = vi.fn().mockReturnValue(new Promise(() => {}));
    const { connectMcp, close } = factory();
    const r = await runGeminiTask({ prompt: "p", mcp, timeoutMs: 30, client: ai(gen), connectMcp });
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
    expect(close).toHaveBeenCalled();
  });

  it("non-STOP finish and blocked prompt are not ok", async () => {
    const { connectMcp } = factory();
    const a = await runGeminiTask({
      prompt: "p", mcp, connectMcp,
      client: ai(vi.fn().mockResolvedValue({ text: `part ${TOKEN}`, candidates: [{ finishReason: "MAX_TOKENS" }] })),
    });
    expect(a.ok).toBe(false);
    expect(a.text).toBe("part [redacted]");
    const b = await runGeminiTask({
      prompt: "p", mcp, connectMcp,
      client: ai(vi.fn().mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } })),
    });
    expect(b).toEqual({ ok: false, text: "", error: "refused", exitCode: null });
  });
});

describe("routing and jobs", () => {
  it("runTask api-gemini goes to runGeminiTask", async () => {
    delete process.env.MCP_TOKEN;
    const r = await runTask({ backend: "api-gemini", prompt: "p", mcp });
    expect(r.error).toBe("MCP token env MCP_TOKEN is not set");
  });

  it("parseJobs accepts api-gemini", () => {
    const job = {
      name: "j", schedule: { days: ["Mon"], time: "09:00", tz: "UTC" }, backend: "api-gemini",
      prompt: "p", mcp, outputDir: "/tmp/out",
    };
    expect(parseJobs([job])[0].backend).toBe("api-gemini");
  });
});
