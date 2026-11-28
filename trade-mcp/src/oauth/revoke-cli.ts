// Emergency operator command: revoke every OAuth access token, refresh token and pending code.
// Prints counts only. Never prints tokens, codes, hashes or client secrets.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TradeOAuthProvider } from "./provider.js";
import { checkLock, lockAgeSeconds, lockPath, LIVE_WINDOW_MS } from "../datadir-lock.js";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

const USAGE = "usage: revoke-cli.js --force   (--force confirms trade-mcp is STOPPED; revoking while it runs is undone by the server)";
const RUNBOOK =
  "docker compose stop trade-mcp && docker compose run --rm --no-deps trade-mcp node dist/src/oauth/revoke-cli.js --force && docker compose start trade-mcp";

/** Exit codes: 0 ok / nothing to revoke, 1 corrupt or wrong-shape store, 2 usage, 3 unexpected error, 4 trade-mcp is running. */
export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const dataDir = env.DATA_DIR || "./runtime";
  // Lock first: a live server always gives exit 4, with or without --force.
  try {
    if (checkLock(dataDir) === "live") {
      const age = lockAgeSeconds(dataDir);
      err(`trade-mcp is running (lock heartbeat ${age ?? "?"}s ago); stop it first, then wait ${LIVE_WINDOW_MS / 1000} s (${RUNBOOK}). --force does not override a live lock. Nothing changed.`);
      return 4;
    }
  } catch {
    err("Cannot check the DATA_DIR lock; refusing. Check DATA_DIR permissions. Nothing changed.");
    return 3;
  }
  const unknown = argv.filter((a) => a !== "--force");
  if (unknown.length) {
    err("Unknown argument. " + USAGE);
    return 2;
  }
  if (!argv.length) {
    err(
      "Refusing to run without --force.\n" +
        "--force confirms trade-mcp is STOPPED. Revoking while it runs is undone by the server: it keeps the OAuth store in memory\n" +
        "and rewrites oauth.json on its next write, even an unauthenticated /authorize, which restores the revoked tokens.\n" +
        "Supported procedure (stop, wait ~15 s, run, start):\n  " + RUNBOOK,
    );
    return 2;
  }
  try {
    const lock = checkLock(dataDir);
    if (lock === "stale" || lock === "corrupt") err(`Note: ignoring ${lock} ${lockPath(dataDir)} (no live trade-mcp process).`);
    const stateFile = path.join(dataDir, "oauth.json");
    if (!existsSync(stateFile)) {
      out("No OAuth store found; nothing to revoke.");
      out("Static tokens are unaffected: rotate MCP_TOKEN and MCP_TOKEN_READONLY in .env separately if exposed.");
      return 0;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      err("OAuth store is unreadable or corrupt; refusing to rewrite it (registered clients would be lost). Nothing changed.");
      return 1;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      err("OAuth store has an unexpected shape (not a JSON object); refusing to rewrite it. Nothing changed.");
      return 1;
    }
  // The password hash only keys the in-memory rate limiter; persisted limiter entries are copied through as-is.
  const provider = new TradeOAuthProvider({
    issuerUrl: new URL("https://invalid.example"),
    passwordHash: env.OAUTH_PASSWORD_HASH || "revoke-cli",
    allowedRedirectHosts: [],
    stateFile,
  });
  const c = provider.revokeAll();
  out(`revoked ${c.access} access, ${c.refresh} refresh, ${c.codes} codes (also cleared ${c.pending} pending logins, ${c.rotated} rotation markers)`);
  out("Registered clients and login rate-limit state were kept; users only need to log in again.");
  out("Static tokens are unaffected: rotate MCP_TOKEN and MCP_TOKEN_READONLY in .env separately if exposed.");
  out("Now start trade-mcp (docker compose start trade-mcp).");
  return 0;
  } catch {
    err("Unexpected error; nothing was revealed and the store was not intentionally changed. Check DATA_DIR permissions.");
    return 3;
  }
}

const samePath = (a: string, b: string): boolean => {
  // argv[1] is as typed (may be a symlink); import.meta.url is the realpath. Compare realpaths.
  const real = (p: string): string => {
    try { return realpathSync(p); } catch { return path.resolve(p); }
  };
  const x = real(a), y = real(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};
if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exit(run(process.argv.slice(2)));
}
