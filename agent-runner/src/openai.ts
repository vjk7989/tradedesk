import OpenAI from "openai";
import { validMcpSpec } from "./cli.js";
import type { McpSpec, RunResult } from "./types.js";

/** Model used when OPENAI_MODEL is unset: the general model named in the openai SDK README examples. */
const DEFAULT_OPENAI_MODEL = "gpt-5.5";

export interface OpenAiOptions {
  prompt: string;
  mcp: McpSpec;
  timeoutMs?: number;
  model?: string;
  /** Injected in tests; defaults to `new OpenAI()` (reads OPENAI_API_KEY). */
  client?: Pick<OpenAI, "responses">;
}

function redact(msg: string, token: string | undefined): string {
  return token ? msg.split(token).join("[redacted]") : msg;
}

/** Rejects when the signal aborts, so a client that ignores the signal still times out. */
function raceAbort<T>(signal: AbortSignal, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    p.then(resolve, reject);
  });
}

/**
 * Runs one task on the OpenAI Responses API with a remote MCP tool. OpenAI's servers connect to mcp.url,
 * so it must be the public https URL.
 */
export async function runOpenAiTask(opts: OpenAiOptions): Promise<RunResult> {
  const { mcp, prompt } = opts;
  if (!validMcpSpec(mcp) || !mcp.url.startsWith("https://")) {
    return { ok: false, text: "", error: "invalid mcp name, url or tokenEnv (public https url required)", exitCode: null };
  }
  const token = process.env[mcp.tokenEnv];
  if (!token) {
    return { ok: false, text: "", error: `MCP token env ${mcp.tokenEnv} is not set`, exitCode: null };
  }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 600000);
  try {
    const client = opts.client ?? new OpenAI();
    const response = await raceAbort(signal, client.responses.create(
      {
        model: opts.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
        input: prompt,
        tools: [
          {
            type: "mcp",
            server_label: mcp.name,
            server_url: mcp.url,
            headers: { Authorization: `Bearer ${token}` },
            require_approval: "never",
          },
        ],
      },
      { signal },
    ));
    const refused = response.output.some(
      (item) => item.type === "message" && item.content.some((c) => c.type === "refusal"),
    );
    if (refused) return { ok: false, text: "", error: "refused", exitCode: null };
    const text = redact(response.output_text ?? "", token);
    if (response.status !== "completed") {
      return { ok: false, text, error: `response ${response.status ?? "unknown"}`, exitCode: null };
    }
    return { ok: true, text, exitCode: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: "", error: signal.aborted ? "timeout" : redact(msg, token), exitCode: null };
  }
}
