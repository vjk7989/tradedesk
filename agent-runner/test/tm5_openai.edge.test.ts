import OpenAI from "openai";
import type { Tool } from "openai/resources/responses/responses";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runTask } from "../src/cli.js";
import { runOpenAiTask } from "../src/openai.js";

const TOKEN = "s3cr3t-openai-edge-token-q9";
const DEFAULT_MODEL = "gpt-5.5"; // DEFAULT_OPENAI_MODEL in src/openai.ts (not exported)
const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" };

let saved: Record<string, string | undefined>;
let netSpy: MockInstance;
beforeEach(() => {
  saved = { MCP_TOKEN: process.env.MCP_TOKEN, OPENAI_MODEL: process.env.OPENAI_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.MCP_TOKEN = TOKEN;
  delete process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
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

const client = (create: ReturnType<typeof vi.fn>): any => ({ responses: { create } });
const completed = (text: string, output: unknown[] = []) => ({ status: "completed", output_text: text, output });
const msg = (...content: unknown[]) => ({ type: "message", id: "m1", role: "assistant", status: "completed", content });
const outText = (text: string) => ({ type: "output_text", text, annotations: [] });

/** A real OpenAI SDK client whose transport is a fake fetch: exercises SDK parsing/errors with no network. */
function sdkClient(fetchImpl: (url: string, init: any) => Promise<Response>) {
  const f = vi.fn(fetchImpl);
  const c = new OpenAI({ apiKey: "sk-test-not-real", baseURL: "https://fake.invalid/v1", maxRetries: 0, fetch: f as any });
  return { c, f };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const apiResponse = (status: string, output: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: DEFAULT_MODEL,
  status,
  output,
  ...extra,
});

describe("request shape (typed against the SDK)", () => {
  it("mcp tool: type mcp, server_label=name, https server_url, bearer from env, require_approval never", async () => {
    const create = vi.fn().mockResolvedValue(completed("ok"));
    await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(create).toHaveBeenCalledTimes(1);
    const expected: Tool.Mcp = {
      type: "mcp",
      server_label: mcp.name,
      server_url: mcp.url,
      headers: { Authorization: `Bearer ${TOKEN}` },
      require_approval: "never",
    };
    expect(create.mock.calls[0][0].tools).toEqual([expected]);
  });

  it("token is read from the env at call time (not cached)", async () => {
    const create = vi.fn().mockResolvedValue(completed("ok"));
    await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    process.env.MCP_TOKEN = "second-token";
    await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(create.mock.calls[0][0].tools[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(create.mock.calls[1][0].tools[0].headers.Authorization).toBe("Bearer second-token");
  });

  it("wire body via the real SDK carries the same tool and model", async () => {
    const { c, f } = sdkClient(async () => json(200, apiResponse("completed", [msg(outText("hi"))])));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: c });
    expect(r).toEqual({ ok: true, text: "hi", exitCode: null });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://fake.invalid/v1/responses");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.input).toBe("p");
    expect(body.tools).toEqual([
      { type: "mcp", server_label: "tradedesk", server_url: mcp.url, headers: { Authorization: `Bearer ${TOKEN}` }, require_approval: "never" },
    ]);
  });

  it("model: unset OPENAI_MODEL -> default constant", async () => {
    const create = vi.fn().mockResolvedValue(completed("x"));
    await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(create.mock.calls[0][0].model).toBe(DEFAULT_MODEL);
  });

  it("model: OPENAI_MODEL env wins over the constant", async () => {
    process.env.OPENAI_MODEL = "gpt-env-model";
    const create = vi.fn().mockResolvedValue(completed("x"));
    await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(create.mock.calls[0][0].model).toBe("gpt-env-model");
  });

  it("model: empty OPENAI_MODEL falls back to the constant (never sends an empty model)", async () => {
    process.env.OPENAI_MODEL = "";
    const create = vi.fn().mockResolvedValue(completed("x"));
    await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(create.mock.calls[0][0].model).toBe(DEFAULT_MODEL);
  });
});

describe("token env refused before any call", () => {
  const cases: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["tab/newline only", "\t\n"],
  ];
  for (const [label, value] of cases) {
    it(`${label} token -> ok:false, no call`, async () => {
      if (value === undefined) delete process.env.MCP_TOKEN;
      else process.env.MCP_TOKEN = value;
      const create = vi.fn().mockResolvedValue(completed("x"));
      const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });
  }
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
    ["name with __", { name: "trade__desk" }],
    ["name with space", { name: "trade desk" }],
    ["empty name", { name: "" }],
    ["name 65 chars", { name: "a".repeat(65) }],
    ["tokenEnv with space", { tokenEnv: "MCP TOKEN" }],
    ["tokenEnv empty", { tokenEnv: "" }],
  ];
  for (const [label, patch] of bad) {
    it(`rejects ${label}`, async () => {
      const create = vi.fn().mockResolvedValue(completed("x"));
      const r = await runOpenAiTask({ prompt: "p", mcp: { ...mcp, ...patch }, client: client(create) });
      expect(r.ok).toBe(false);
      expect(create).not.toHaveBeenCalled();
    });
  }
  it("name exactly 64 chars and single _ / - accepted (boundary)", async () => {
    const create = vi.fn().mockResolvedValue(completed("x"));
    const r = await runOpenAiTask({ prompt: "p", mcp: { ...mcp, name: "a_b-" + "c".repeat(60) }, client: client(create) });
    expect(r.ok).toBe(true);
    expect(create.mock.calls[0][0].tools[0].server_label).toBe("a_b-" + "c".repeat(60));
  });
  it("null mcp -> ok:false, no throw, no call", async () => {
    const create = vi.fn();
    const r = await runOpenAiTask({ prompt: "p", mcp: null as any, client: client(create) });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("prompt verbatim", () => {
  const prompts: [string, string][] = [
    ["empty", ""],
    ["unicode", "h\u00e9llo \u{1F600} \u65e5\u672c \u202Eabc \0 C:\\Users\\x \"q\" 'q'"],
    ["100KB", "\u20b9".repeat(100 * 1024)],
  ];
  for (const [label, prompt] of prompts) {
    it(`passes ${label} prompt unchanged as input`, async () => {
      const create = vi.fn().mockResolvedValue(completed("ok"));
      await runOpenAiTask({ prompt, mcp, client: client(create) });
      expect(create.mock.calls[0][0].input).toBe(prompt);
    });
  }
});

describe("response parsing", () => {
  it("output_text is the returned text", async () => {
    const create = vi.fn().mockResolvedValue(completed("from output_text", [msg(outText("from output_text"))]));
    expect(await runOpenAiTask({ prompt: "p", mcp, client: client(create) })).toEqual({ ok: true, text: "from output_text", exitCode: null });
  });

  it("real SDK: output array of message parts (several messages, mcp items between) -> joined text", async () => {
    const { c } = sdkClient(async () =>
      json(
        200,
        apiResponse("completed", [
          { type: "mcp_list_tools", id: "l1", server_label: "tradedesk", tools: [] },
          msg(outText("a"), outText("b")),
          { type: "mcp_call", id: "c1", server_label: "tradedesk", name: "quote", arguments: "{}", output: "TOOLOUT" },
          msg(outText("c")),
        ]),
      ),
    );
    const r = await runOpenAiTask({ prompt: "p", mcp, client: c });
    expect(r).toEqual({ ok: true, text: "abc", exitCode: null });
  });

  it("completed with output_text missing -> ok with empty text, no throw", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output: [] });
    expect(await runOpenAiTask({ prompt: "p", mcp, client: client(create) })).toEqual({ ok: true, text: "", exitCode: null });
  });

  it("refusal content part -> ok:false refused, no text leaks", async () => {
    const create = vi.fn().mockResolvedValue(
      completed(`partial ${TOKEN}`, [msg(outText(`partial ${TOKEN}`), { type: "refusal", refusal: "I can't" })]),
    );
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r).toEqual({ ok: false, text: "", error: "refused", exitCode: null });
  });

  it("real SDK: refusal-only message -> ok:false refused", async () => {
    const { c } = sdkClient(async () => json(200, apiResponse("completed", [msg({ type: "refusal", refusal: "no" })])));
    expect(await runOpenAiTask({ prompt: "p", mcp, client: c })).toMatchObject({ ok: false, error: "refused" });
  });

  it("incomplete (max_output_tokens) -> ok:false, partial text kept but redacted", async () => {
    const { c } = sdkClient(async () =>
      json(200, apiResponse("incomplete", [msg(outText(`partial ${TOKEN} more`))], { incomplete_details: { reason: "max_output_tokens" } })),
    );
    const r = await runOpenAiTask({ prompt: "p", mcp, client: c });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("partial [redacted] more");
    expect(r.error).toMatch(/incomplete/);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  const notOk: [string, unknown][] = [
    ["failed", "failed"],
    ["in_progress", "in_progress"],
    ["cancelled", "cancelled"],
    ["null", null],
    ["missing", undefined],
  ];
  for (const [label, status] of notOk) {
    it(`status ${label} -> ok:false`, async () => {
      const create = vi.fn().mockResolvedValue({ status, output_text: "x", output: [] });
      const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    });
  }

  const mcpCall = (id: string, error: unknown, output: unknown = null) =>
    ({ type: "mcp_call", id, server_label: "tradedesk", name: "place_order", arguments: "{}", error, output });

  it("mcp_call item with error, status completed -> ok:false 'tool error: <text>', partial text kept redacted", async () => {
    const create = vi.fn().mockResolvedValue(
      completed(`done ${TOKEN}`, [mcpCall("c1", "order rejected: margin"), msg(outText(`done ${TOKEN}`))]),
    );
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r).toEqual({ ok: false, text: "done [redacted]", error: "tool error: order rejected: margin", exitCode: null });
  });

  it("mcp_call error text containing the token -> redacted", async () => {
    const create = vi.fn().mockResolvedValue(completed("done", [mcpCall("c1", `auth failed Bearer ${TOKEN} (${TOKEN})`), msg(outText("done"))]));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("tool error: auth failed Bearer [redacted] ([redacted])");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("mcp_call error >300 chars -> truncated to 300 after redaction", async () => {
    const raw = `${TOKEN} ` + "x".repeat(400);
    const create = vi.fn().mockResolvedValue(completed("", [mcpCall("c1", raw)]));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    const redacted = raw.split(TOKEN).join("[redacted]");
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`tool error: ${redacted.slice(0, 300)}`);
    expect(r.error!.length).toBe("tool error: ".length + 300);
  });

  it("mcp_call error exactly 300 chars -> kept whole (boundary)", async () => {
    const raw = "e".repeat(300);
    const create = vi.fn().mockResolvedValue(completed("", [mcpCall("c1", raw)]));
    expect((await runOpenAiTask({ prompt: "p", mcp, client: client(create) })).error).toBe(`tool error: ${raw}`);
  });

  it("token straddling the 300-char cut -> no token fragment leaks (redact before truncate)", async () => {
    const raw = "y".repeat(295) + TOKEN + "z".repeat(50);
    const create = vi.fn().mockResolvedValue(completed("", [mcpCall("c1", raw)]));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(TOKEN.slice(0, 5));
    expect(r.error).toBe(`tool error: ${"y".repeat(295)}[reda`);
  });

  it("two failing mcp_calls -> first error reported", async () => {
    const create = vi.fn().mockResolvedValue(
      completed("t", [mcpCall("c1", "first failure"), msg(outText("t")), mcpCall("c2", "second failure")]),
    );
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r).toMatchObject({ ok: false, error: "tool error: first failure" });
  });

  it("successful mcp_call (error null) before a failing one -> failing one reported", async () => {
    const create = vi.fn().mockResolvedValue(completed("t", [mcpCall("c1", null, "OK"), mcpCall("c2", "boom")]));
    expect(await runOpenAiTask({ prompt: "p", mcp, client: client(create) })).toMatchObject({ ok: false, error: "tool error: boom" });
  });

  it("mcp_call with error null -> still ok:true", async () => {
    const create = vi.fn().mockResolvedValue(completed("fine", [mcpCall("c1", null, "OK"), msg(outText("fine"))]));
    expect(await runOpenAiTask({ prompt: "p", mcp, client: client(create) })).toEqual({ ok: true, text: "fine", exitCode: null });
  });

  it("real SDK: mcp_call error in wire response -> ok:false tool error, text from messages", async () => {
    const { c } = sdkClient(async () =>
      json(200, apiResponse("completed", [mcpCall("c1", `denied ${TOKEN}`), msg(outText("partial"))])),
    );
    const r = await runOpenAiTask({ prompt: "p", mcp, client: c });
    expect(r).toEqual({ ok: false, text: "partial", error: "tool error: denied [redacted]", exitCode: null });
  });

  it("model echoes the token several times in text -> all redacted", async () => {
    const create = vi.fn().mockResolvedValue(completed(`${TOKEN}|Bearer ${TOKEN}|${TOKEN}${TOKEN}`));
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.text).toBe("[redacted]|Bearer [redacted]|[redacted][redacted]");
  });
});

describe("API errors -> ok:false, token redacted", () => {
  const httpCases: [string, number][] = [
    ["429 rate limit", 429],
    ["401 unauthorized", 401],
    ["500 server error", 500],
  ];
  for (const [label, status] of httpCases) {
    it(`real SDK ${label}: token echoed in body message and headers is redacted`, async () => {
      const { c } = sdkClient(async () =>
        json(status, { error: { message: `upstream said Bearer ${TOKEN}`, type: "x", code: TOKEN } }, { "x-echo": TOKEN }),
      );
      const r = await runOpenAiTask({ prompt: "p", mcp, client: c });
      expect(r.ok).toBe(false);
      expect(r.text).toBe("");
      expect(r.exitCode).toBeNull();
      expect(r.error).toBeTruthy();
      expect(r.error).not.toBe("timeout");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  }

  it("real SDK network failure -> ok:false, token redacted", async () => {
    const { c } = sdkClient(async () => {
      throw new TypeError(`fetch failed connecting with ${TOKEN}`);
    });
    const r = await runOpenAiTask({ prompt: "p", mcp, client: c });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  const thrown: [string, () => unknown][] = [
    ["Error with token in message", () => new Error(`boom ${TOKEN} ${TOKEN}`)],
    ["error with token in headers/body only", () => Object.assign(new Error("400 bad"), { headers: { authorization: `Bearer ${TOKEN}` }, error: { message: TOKEN } })],
    ["string throw", () => `raw ${TOKEN}`],
    ["object throw", () => ({ message: `obj ${TOKEN}` })],
    ["null throw", () => null],
  ];
  for (const [label, mk] of thrown) {
    it(`fake client ${label} -> ok:false, no token`, async () => {
      const create = vi.fn().mockRejectedValue(mk());
      const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create) });
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  }

  it("create throws synchronously -> ok:false, no throw out", async () => {
    const create = vi.fn(() => {
      throw new Error(`sync ${TOKEN}`);
    });
    const r = await runOpenAiTask({ prompt: "p", mcp, client: client(create as any) });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("timeout", () => {
  it("fake client ignoring the abort signal still times out", async () => {
    const create = vi.fn(() => new Promise(() => {}));
    const r = await Promise.race([
      runOpenAiTask({ prompt: "p", mcp, timeoutMs: 30, client: client(create as any) }),
      new Promise((res) => setTimeout(() => res("HUNG"), 2000)),
    ]);
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
  });

  it("real SDK whose fetch ignores the signal still times out", async () => {
    const { c } = sdkClient(() => new Promise<Response>(() => {}));
    const r = await Promise.race([
      runOpenAiTask({ prompt: "p", mcp, timeoutMs: 30, client: c }),
      new Promise((res) => setTimeout(() => res("HUNG"), 2000)),
    ]);
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });

  it("client that honours the signal and rejects with the token -> 'timeout', no token", async () => {
    const create = vi.fn(
      (_req: any, o: any) =>
        new Promise((_res, rej) => {
          o.signal.addEventListener("abort", () => rej(new Error(`aborted ${TOKEN}`)));
        }),
    );
    const r = await runOpenAiTask({ prompt: "p", mcp, timeoutMs: 30, client: client(create as any) });
    expect(r).toEqual({ ok: false, text: "", error: "timeout", exitCode: null });
  });

  it("fast response under the timeout is ok (no false timeout)", async () => {
    const create = vi.fn().mockResolvedValue(completed("quick"));
    expect(await runOpenAiTask({ prompt: "p", mcp, timeoutMs: 1000, client: client(create) })).toMatchObject({ ok: true, text: "quick" });
  });
});

describe("runTask routing", () => {
  it("backend api-openai -> runOpenAiTask (OpenAI client used)", async () => {
    const create = vi.fn().mockResolvedValue(completed("openai-routed"));
    const r = await runTask({ backend: "api-openai", prompt: "p", mcp, client: client(create) } as any);
    expect(r).toEqual({ ok: true, text: "openai-routed", exitCode: null });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].tools[0].type).toBe("mcp");
  });

  it("backend api-openai with bad spec -> refused, no call", async () => {
    const create = vi.fn();
    const r = await runTask({ backend: "api-openai", prompt: "p", mcp: { ...mcp, url: "http://x.example" }, client: client(create) } as any);
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("backend api still routes to Anthropic (beta.messages.create), not OpenAI", async () => {
    const anthropicCreate = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "anthropic-routed" }] });
    const openaiCreate = vi.fn().mockResolvedValue(completed("wrong"));
    const both = { beta: { messages: { create: anthropicCreate } }, responses: { create: openaiCreate } };
    const r = await runTask({ backend: "api", prompt: "p", mcp, client: both } as any);
    expect(r).toMatchObject({ ok: true, text: "anthropic-routed" });
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it("backend api-openai does not touch the Anthropic client", async () => {
    const anthropicCreate = vi.fn();
    const openaiCreate = vi.fn().mockResolvedValue(completed("o"));
    const both = { beta: { messages: { create: anthropicCreate } }, responses: { create: openaiCreate } };
    await runTask({ backend: "api-openai", prompt: "p", mcp, client: both } as any);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).toHaveBeenCalledTimes(1);
  });
});
