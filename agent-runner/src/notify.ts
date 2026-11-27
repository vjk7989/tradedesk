import type { Job } from "./jobs.js";

export interface NotifyResult {
  ok: boolean;
  durationMs: number;
  text: string;
  error?: string;
}

export interface NotifyDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
const MAX_TEXT = 3500;

/** Sends a job report summary to Telegram. Never throws; never logs or sends the MCP or bot token. */
export async function notifyTelegram(job: Job, result: NotifyResult, deps: NotifyDeps): Promise<void> {
  const secrets = [
    ...new Set(
      [deps.env[job.mcp.tokenEnv], deps.env[TELEGRAM_TOKEN_ENV]].flatMap((v) =>
        typeof v === "string" && v.trim() !== "" ? [v, v.trim()] : [],
      ),
    ),
  ].sort((x, y) => y.length - x.length);
  const redact = (t: string) => secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), t);
  try {
    const botToken = deps.env[TELEGRAM_TOKEN_ENV]?.trim();
    const chatIdEnv = job.notify?.telegram.chatIdEnv;
    const chatId = chatIdEnv ? deps.env[chatIdEnv]?.trim() : undefined;
    if (!botToken || !chatId) {
      console.error(
        redact(`notify ${job.name}: telegram skipped, ${TELEGRAM_TOKEN_ENV} or ${chatIdEnv ?? "chatIdEnv"} is missing or blank`),
      );
      return;
    }
    if (secrets.includes(chatId)) {
      console.error(redact(`notify ${job.name}: telegram skipped, chat id matches a secret`));
      return;
    }
    const errLine = result.error ? `error: ${redact(result.error).slice(0, 300)}` : undefined;
    const head = [
      `${job.name}: ${result.ok ? "ok" : "error"}`,
      `duration: ${result.durationMs} ms`,
      ...(errLine ? [errLine] : []),
      "",
    ].join("\n");
    let body = redact(result.text).slice(0, MAX_TEXT);
    if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
    const text = redact(head) + body;
    const res = await deps.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(redact(`notify ${job.name}: telegram responded HTTP ${res.status}`));
  } catch (e) {
    try {
      console.error(redact(`notify ${job.name}: telegram failed: ${e instanceof Error ? e.message : String(e)}`));
    } catch {
      /* never throw */
    }
  }
}
