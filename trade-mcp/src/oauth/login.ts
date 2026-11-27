import { scryptSync, timingSafeEqual } from "node:crypto";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

export function verifyPassword(password: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 5 failed logins per IP per 15 minutes. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();

  private recent(ip: string, now: number): number[] {
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length) this.fails.set(ip, list);
    else this.fails.delete(ip);
    return list;
  }

  blocked(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length >= MAX_FAILS;
  }

  fail(ip: string, now = Date.now()): void {
    this.fails.set(ip, [...this.recent(ip, now), now]);
  }

  reset(ip: string): void {
    this.fails.delete(ip);
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
