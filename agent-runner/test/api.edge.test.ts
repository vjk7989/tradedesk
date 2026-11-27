import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApiTask } from "../src/api.js";
import { runTask } from "../src/cli.js";

const TOKEN = "s3cr3t-api-token-xyz";
const mcp = { name: "tradedesk", url: "https://mcp.example.com/mcp", tokenEnv: "MCP_TOKEN" };

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MCP_TOKEN;
  process.env.MCP_TOKEN = TOKEN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_TOKEN;
  else process.env.MCP_TOKEN = saved;
});

function client(create: ReturnType<typeof vi.fn>): any {
  return { beta: { messages: { create } } };
}
const end = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const pause = (id: number) => ({ stop_reason: "pause_turn", content: [{ type: "mcp_tool_use", id: `t${id}` }] });

describe("runApiTask token env", () => {
  it("unset tokenEnv: refuses without calling the API", async () => {
    delete process.env.MCP_TOKEN;
    const create = vi.fn().mockResolvedValue(end("x"));
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
  it("empty tokenEnv: refuses without calling the API", async () => {
    process.env.MCP_TOKEN = "";
    const create = vi.fn().mockResolvedValue(end("x"));
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("runApiTask spec validation (as cli)", () => {
  const bad: [string, unknown][] = [
    ["http url", { ...mcp, url: "http://mcp.example.com/mcp" }],
    ["non-url", { ...mcp, url: "not a url" }],
    ["file url", { ...mcp, url: "file:///C:/x" }],
    ["__ in name", { ...mcp, name: "trade__desk" }],
    ["empty name", { ...mcp, name: "" }],
  ];
  for (const [label, spec] of bad) {
    it(`rejects ${label} with no API call`, async () => {
      const create = vi.fn().mockResolvedValue(end("x"));
      const r = await runApiTask({ prompt: "p", mcp: spec as any, client: client(create) });
      expect(r.ok).toBe(false);
      expect(create).not.toHaveBeenCalled();
    });
  }
  it("rejects via runTask api backend too", async () => {
    const create = vi.fn().mockResolvedValue(end("x"));
    const r = await runTask({ backend: "api", prompt: "p", mcp: { ...mcp, name: "a__b" }, client: client(create) } as any);
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("runTask api backend", () => {
  it("routes to runApiTask and returns {ok,text,exitCode}", async () => {
    const create = vi.fn().mockResolvedValue(end("routed"));
    const r = await runTask({ backend: "api", prompt: "p", mcp, client: client(create) } as any);
    expect(r).toMatchObject({ ok: true, text: "routed", exitCode: null });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("runApiTask prompts verbatim", () => {
  const prompts: [string, string][] = [
    ["empty", ""],
    ["huge", "a".repeat(1_000_000)],
    ["unicode", "h\u00e9llo \u{1F600} \u65e5\u672c \u202Eabc \0 C:\\Users\\x"],
  ];
  for (const [label, prompt] of prompts) {
    it(`passes ${label} prompt unchanged`, async () => {
      const create = vi.fn().mockResolvedValue(end("ok"));
      await runApiTask({ prompt, mcp, client: client(create) });
      expect(create.mock.calls[0][0].messages[0]).toEqual({ role: "user", content: prompt });
    });
  }
});

describe("runApiTask pause_turn loop", () => {
  it("9 pauses then end_turn (10 calls) succeeds", async () => {
    const create = vi.fn();
    for (let i = 0; i < 9; i++) create.mockResolvedValueOnce(pause(i));
    create.mockResolvedValueOnce(end("fin"));
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r).toMatchObject({ ok: true, text: "fin" });
    expect(create).toHaveBeenCalledTimes(10);
  });
  it("10+ pauses stops at 10 calls with ok:false", async () => {
    const create = vi.fn();
    for (let i = 0; i < 11; i++) create.mockResolvedValueOnce(pause(i));
    create.mockResolvedValue(end("never"));
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/paused/);
    expect(create).toHaveBeenCalledTimes(10);
  });
  it("messages grow append-only: user, assistant, assistant", async () => {
    const snapshots: any[] = [];
    const create = vi.fn(async (req: any) => {
      snapshots.push(structuredClone(req.messages));
      return snapshots.length < 3 ? pause(snapshots.length) : end("z");
    });
    await runApiTask({ prompt: "p", mcp, client: client(create as any) });
    expect(snapshots.map((m) => m.map((x: any) => x.role))).toEqual([
      ["user"],
      ["user", "assistant"],
      ["user", "assistant", "assistant"],
    ]);
    expect(snapshots[2][0]).toEqual({ role: "user", content: "p" });
    expect(snapshots[2][1].content).toEqual(pause(1).content);
    expect(snapshots[2][2].content).toEqual(pause(2).content);
  });
});

describe("runApiTask content and stop reasons", () => {
  it("mixed blocks: only text concatenated", async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "secret thoughts" },
        { type: "text", text: "a" },
        { type: "mcp_tool_use", id: "1", name: "search", input: {} },
        { type: "mcp_tool_result", tool_use_id: "1", content: [{ type: "text", text: "TOOLRESULT" }] },
        { type: "text", text: "b" },
      ],
    });
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r).toMatchObject({ ok: true, text: "ab" });
  });
  it("no text blocks: empty text (documents behaviour)", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "t" }] });
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.text).toBe("");
  });
  it("refusal -> ok:false refused", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "refusal", content: [{ type: "text", text: "no" }] });
    expect(await runApiTask({ prompt: "p", mcp, client: client(create) })).toMatchObject({ ok: false, error: "refused" });
  });
  it("max_tokens -> not reported as clean success", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "max_tokens", content: [{ type: "text", text: "trunc" }] });
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.ok === false || r.error !== undefined).toBe(true);
  });
  it("stop_reason null -> does not throw", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: null, content: [{ type: "text", text: "x" }] });
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(typeof r.ok).toBe("boolean");
  });
  it("model echoes token in text -> redacted", async () => {
    const create = vi.fn().mockResolvedValue(end(`your token is ${TOKEN}`));
    const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
    expect(r.text).not.toContain(TOKEN);
  });
});

describe("runApiTask error redaction", () => {
  const cases: [string, () => unknown][] = [
    ["429 rate limit", () => Object.assign(new Error(`429 rate limited ${TOKEN}`), { status: 429, headers: { authorization: TOKEN } })],
    ["500 api error", () => Object.assign(new Error(`500 ${TOKEN} and ${TOKEN}`), { status: 500, error: { detail: TOKEN } })],
    ["generic Error", () => new Error(`boom ${TOKEN}${TOKEN}`)],
    ["string throw", () => `raw ${TOKEN} raw ${TOKEN}`],
    ["object throw", () => ({ message: `obj ${TOKEN}` })],
  ];
  for (const [label, mk] of cases) {
    it(`${label} -> ok:false, token redacted everywhere`, async () => {
      const create = vi.fn().mockRejectedValue(mk());
      const r = await runApiTask({ prompt: "p", mcp, client: client(create) });
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  }
  it("nested body only (message without token) does not leak", async () => {
    const e = Object.assign(new Error("400 bad request"), { error: { error: { message: `bad ${TOKEN}` } } });
    const r = await runApiTask({ prompt: "p", mcp, client: client(vi.fn().mockRejectedValue(e)) });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("runApiTask timeout and signal", () => {
  it("never-resolving create honouring signal with small timeoutMs -> timeout", async () => {
    const create = vi.fn(
      (_req: any, o: any) =>
        new Promise((_res, rej) => {
          o.signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const r = await runApiTask({ prompt: "p", mcp, timeoutMs: 30, client: client(create as any) });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });
  it("create ignoring the signal still times out", async () => {
    const create = vi.fn(() => new Promise(() => {}));
    const r = await Promise.race([
      runApiTask({ prompt: "p", mcp, timeoutMs: 30, client: client(create as any) }),
      new Promise((res) => setTimeout(() => res("HUNG"), 1000)),
    ]);
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });
  it("same AbortSignal passed on every call", async () => {
    const create = vi.fn().mockResolvedValueOnce(pause(0)).mockResolvedValueOnce(pause(1)).mockResolvedValueOnce(end("x"));
    await runApiTask({ prompt: "p", mcp, client: client(create) });
    const sigs = create.mock.calls.map((c) => c[1]?.signal);
    expect(sigs.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(new Set(sigs).size).toBe(1);
  });
});
