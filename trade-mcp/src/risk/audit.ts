import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SECRET_RE = /apikey|token|secret|password|authorization|passphrase|privatekey|cookie|session/;
const isSecret = (k: string) => SECRET_RE.test(k.toLowerCase().replace(/[-_]/g, ""));

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = isSecret(k) ? "[REDACTED]" : redact(val);
    return out;
  }
  return v;
}

export function appendAudit(file: string, entry: object): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ ...(redact(entry) as object), ts: new Date().toISOString() });
  appendFileSync(file, line + "\n");
}
