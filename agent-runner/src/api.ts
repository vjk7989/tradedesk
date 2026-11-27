import Anthropic from "@anthropic-ai/sdk";
import { validMcpSpec } from "./cli.js";
import type { McpSpec, RunResult } from "./types.js";

export interface ApiOptions {
  prompt: string;
  mcp: McpSpec;
  timeoutMs?: number;
  /** Injected in tests; defaults to `new Anthropic()` (reads ANTHROPIC_API_KEY / auth profile). */
  client?: Pick<Anthropic, "beta">;
}

const MAX_ITERATIONS = 10;

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
 * Runs one task on the Messages API with the MCP connector. Anthropic's servers connect to mcp.url,
 * so it must be the public https URL.
 */
export async function runApiTask(opts: ApiOptions): Promise<RunResult> {
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
    const client = opts.client ?? new Anthropic();
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await raceAbort(signal, client.beta.messages.create(
        {
          model: "claude-opus-5-5",
          max_tokens: 16000,
          betas: ["mcp-client-2025-11-20", "server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          mcp_servers: [{ type: "url", url: mcp.url, name: mcp.name, authorization_token: token }],
          tools: [{ type: "mcp_toolset", mcp_server_name: mcp.name }],
          messages,
        },
        { signal },
      ));
      if (response.stop_reason === "refusal") {
        return { ok: false, text: "", error: "refused", exitCode: null };
      }
      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
        continue;
      }
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      if (response.stop_reason === "max_tokens") {
        return { ok: false, text: redact(text, token), error: "truncated (max_tokens)", exitCode: null };
      }
      return { ok: true, text: redact(text, token), exitCode: null };
    }
    return { ok: false, text: "", error: `still paused after ${MAX_ITERATIONS} iterations`, exitCode: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = signal.aborted;
    return { ok: false, text: "", error: timedOut ? "timeout" : redact(msg, token), exitCode: null };
  }
}
