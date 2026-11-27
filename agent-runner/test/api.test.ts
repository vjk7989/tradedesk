import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApiTask } from "../src/api.js";

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

const msg = (stop_reason: string, text = "") => ({
  stop_reason,
  content: text ? [{ type: "thinking", thinking: "t" }, { type: "text", text }] : [{ type: "mcp_tool_use", id: "1" }],
});

function client(create: ReturnType<typeof vi.fn>): any {
  return { beta: { messages: { create } } };
}

describe("runApiTask", () => {
  it("sends the documented request shape and extracts text", async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello " }, { type: "mcp_tool_use" }, { type: "text", text: "world" }],
    });
    const r = await runApiTask({ prompt: "hi", mcp, client: client(create) });
    expect(r).toMatchObject({ ok: true, text: "hello world" });
    expect(r.costUsd).toBeUndefined();
    const req = create.mock.calls[0][0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.max_tokens).toBe(16000);
    expect(req.betas).toEqual(["mcp-client-2025-11-20", "server-side-fallback-2026-07-01"]);
    expect(req.fallbacks).toBe("default");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "high" });
    expect(req.mcp_servers).toEqual([
      { type: "url", url: mcp.url, name: "tradedesk", authorization_token: TOKEN },
    ]);
    expect(req.tools).toEqual([{ type: "mcp_toolset", mcp_server_name: "tradedesk" }]);
    expect(req.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("loops on pause_turn, appending the assistant content", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(msg("pause_turn"))
      .mockResolvedValueOnce(msg("end_turn", "done"));
    const r = await runApiTask({ prompt: "x", mcp, client: client(create) });
    expect(r).toMatchObject({ ok: true, text: "done" });
    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1][0].messages;
    expect(second).toHaveLength(2);
    expect(second[1].role).toBe("assistant");
  });

  it("caps pause_turn at 10 iterations", async () => {
    const create = vi.fn().mockResolvedValue(msg("pause_turn"));
    const r = await runApiTask({ prompt: "x", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(10);
  });

  it("refusal gives ok:false refused", async () => {
    const create = vi.fn().mockResolvedValue(msg("refusal"));
    const r = await runApiTask({ prompt: "x", mcp, client: client(create) });
    expect(r).toMatchObject({ ok: false, error: "refused" });
  });

  it("API error is returned with the token redacted", async () => {
    const err = new Anthropic.APIError(500, { message: `bad token ${TOKEN}` }, `bad token ${TOKEN}`, new Headers());
    const create = vi.fn().mockRejectedValue(err);
    const r = await runApiTask({ prompt: "x", mcp, client: client(create) });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain(TOKEN);
  });

  it("generic error is redacted too", async () => {
    const create = vi.fn().mockRejectedValue(new Error(`boom ${TOKEN} boom`));
    const r = await runApiTask({ prompt: "x", mcp, client: client(create) });
    expect(r.error).toBe("boom [redacted] boom");
  });
});
