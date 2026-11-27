import { GoogleGenAI, mcpToTool, type CallableTool } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { validMcpSpec } from "./cli.js";
import type { McpSpec, RunResult } from "./types.js";

/** Model used when GEMINI_MODEL is unset: the stable (non-preview) general Flash model listed at https://ai.google.dev/gemini-api/docs/models (aistudio.google.com/docs/models). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** A connected MCP client wrapped as a Gemini callable tool. */
export interface GeminiMcpHandle {
  tool: CallableTool;
  close(): Promise<void>;
}

export interface GeminiOptions {
  prompt: string;
  mcp: McpSpec;
  timeoutMs?: number;
  model?: string;
  /** Injected in tests; defaults to `new GoogleGenAI({ apiKey })`. */
  client?: Pick<GoogleGenAI, "models">;
  /** Injected in tests; defaults to an MCP Streamable HTTP client with the Authorization header. */
  connectMcp?: (url: string, headers: Record<string, string>) => Promise<GeminiMcpHandle>;
}

/** Text of an in-band tool error. mcpToTool maps isError results to `response: { error: <CallToolResult> }`. */
function errorDetail(err: unknown): string {
  if (typeof err === "string") return err;
  const e = err as { content?: unknown; message?: unknown } | null;
  if (Array.isArray(e?.content)) {
    const texts = e.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  if (typeof e?.message === "string") return e.message;
  return JSON.stringify(err) ?? String(err);
}

function redact(msg: string, ...secrets: (string | undefined)[]): string {
  return secrets.reduce<string>((m, s) => (s ? m.split(s).join("[redacted]") : m), msg);
}

/** Rejects when the signal aborts, so a client that ignores the signal still times out. */
function raceAbort<T>(signal: AbortSignal, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    p.then(resolve, reject);
  });
}

async function defaultConnectMcp(url: string, headers: Record<string, string>): Promise<GeminiMcpHandle> {
  const mcpClient = new Client({ name: "agent-runner", version: "0.1.0" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return { tool: mcpToTool(mcpClient), close: () => mcpClient.close() };
}

/**
 * Runs one task on the Gemini API with a remote MCP tool. The MCP client runs in this process
 * (the SDK has no server-side remote MCP in generateContent); automatic function calling drives the tool loop.
 */
export async function runGeminiTask(opts: GeminiOptions): Promise<RunResult> {
  const { mcp, prompt } = opts;
  if (!validMcpSpec(mcp) || !mcp.url.startsWith("https://")) {
    return { ok: false, text: "", error: "invalid mcp name, url or tokenEnv (public https url required)", exitCode: null };
  }
  const token = process.env[mcp.tokenEnv]?.trim();
  if (!token) {
    return { ok: false, text: "", error: `MCP token env ${mcp.tokenEnv} is not set`, exitCode: null };
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, text: "", error: "GEMINI_API_KEY is not set", exitCode: null };
  }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 600000);
  let handle: GeminiMcpHandle | undefined;
  let toolError: string | undefined;
  try {
    const connect = opts.connectMcp ?? defaultConnectMcp;
    const connecting = connect(mcp.url, { Authorization: `Bearer ${token}` });
    try {
      handle = await raceAbort(signal, connecting);
    } catch (e) {
      // Lost the race (timeout/abort): a client that connects late must still be closed.
      connecting.then((h) => h.close()).catch(() => {});
      throw e;
    }
    const inner = handle.tool;
    const tool: CallableTool = {
      tool: () => inner.tool(),
      callTool: async (calls) => {
        try {
          const parts = await inner.callTool(calls);
          for (const part of parts) {
            const resp = part.functionResponse?.response;
            if (resp && "error" in resp && resp.error !== undefined && toolError === undefined) {
              toolError = errorDetail(resp.error);
            }
          }
          return parts;
        } catch (e) {
          toolError = e instanceof Error ? e.message : String(e);
          throw e;
        }
      },
    };
    const client = opts.client ?? new GoogleGenAI({ apiKey });
    const response = await raceAbort(
      signal,
      client.models.generateContent({
        model: opts.model || process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
        contents: prompt,
        config: { tools: [tool], abortSignal: signal },
      }),
    );
    const text = redact(response.text ?? "", token, apiKey);
    if (toolError !== undefined) {
      return { ok: false, text, error: `tool error: ${redact(toolError, token, apiKey).slice(0, 300)}`, exitCode: null };
    }
    if (response.promptFeedback?.blockReason) {
      return { ok: false, text: "", error: "refused", exitCode: null };
    }
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") {
      return { ok: false, text, error: `response ${String(finish).toLowerCase()}`, exitCode: null };
    }
    return { ok: true, text, exitCode: null };
  } catch (e) {
    if (signal.aborted) return { ok: false, text: "", error: "timeout", exitCode: null };
    const msg = e instanceof Error ? e.message : String(e);
    const error = toolError !== undefined ? `tool error: ${redact(toolError, token, apiKey).slice(0, 300)}` : redact(msg, token, apiKey);
    return { ok: false, text: "", error, exitCode: null };
  } finally {
    try {
      await handle?.close();
    } catch {
      /* ignore close errors */
    }
  }
}
