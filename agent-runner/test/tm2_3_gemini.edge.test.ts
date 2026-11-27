import { ApiError, GoogleGenAI, mcpToTool } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runTask } from "../src/cli.js";
import { DEFAULT_GEMINI_MODEL, runGeminiTask } from "../src/gemini.js";
import { JobsError, parseJobs } from "../src/jobs.js";

const TOKEN = "s3cr3t-gemini-edge-token-k7";
const KEY = "AIza-edge-test-key-not-real-55";
const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" };
const SIX = "backend must be claude|codex|gemini|api|api-openai|api-gemini";

let saved: Record<string, string | undefined>;
let netSpy: MockInstance;
beforeEach(() => {
  saved = { MCP_TOKEN: process.env.MCP_TOKEN, GEMINI_MODEL: process.env.GEMINI_MODEL, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
  process.env.MCP_TOKEN = TOKEN;
  process.env.GEMINI_API_KEY = KEY;
  delete process.env.GEMINI_MODEL;
  netSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("real network call attempted");
  });
});
afterEach(() => {
  // No test may reach the real network.
  expect(netSpy).not.toHaveBeenCalled();
  netSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ai = (generateContent: ReturnType<typeof vi.fn>): any => ({ models: { generateContent } });
const done = (text: string, finishReason = "STOP") => ({ text, candidates: [{ finishReason }] });
const noopTool: any = { tool: vi.fn(), callTool: vi.fn().mockResolvedValue([]) };
const conn = (tool: any = noopTool) => {
  const close = vi.fn().mockResolvedValue(undefined);
  const connectMcp = vi.fn().mockResolvedValue({ tool, close });
  return { close, connectMcp };
};
/** A fake generateContent that drives one tool call (as the SDK's automatic function calling would). */
const callingGen = (final: unknown) =>
  vi.fn().mockImplementation(async (req: any) => {
    try {
      await req.config.tools[0].callTool([{ name: "quote", args: {} }]);
    } catch {
      /* the SDK may surface or swallow; runGeminiTask must still report the tool error */
    }
    return final;
  });
const toolWith = (callTool: ReturnType<typeof vi.fn>): any => ({ tool: vi.fn(), callTool });
const errPart = (error: unknown) => [{ functionResponse: { name: "quote", response: { error } } }];

/** A fake MCP client shaped like @modelcontextprotocol/sdk Client, for the real mcpToTool. */
const fakeMcpClient = (result: unknown) => ({
  listTools: vi.fn().mockResolvedValue({ tools: [{ name: "quote", description: "q", inputSchema: { type: "object", properties: {} } }] }),
  callTool: vi.fn().mockResolvedValue(result),
});

/** connectMcp returning the real SDK mcpToTool over a fake MCP client (the real SDK calls tool() for declarations). */
const realConn = (result: unknown = { content: [] }) => {
  const close = vi.fn().mockResolvedValue(undefined);
  const connectMcp = vi.fn(async () => ({ tool: mcpToTool(fakeMcpClient(result) as any), close }));
  return { close, connectMcp };
};

/** A real GoogleGenAI client whose transport is a fake fetch: exercises SDK parsing and errors with no network. */
function sdkClient(fetchImpl: (url: string, init: any) => Promise<Response>) {
  const f = vi.fn(fetchImpl);
  const c = new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: "https://fake.invalid", fetch: f as any, retryOptions: { attempts: 1 } } });
  return { c, f };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const wire = (parts: unknown[], finishReason = "STOP", extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
  ...extra,
});

describe("request shape", () => {
  it("token is read from the env at call time (not cached)", async () => {
    const gen = vi.fn().mockResolvedValue(done("ok"));
    const { connectMcp } = conn();
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    process.env.MCP_TOKEN = "second-token";
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(connectMcp.mock.calls[0][1]).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(connectMcp.mock.calls[1][1]).toEqual({ Authorization: "Bearer second-token" });
  });

  it("token with surrounding whitespace is trimmed in the Authorization header", async () => {
    process.env.MCP_TOKEN = `  ${TOKEN}\n`;
    const { connectMcp } = conn();
    await runGeminiTask({ prompt: "p", mcp, client: ai(vi.fn().mockResolvedValue(done("x"))), connectMcp });
    expect(connectMcp.mock.calls[0][1]).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("the MCP url is passed exactly as given (path and query kept)", async () => {
    const url = "https://mcp.example.com:8443/a/b/mcp?x=1";
    const { connectMcp } = conn();
    await runGeminiTask({ prompt: "p", mcp: { ...mcp, url }, client: ai(vi.fn().mockResolvedValue(done("x"))), connectMcp });
    expect(connectMcp.mock.calls[0][0]).toBe(url);
  });

  it("the token never appears in the generateContent request", async () => {
    const gen = vi.fn().mockResolvedValue(done("x"));
    const { connectMcp } = conn();
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    const req = gen.mock.calls[0][0];
    const { abortSignal: _s, tools: _t, ...rest } = req.config;
    expect(JSON.stringify({ ...req, config: rest })).not.toContain(TOKEN);
  });

  it("model: unset GEMINI_MODEL -> default constant (non-empty)", async () => {
    const gen = vi.fn().mockResolvedValue(done("x"));
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp });
    expect(gen.mock.calls[0][0].model).toBe(DEFAULT_GEMINI_MODEL);
    expect(DEFAULT_GEMINI_MODEL.trim()).not.toBe("");
  });

  it.each([[""], ["   "], ["\t\n"]])("model: GEMINI_MODEL %j falls back to the constant (never an empty model)", async (v) => {
    process.env.GEMINI_MODEL = v;
    const gen = vi.fn().mockResolvedValue(done("x"));
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp });
    expect(gen.mock.calls[0][0].model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("model: GEMINI_MODEL wins over the constant and is trimmed", async () => {
    process.env.GEMINI_MODEL = "  gemini-env-model ";
    const gen = vi.fn().mockResolvedValue(done("x"));
    await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp });
    expect(gen.mock.calls[0][0].model).toBe("gemini-env-model");
  });

  it("real SDK: wire request carries model, prompt, api key header, MCP function declarations; no token", async () => {
    const { c, f } = sdkClient(async () => json(200, wire([{ text: "hi" }])));
    const close = vi.fn();
    const connectMcp = vi.fn(async () => ({ tool: mcpToTool(fakeMcpClient({ content: [] }) as any), close }));
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp });
    expect(r).toEqual({ ok: true, text: "hi", exitCode: null });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain(`models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect(String(url)).not.toContain(KEY);
    const headers = new Headers(init.headers);
    expect(headers.get("x-goog-api-key")).toBe(KEY);
    const body = JSON.parse(init.body);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "p" }] }]);
    expect(JSON.stringify(body.tools)).toContain("quote");
    expect(init.body).not.toContain(TOKEN);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("real SDK + real mcpToTool: automatic function calling runs the MCP tool, then returns final text", async () => {
    const mcpClient = fakeMcpClient({ content: [{ type: "text", text: "price 100" }] });
    let n = 0;
    const { c, f } = sdkClient(async () => {
      n++;
      return n === 1 ? json(200, wire([{ functionCall: { name: "quote", args: { s: "NIFTY" } } }])) : json(200, wire([{ text: "done" }]));
    });
    const connectMcp = vi.fn(async () => ({ tool: mcpToTool(mcpClient as any), close: vi.fn() }));
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp });
    expect(r).toEqual({ ok: true, text: "done", exitCode: null });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool.mock.calls[0][0]).toEqual({ name: "quote", arguments: { s: "NIFTY" } });
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(JSON.parse(f.mock.calls[1][1].body).contents)).toContain("price 100");
  });
});

describe("token / api key env refused before any call", () => {
  const cases: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["tab/newline only", "\t\n"],
  ];
  for (const [label, value] of cases) {
    it(`${label} MCP token -> ok:false, no connect, no call`, async () => {
      if (value === undefined) delete process.env.MCP_TOKEN;
      else process.env.MCP_TOKEN = value;
      const gen = vi.fn().mockResolvedValue(done("x"));
      const { connectMcp } = conn();
      const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
      expect(r).toEqual({ ok: false, text: "", error: "MCP token env MCP_TOKEN is not set", exitCode: null });
      expect(gen).not.toHaveBeenCalled();
      expect(connectMcp).not.toHaveBeenCalled();
    });
    it(`${label} GEMINI_API_KEY -> ok:false, no connect, no call`, async () => {
      if (value === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = value;
      const gen = vi.fn().mockResolvedValue(done("x"));
      const { connectMcp } = conn();
      const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
      expect(r).toEqual({ ok: false, text: "", error: "GEMINI_API_KEY is not set", exitCode: null });
      expect(gen).not.toHaveBeenCalled();
      expect(connectMcp).not.toHaveBeenCalled();
    });
  }

  it("the refusal error names the env var, never its value", async () => {
    process.env.MCP_TOKEN = "   ";
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(vi.fn()), connectMcp: conn().connectMcp });
    expect(r.error).toContain("MCP_TOKEN");
  });
});

describe("mcp spec refused before any call", () => {
  const bad: [string, Record<string, string>][] = [
    ["http url", { url: "http://mcp.example.com/mcp" }],
    ["ftp url", { url: "ftp://mcp.example.com/mcp" }],
    ["javascript url", { url: "javascript:alert(1)" }],
    ["url with double quote", { url: 'https://mcp.example.com/m"cp' }],
    ["url with single quote", { url: "https://mcp.example.com/m'cp" }],
    ["url with space", { url: "https://mcp.example.com/m cp" }],
    ["url with backslash", { url: "https://mcp.example.com\\mcp" }],
    ["uppercase scheme HTTP", { url: "HTTP://mcp.example.com/mcp" }],
    ["empty url", { url: "" }],
    ["https with no host", { url: "https://" }],
    ["file url (Windows path)", { url: "file:///C:/Users/x/mcp" }],
    ["Windows path as url", { url: "C:\\Users\\x\\mcp" }],
    ["name with __", { name: "trade__desk" }],
    ["name with space", { name: "trade desk" }],
    ["empty name", { name: "" }],
    ["name 65 chars", { name: "a".repeat(65) }],
    ["tokenEnv with space", { tokenEnv: "MCP TOKEN" }],
    ["tokenEnv empty", { tokenEnv: "" }],
    ["tokenEnv with =", { tokenEnv: "MCP=TOKEN" }],
  ];
  for (const [label, patch] of bad) {
    it(`rejects ${label}`, async () => {
      const gen = vi.fn().mockResolvedValue(done("x"));
      const { connectMcp } = conn();
      const r = await runGeminiTask({ prompt: "p", mcp: { ...mcp, ...patch }, client: ai(gen), connectMcp });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBeNull();
      expect(gen).not.toHaveBeenCalled();
      expect(connectMcp).not.toHaveBeenCalled();
    });
  }

  it("name exactly 64 chars and single _ / - accepted (boundary)", async () => {
    const gen = vi.fn().mockResolvedValue(done("x"));
    const r = await runGeminiTask({ prompt: "p", mcp: { ...mcp, name: "a_b-" + "c".repeat(60) }, client: ai(gen), connectMcp: conn().connectMcp });
    expect(r.ok).toBe(true);
  });

  it.each([["null", null], ["undefined", undefined], ["empty object", {}]])("%s mcp -> ok:false, no throw, no call", async (_l, spec) => {
    const gen = vi.fn();
    const { connectMcp } = conn();
    const r = await runGeminiTask({ prompt: "p", mcp: spec as any, client: ai(gen), connectMcp });
    expect(r.ok).toBe(false);
    expect(gen).not.toHaveBeenCalled();
    expect(connectMcp).not.toHaveBeenCalled();
  });
});

describe("prompt verbatim", () => {
  const prompts: [string, string][] = [
    ["empty", ""],
    ["unicode", "h\u00e9llo \u{1F600} \u65e5\u672c \u202Eabc \0 C:\\Users\\x \"q\" 'q'"],
    ["100KB", "\u20b9".repeat(100 * 1024)],
  ];
  for (const [label, prompt] of prompts) {
    it(`passes ${label} prompt unchanged as contents`, async () => {
      const gen = vi.fn().mockResolvedValue(done("ok"));
      await runGeminiTask({ prompt, mcp, client: ai(gen), connectMcp: conn().connectMcp });
      expect(gen.mock.calls[0][0].contents).toBe(prompt);
    });
  }

  it("real SDK: 100KB unicode prompt arrives unchanged in the wire body", async () => {
    const prompt = "\u{1F600}\u65e5" + "\u20b9".repeat(100 * 1024);
    const { c, f } = sdkClient(async () => json(200, wire([{ text: "ok" }])));
    await runGeminiTask({ prompt, mcp, client: c, connectMcp: realConn().connectMcp });
    expect(JSON.parse(f.mock.calls[0][1].body).contents[0].parts[0].text).toBe(prompt);
  });
});

describe("refusal / blocked / incomplete -> ok:false", () => {
  it("blocked prompt (promptFeedback.blockReason) -> refused, no text leaks", async () => {
    const gen = vi.fn().mockResolvedValue({ text: `partial ${TOKEN}`, promptFeedback: { blockReason: "SAFETY" } });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp });
    expect(r).toEqual({ ok: false, text: "", error: "refused", exitCode: null });
  });

  it("real SDK: blocked prompt with no candidates -> refused", async () => {
    const { c } = sdkClient(async () => json(200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }));
    expect(await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp: realConn().connectMcp })).toEqual({
      ok: false,
      text: "",
      error: "refused",
      exitCode: null,
    });
  });

  const finishes = ["SAFETY", "RECITATION", "MAX_TOKENS", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "OTHER", "FINISH_REASON_UNSPECIFIED"];
  for (const fr of finishes) {
    it(`finishReason ${fr} -> ok:false, error names it, partial text redacted`, async () => {
      const gen = vi.fn().mockResolvedValue(done(`partial ${TOKEN} ${KEY}`, fr));
      const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp });
      expect(r.ok).toBe(false);
      expect(r.error).toBe(`response ${fr.toLowerCase()}`);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(JSON.stringify(r)).not.toContain(KEY);
    });
  }

  it("real SDK: MAX_TOKENS (incomplete) -> ok:false, partial text kept but redacted", async () => {
    const { c } = sdkClient(async () => json(200, wire([{ text: `partial ${TOKEN} more` }], "MAX_TOKENS")));
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp: realConn().connectMcp });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("partial [redacted] more");
    expect(r.error).toMatch(/max_tokens/);
  });

  it("real SDK: SAFETY finish with no content -> ok:false", async () => {
    const { c } = sdkClient(async () => json(200, { candidates: [{ finishReason: "SAFETY", index: 0 }] }));
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp: realConn().connectMcp });
    expect(r).toMatchObject({ ok: false, text: "" });
  });

  it("STOP with text missing -> ok with empty text, no throw", async () => {
    const gen = vi.fn().mockResolvedValue({ candidates: [{ finishReason: "STOP" }] });
    expect(await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp })).toEqual({ ok: true, text: "", exitCode: null });
  });
});

describe("tool / MCP errors -> ok:false, redacted", () => {
  it("in-band error with several text parts -> joined, redacted", async () => {
    const callTool = vi.fn().mockResolvedValue(errPart({ isError: true, content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: `b ${TOKEN}` }] }));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done("t"))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r).toEqual({ ok: false, text: "t", error: "tool error: a\nb [redacted]", exitCode: null });
  });

  it("in-band error as a plain string -> reported", async () => {
    const callTool = vi.fn().mockResolvedValue(errPart(`order rejected: margin ${KEY}`));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done("t"))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r).toMatchObject({ ok: false, error: "tool error: order rejected: margin [redacted]" });
  });

  it("in-band error with empty content -> still ok:false, secret in JSON fallback redacted", async () => {
    const callTool = vi.fn().mockResolvedValue(errPart({ isError: true, content: [], detail: TOKEN }));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done("t"))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^tool error: /);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("isError:false result (no error key) -> ok", async () => {
    const callTool = vi.fn().mockResolvedValue([{ functionResponse: { name: "quote", response: { isError: false, content: [{ type: "text", text: "fine" }] } } }]);
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done("t"))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r).toEqual({ ok: true, text: "t", exitCode: null });
  });

  it("tool error >300 chars -> truncated to 300 after redaction", async () => {
    const raw = `${TOKEN} ` + "x".repeat(400);
    const callTool = vi.fn().mockResolvedValue(errPart(raw));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done(""))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r.error).toBe(`tool error: ${raw.split(TOKEN).join("[redacted]").slice(0, 300)}`);
    expect(r.error!.length).toBe("tool error: ".length + 300);
  });

  it("tool error exactly 300 chars -> kept whole (boundary)", async () => {
    const raw = "e".repeat(300);
    const callTool = vi.fn().mockResolvedValue(errPart(raw));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done(""))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r.error).toBe(`tool error: ${raw}`);
  });

  it("token straddling the 300-char cut -> no token fragment leaks (redact before truncate)", async () => {
    const raw = "y".repeat(295) + TOKEN + "z".repeat(50);
    const callTool = vi.fn().mockResolvedValue(errPart(raw));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done(""))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r.error).toBe(`tool error: ${"y".repeat(295)}[reda`);
  });

  it("two failing tool calls -> first error reported", async () => {
    const callTool = vi.fn().mockResolvedValueOnce(errPart("first failure")).mockResolvedValueOnce(errPart("second failure"));
    const gen = vi.fn().mockImplementation(async (req: any) => {
      await req.config.tools[0].callTool([{ name: "quote" }]);
      await req.config.tools[0].callTool([{ name: "quote" }]);
      return done("t");
    });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r).toMatchObject({ ok: false, error: "tool error: first failure" });
  });

  it("successful tool call before a failing one -> failing one reported", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce([{ functionResponse: { name: "quote", response: { content: [] } } }])
      .mockResolvedValueOnce(errPart("boom"));
    const gen = vi.fn().mockImplementation(async (req: any) => {
      await req.config.tools[0].callTool([{ name: "quote" }]);
      await req.config.tools[0].callTool([{ name: "quote" }]);
      return done("t");
    });
    expect(await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn(toolWith(callTool)).connectMcp })).toMatchObject({
      ok: false,
      error: "tool error: boom",
    });
  });

  it("tool throws and the SDK swallows it, model still finishes STOP -> ok:false tool error", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error(`transport closed ${TOKEN}`));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done("t"))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r).toEqual({ ok: false, text: "t", error: "tool error: transport closed [redacted]", exitCode: null });
  });

  it("tool throws a non-Error value -> ok:false tool error, redacted", async () => {
    const callTool = vi.fn().mockRejectedValue(`raw ${TOKEN}`);
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(callingGen(done("t"))), connectMcp: conn(toolWith(callTool)).connectMcp });
    expect(r).toMatchObject({ ok: false, error: "tool error: raw [redacted]" });
  });

  it("real SDK + real mcpToTool: MCP isError result -> ok:false tool error, redacted", async () => {
    const mcpClient = fakeMcpClient({ isError: true, content: [{ type: "text", text: `denied for ${TOKEN}` }] });
    let n = 0;
    const { c } = sdkClient(async () => {
      n++;
      return n === 1 ? json(200, wire([{ functionCall: { name: "quote", args: {} } }])) : json(200, wire([{ text: `sorry ${KEY}` }]));
    });
    const connectMcp = vi.fn(async () => ({ tool: mcpToTool(mcpClient as any), close: vi.fn() }));
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp });
    expect(r).toEqual({ ok: false, text: "sorry [redacted]", error: "tool error: denied for [redacted]", exitCode: null });
  });

  it("real SDK + real mcpToTool: MCP client callTool rejects -> ok:false tool error, redacted", async () => {
    const mcpClient = fakeMcpClient(null);
    mcpClient.callTool.mockRejectedValue(new Error(`401 Bearer ${TOKEN}`));
    const { c } = sdkClient(async () => json(200, wire([{ functionCall: { name: "quote", args: {} } }])));
    const connectMcp = vi.fn(async () => ({ tool: mcpToTool(mcpClient as any), close: vi.fn() }));
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp });
    expect(r).toMatchObject({ ok: false, error: "tool error: 401 Bearer [redacted]" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("MCP listTools fails (tool() rejects) -> ok:false, redacted", async () => {
    const tool = { tool: vi.fn().mockRejectedValue(new Error(`list failed ${TOKEN}`)), callTool: vi.fn() };
    const gen = vi.fn().mockImplementation(async (req: any) => {
      await req.config.tools[0].tool();
      return done("never");
    });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn(tool).connectMcp });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("list failed [redacted]");
  });

  it("connect fails -> ok:false redacted, generateContent never called", async () => {
    const gen = vi.fn();
    const connectMcp = vi.fn().mockRejectedValue(new Error(`connect refused Authorization: Bearer ${TOKEN}`));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp });
    expect(r).toEqual({ ok: false, text: "", error: "connect refused Authorization: Bearer [redacted]", exitCode: null });
    expect(gen).not.toHaveBeenCalled();
  });

  it("close() throwing is ignored (result unchanged)", async () => {
    const connectMcp = vi.fn().mockResolvedValue({ tool: noopTool, close: vi.fn().mockRejectedValue(new Error(`close ${TOKEN}`)) });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(vi.fn().mockResolvedValue(done("fine"))), connectMcp });
    expect(r).toEqual({ ok: true, text: "fine", exitCode: null });
  });

  it("MCP client is closed on every outcome (ok, refused, tool error, API error)", async () => {
    const outcomes = [
      vi.fn().mockResolvedValue(done("ok")),
      vi.fn().mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } }),
      callingGen(done("t")),
      vi.fn().mockRejectedValue(new Error("500")),
    ];
    for (const gen of outcomes) {
      const close = vi.fn().mockResolvedValue(undefined);
      const tool = toolWith(vi.fn().mockResolvedValue(errPart("x")));
      await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: vi.fn().mockResolvedValue({ tool, close }) });
      expect(close).toHaveBeenCalledTimes(1);
    }
  });
});

describe("API errors -> ok:false, secrets redacted", () => {
  const httpCases: [string, number][] = [
    ["429 rate limit", 429],
    ["401 unauthorized", 401],
    ["500 server error", 500],
  ];
  for (const [label, status] of httpCases) {
    it(`real SDK ${label}: token and key echoed in the body are redacted`, async () => {
      const { c } = sdkClient(async () =>
        json(status, { error: { code: status, message: `upstream said Bearer ${TOKEN} key=${KEY}`, status: "X" } }, { "x-echo": TOKEN }),
      );
      const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp: realConn().connectMcp });
      expect(r.ok).toBe(false);
      expect(r.text).toBe("");
      expect(r.exitCode).toBeNull();
      expect(r.error).toBeTruthy();
      expect(r.error).not.toBe("timeout");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(JSON.stringify(r)).not.toContain(KEY);
    });
  }

  it("real SDK network failure -> ok:false, secrets redacted", async () => {
    const { c } = sdkClient(async () => {
      throw new TypeError(`fetch failed connecting with ${TOKEN} ${KEY}`);
    });
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp: realConn().connectMcp });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  const thrown: [string, () => unknown][] = [
    ["ApiError with token in message", () => new ApiError({ message: `got ${TOKEN} ${TOKEN}`, status: 401 })],
    ["Error with key in message", () => new Error(`bad key ${KEY}`)],
    ["error with secrets in extra fields only", () => Object.assign(new Error("400 bad"), { headers: { authorization: `Bearer ${TOKEN}` }, key: KEY })],
    ["string throw", () => `raw ${TOKEN}`],
    ["object throw", () => ({ message: `obj ${TOKEN}` })],
    ["null throw", () => null],
  ];
  for (const [label, mk] of thrown) {
    it(`fake client ${label} -> ok:false, no secret`, async () => {
      const gen = vi.fn().mockRejectedValue(mk());
      const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp });
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(JSON.stringify(r)).not.toContain(KEY);
    });
  }

  it("generateContent throws synchronously -> ok:false, no throw out", async () => {
    const gen = vi.fn(() => {
      throw new Error(`sync ${TOKEN}`);
    });
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen as any), connectMcp: conn().connectMcp });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("token echoed in text -> redacted", () => {
  it("token and key echoed several times -> all redacted", async () => {
    const gen = vi.fn().mockResolvedValue(done(`${TOKEN}|Bearer ${TOKEN}|${KEY}${TOKEN}`));
    const r = await runGeminiTask({ prompt: "p", mcp, client: ai(gen), connectMcp: conn().connectMcp });
    expect(r.text).toBe("[redacted]|Bearer [redacted]|[redacted][redacted]");
  });

  it("real SDK: token across several text parts is redacted in the joined text", async () => {
    const { c } = sdkClient(async () => json(200, wire([{ text: "a " }, { text: `${TOKEN} b` }])));
    const r = await runGeminiTask({ prompt: "p", mcp, client: c, connectMcp: realConn().connectMcp });
    expect(r).toEqual({ ok: true, text: "a [redacted] b", exitCode: null });
  });
});

describe("timeout", () => {
  const hung = (p: Promise<unknown>) => Promise.race([p, new Promise((res) => setTimeout(() => res("HUNG"), 2000))]);

  it("fake client ignoring the abort signal still times out", async () => {
    const gen = vi.fn(() => new Promise(() => {}));
    const { connectMcp, close } = conn();
    const r = await hung(runGeminiTask({ prompt: "p", mcp, timeoutMs: 30, client: ai(gen as any), connectMcp }));
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
    expect(close).toHaveBeenCalled();
  });

  it("real SDK whose fetch ignores the signal still times out", async () => {
    const { c } = sdkClient(() => new Promise<Response>(() => {}));
    const r = await hung(runGeminiTask({ prompt: "p", mcp, timeoutMs: 30, client: c, connectMcp: realConn().connectMcp }));
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });

  it("MCP connect that never resolves still times out; generateContent never called", async () => {
    const gen = vi.fn();
    const connectMcp = vi.fn(() => new Promise<any>(() => {}));
    const r = await hung(runGeminiTask({ prompt: "p", mcp, timeoutMs: 30, client: ai(gen), connectMcp }));
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
    expect(gen).not.toHaveBeenCalled();
  });

  it("a hanging MCP tool call (signal-ignoring) still times out", async () => {
    const callTool = vi.fn(() => new Promise(() => {}));
    const gen = vi.fn(async (req: any) => {
      await req.config.tools[0].callTool([{ name: "quote" }]);
      return done("never");
    });
    const r = await hung(runGeminiTask({ prompt: "p", mcp, timeoutMs: 30, client: ai(gen as any), connectMcp: conn(toolWith(callTool as any)).connectMcp }));
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
  });

  it("client that honours the signal and rejects with the token -> 'timeout', no token", async () => {
    const gen = vi.fn(
      (req: any) =>
        new Promise((_res, rej) => {
          req.config.abortSignal.addEventListener("abort", () => rej(new Error(`aborted ${TOKEN}`)));
        }),
    );
    const r = await runGeminiTask({ prompt: "p", mcp, timeoutMs: 30, client: ai(gen as any), connectMcp: conn().connectMcp });
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
  });

  it("fast response under the timeout is ok (no false timeout)", async () => {
    const gen = vi.fn().mockResolvedValue(done("quick"));
    expect(await runGeminiTask({ prompt: "p", mcp, timeoutMs: 1000, client: ai(gen), connectMcp: conn().connectMcp })).toMatchObject({ ok: true, text: "quick" });
  });

  it("MCP client that connects only after the timeout is still closed (no leaked session)", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const connectMcp = vi.fn(() => new Promise<any>((res) => setTimeout(() => res({ tool: noopTool, close }), 80)));
    const r = await runGeminiTask({ prompt: "p", mcp, timeoutMs: 20, client: ai(vi.fn()), connectMcp });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
    await new Promise((res) => setTimeout(res, 150));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("runTask routing", () => {
  it("backend api-gemini -> runGeminiTask (Gemini client and connectMcp used)", async () => {
    const gen = vi.fn().mockResolvedValue(done("gemini-routed"));
    const { connectMcp } = conn();
    const r = await runTask({ backend: "api-gemini", prompt: "p", mcp, client: ai(gen), connectMcp } as any);
    expect(r).toEqual({ ok: true, text: "gemini-routed", exitCode: null });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(connectMcp).toHaveBeenCalledTimes(1);
  });

  it("backend api-gemini with bad spec -> refused, no call", async () => {
    const gen = vi.fn();
    const { connectMcp } = conn();
    const r = await runTask({ backend: "api-gemini", prompt: "p", mcp: { ...mcp, url: "http://x.example" }, client: ai(gen), connectMcp } as any);
    expect(r.ok).toBe(false);
    expect(gen).not.toHaveBeenCalled();
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it("backend api-gemini touches neither the OpenAI nor the Anthropic client, and spawns nothing", async () => {
    const gen = vi.fn().mockResolvedValue(done("g"));
    const openaiCreate = vi.fn();
    const anthropicCreate = vi.fn();
    const spawnImpl = vi.fn();
    const all = { models: { generateContent: gen }, responses: { create: openaiCreate }, beta: { messages: { create: anthropicCreate } } };
    await runTask({ backend: "api-gemini", prompt: "p", mcp, client: all, connectMcp: conn().connectMcp, spawnImpl } as any);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("backend api-openai does not touch the Gemini client", async () => {
    const gen = vi.fn();
    const openaiCreate = vi.fn().mockResolvedValue({ status: "completed", output_text: "o", output: [] });
    const both = { models: { generateContent: gen }, responses: { create: openaiCreate } };
    const r = await runTask({ backend: "api-openai", prompt: "p", mcp, client: both } as any);
    expect(r).toMatchObject({ ok: true, text: "o" });
    expect(gen).not.toHaveBeenCalled();
  });

  it("backend api does not touch the Gemini client", async () => {
    const gen = vi.fn();
    const anthropicCreate = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "a" }] });
    const both = { models: { generateContent: gen }, beta: { messages: { create: anthropicCreate } } };
    const r = await runTask({ backend: "api", prompt: "p", mcp, client: both } as any);
    expect(r).toMatchObject({ ok: true, text: "a" });
    expect(gen).not.toHaveBeenCalled();
  });
});

describe("jobs accept api-gemini", () => {
  const job = (backend: unknown, extra: Record<string, unknown> = {}) => ({
    name: "j", schedule: { days: ["Mon"], time: "09:00", tz: "UTC" }, backend, prompt: "p", mcp, outputDir: "/tmp/out", ...extra,
  });

  it("accepts api-gemini and keeps mcp + timeoutMs", () => {
    expect(parseJobs([job("api-gemini", { timeoutMs: 4321 })])[0]).toMatchObject({ backend: "api-gemini", mcp, timeoutMs: 4321 });
  });

  it.each([["API-GEMINI"], ["Api-Gemini"], [" api-gemini"], ["api-gemini "], ["api_gemini"], ["gemini-api"], ["google"], [""], [null], [5]])(
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
});
