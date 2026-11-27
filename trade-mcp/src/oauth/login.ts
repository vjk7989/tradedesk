import { createHash, scryptSync, timingSafeEqual } from "node:crypto";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

const hashIp = (ip: string) => createHash("sha256").update(ip).digest("hex");

export function verifyPassword(password: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 5 failed logins per IP per 15 minutes. */
export class LoginLimiter {
  private fails = new Map<string, number[]>(); // key: sha256(ip)

  /** Failure timestamps keyed by sha256(ip), for persistence. */
  snapshot(): Record<string, number[]> {
    return Object.fromEntries(this.fails);
  }

  clear(): void {
    this.fails.clear();
  }

  /** Restores a snapshot, dropping entries outside the window. */
  load(d: Record<string, number[]>, now = Date.now()): void {
    if (typeof d !== "object" || d === null) return;
    for (const [k, v] of Object.entries(d)) {
      const list = Array.isArray(v) ? v.filter((t) => typeof t === "number" && now - t < WINDOW_MS) : [];
      if (list.length) this.fails.set(k, list);
    }
  }

  private recent(rawIp: string, now: number): number[] {
    const ip = hashIp(rawIp);
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length) this.fails.set(ip, list);
    else this.fails.delete(ip);
    return list;
  }

  blocked(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length >= MAX_FAILS;
  }

  fail(ip: string, now = Date.now()): void {
    this.fails.set(hashIp(ip), [...this.recent(ip, now), now]);
  }

  reset(ip: string): void {
    this.fails.delete(hashIp(ip));
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function loginPage(opts: { rid: string; clientName: string; error?: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title></head>
<body style="font-family:sans-serif;max-width:22rem;margin:4rem auto">
<h1>trade-mcp</h1>
<p>${esc(opts.clientName)} wants to access your trading tools.</p>
${opts.error ? `<p style="color:#b00020">${esc(opts.error)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="rid" value="${esc(opts.rid)}">
<label>Password <input type="password" name="password" autofocus required></label>
<button type="submit">Authorize</button>
</form></body></html>`;
}
