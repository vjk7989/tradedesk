// Emergency operator command: revoke every OAuth access token, refresh token and pending code.
// Prints counts only. Never prints tokens, codes, hashes or client secrets.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { TradeOAuthProvider } from "./provider.js";
import { checkLock, readLock, lockPath } from "../datadir-lock.js";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

const USAGE = "usage: revoke-cli.js --force   (--force confirms trade-mcp is STOPPED; revoking while it runs is undone by the server)";
const RUNBOOK =
  "docker compose stop trade-mcp && docker compose run --rm --no-deps trade-mcp node dist/src/oauth/revoke-cli.js --force && docker compose start trade-mcp";

/** Exit codes: 0 ok / nothing to revoke, 1 corrupt or wrong-shape store, 2 usage, 3 unexpected error, 4 trade-mcp is running. */
export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
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
        "Supported procedure (stop, run, start):\n  " + RUNBOOK,
    );
    return 2;
  }
  try {
    const dataDir = env.DATA_DIR || "./runtime";
    const lock = checkLock(dataDir);
    if (lock === "live") {
      err("trade-mcp is running; stop it first (" + RUNBOOK + "). --force does not override a live lock. Nothing changed.");
      return 4;
    }
    if (lock === "foreign") {
      const i = readLock(dataDir);
      err(`Warning: ${lockPath(dataDir)} was written by another container (${typeof i === "object" ? i.hostname : "?"}); its liveness cannot be checked from here. Proceeding because --force says trade-mcp is stopped.`);
    } else if (lock === "stale" || lock === "corrupt") {
      err(`Note: ignoring ${lock} ${lockPath(dataDir)} (no live trade-mcp process).`);
    }
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(run(process.argv.slice(2)));
}
