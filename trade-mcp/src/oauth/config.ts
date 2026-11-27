import path from "node:path";

export interface OAuthConfig {
  /** Public https base URL of this server, e.g. https://mcp.example.com */
  issuerUrl: URL;
  /** `scrypt:<saltHex>:<hashHex>` (64-byte key). Generate with:
   *  node -e "const c=require('crypto');const s=c.randomBytes(16);console.log('scrypt:'+s.toString('hex')+':'+c.scryptSync(process.argv[1],s,64).toString('hex'))" 'your-password'
   */
  passwordHash: string;
  allowedRedirectHosts: string[];
  stateFile: string;
}

/** Returns undefined unless OAUTH_ENABLED=1 and the required vars are valid. Throws on a bad value when enabled. */
export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  if (env.OAUTH_ENABLED !== "1") return undefined;
  const issuer = env.OAUTH_ISSUER_URL ?? "";
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error("OAUTH_ISSUER_URL must be a valid https URL");
  }
  if (issuerUrl.protocol !== "https:") throw new Error("OAUTH_ISSUER_URL must be https");
  const passwordHash = env.OAUTH_PASSWORD_HASH ?? "";
  if (!/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(passwordHash)) {
    throw new Error("OAUTH_PASSWORD_HASH must be scrypt:<32 hex salt>:<128 hex hash>");
  }
  const hosts = (env.OAUTH_ALLOWED_REDIRECT_HOSTS || "chatgpt.com,claude.ai,claude.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    issuerUrl,
    passwordHash,
    allowedRedirectHosts: hosts,
    stateFile: path.join(env.DATA_DIR || "./runtime", "oauth.json"),
  };
}
