// Emergency operator command: revoke every OAuth access token, refresh token and pending code.
// Prints counts only. Never prints tokens, codes, hashes or client secrets.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { TradeOAuthProvider } from "./provider.js";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  if (!argv.includes("--force")) {
    err(
      "Refusing to run without --force.\n" +
        "trade-mcp keeps the OAuth store in memory and rewrites oauth.json on every change; a second process\n" +
        "would be overwritten by (or overwrite) the running server, so the revocation could be silently undone.\n" +
        "Either: stop trade-mcp, run this command, then start trade-mcp;\n" +
        "or, if you are sure, run it with --force (e.g. docker compose exec trade-mcp npm run oauth:revoke-all -- --force)\n" +
        "and restart trade-mcp straight afterwards.",
    );
    return 2;
  }
  const stateFile = path.join(env.DATA_DIR || "./runtime", "oauth.json");
  if (!existsSync(stateFile)) {
    out("No OAuth store found; nothing to revoke.");
    out("Static MCP_TOKEN / MCP_TOKEN_READONLY are unaffected: rotate MCP_TOKEN in .env separately.");
    return 0;
  }
  try {
    JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    err("OAuth store is unreadable or corrupt; refusing to rewrite it (registered clients would be lost). Nothing changed.");
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
  out("Static MCP_TOKEN / MCP_TOKEN_READONLY are unaffected: rotate MCP_TOKEN in .env separately.");
  out("Restart trade-mcp now so the running process drops its in-memory copy.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(run(process.argv.slice(2)));
}
