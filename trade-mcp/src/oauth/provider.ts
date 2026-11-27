import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthConfig } from "./config.js";
import { LoginLimiter, loginPage, verifyPassword } from "./login.js";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60 * 1000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);

interface TokenRec {
  clientId: string;
  familyId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}
interface CodeRec {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
interface Pending {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
interface Persisted {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRec>;
  refresh: Record<string, TokenRec>;
  /** sha256(refresh token) already rotated -> family, kept to detect reuse */
  rotated?: Record<string, { familyId: string; expiresAt: number }>;
  /** keyed by sha256(code) */
  codes?: Record<string, CodeRec>;
  /** keyed by sha256(rid) */
  pending?: Record<string, Pending>;
  /** sha256(ip) -> failure timestamps (ms) */
  loginFailures?: Record<string, number[]>;
}

export function redirectAllowed(uri: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return allowedHosts.some((a) => h === a || h.endsWith("." + a));
}

export class TradeOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private access = new Map<string, TokenRec>(); // key: sha256(token)
  private refresh = new Map<string, TokenRec>();
  private rotated = new Map<string, { familyId: string; expiresAt: number }>();
  private codes = new Map<string, CodeRec>();
  private pending = new Map<string, Pending>();

  private readonly limiter = new LoginLimiter();

  constructor(private cfg: OAuthConfig) {
    if (existsSync(cfg.stateFile)) {
      try {
        const d = JSON.parse(readFileSync(cfg.stateFile, "utf8")) as Persisted;
        for (const [k, v] of Object.entries(d.clients ?? {})) this.clients.set(k, v);
        for (const [k, v] of Object.entries(d.access ?? {})) this.access.set(k, v);
        for (const [k, v] of Object.entries(d.refresh ?? {})) this.refresh.set(k, v);
        for (const [k, v] of Object.entries(d.rotated ?? {})) this.rotated.set(k, v);
        for (const [k, v] of Object.entries(d.codes ?? {})) this.codes.set(k, v);
        for (const [k, v] of Object.entries(d.pending ?? {})) this.pending.set(k, v);
        this.limiter.load(d.loginFailures ?? {});
        this.prune();
      } catch {
        /* corrupt state: start empty */
      }
    }
  }

  private persist(): void {
    const d: Persisted = {
      clients: Object.fromEntries(this.clients),
      access: Object.fromEntries(this.access),
      refresh: Object.fromEntries(this.refresh),
      rotated: Object.fromEntries(this.rotated),
      codes: Object.fromEntries(this.codes),
      pending: Object.fromEntries(this.pending),
      loginFailures: this.limiter.snapshot(),
    };
    mkdirSync(path.dirname(this.cfg.stateFile), { recursive: true });
    const tmp = this.cfg.stateFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    renameSync(tmp, this.cfg.stateFile);
    try {
      chmodSync(this.cfg.stateFile, 0o600);
    } catch {
      /* best effort on Windows */
    }
  }

  private prune(): void {
    const t = nowS();
    for (const m of [this.access, this.refresh, this.rotated]) for (const [k, v] of m) if (v.expiresAt <= t) m.delete(k);
    const ms = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= ms) this.codes.delete(k);
    for (const [k, v] of this.pending) if (v.expiresAt <= ms) this.pending.delete(k);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      registerClient: (client) => {
        const uris = (client.redirect_uris ?? []).map(String);
        if (!uris.length || !uris.every((u) => redirectAllowed(u, this.cfg.allowedRedirectHosts))) {
          throw new InvalidClientMetadataError("redirect_uri not allowed");
        }
        const full = client as OAuthClientInformationFull;
        this.clients.set(full.client_id, full);
        this.persist();
        return full;
      },
    };
  }

  /** Renders the login form; the code is issued by completeLogin after the password check. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prune();
    const rid = randomBytes(24).toString("hex");
    this.pending.set(sha(rid), {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.persist();
    this.sendLogin(res, rid, client.client_name ?? client.client_id);
  }

  private sendLogin(res: Response, rid: string, clientName: string, error?: string, status = 200): void {
    res
      .status(status)
      .set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" })
      .type("html")
      .send(loginPage({ rid, clientName, error }));
  }

  /** POST /login handler. */
  login = (req: express.Request, res: express.Response): void => {
    const ip = req.ip ?? "unknown";
    const rid = String(req.body?.rid ?? "");
    const password = String(req.body?.password ?? "");
    this.prune();
    const p = this.pending.get(sha(rid));
    if (!p) {
      res.status(400).type("text").send("Authorization request expired. Start again from the client.");
      return;
    }
    const name = this.clients.get(p.clientId)?.client_name ?? p.clientId;
    if (this.limiter.blocked(ip)) {
      res.set("Retry-After", "900");
      this.sendLogin(res, rid, name, "Too many failed attempts. Try again later.", 429);
      return;
    }
    if (!verifyPassword(password, this.cfg.passwordHash)) {
      this.limiter.fail(ip);
      this.persist();
      this.sendLogin(res, rid, name, "Wrong password.", 401);
      return;
    }
    this.limiter.reset(ip);
    this.pending.delete(sha(rid));
    const code = randomBytes(32).toString("hex");
    this.codes.set(sha(code), {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scopes: p.scopes,
      resource: p.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.persist();
    const target = new URL(p.redirectUri);
    target.searchParams.set("code", code);
    if (p.state !== undefined) target.searchParams.set("state", p.state);
    res.set("Cache-Control", "no-store").redirect(302, target.href);
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.codes.get(sha(code));
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= Date.now()) {
      throw new InvalidGrantError("invalid authorization code");
    }
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const key = sha(code);
    const rec = this.codes.get(key);
    this.codes.delete(key); // single use
    this.persist(); // removal is durable before any tokens are returned
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= Date.now()) {
      throw new InvalidGrantError("invalid authorization code");
    }
    if (redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issue(client.client_id, randomBytes(16).toString("hex"), rec.scopes, rec.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string): Promise<OAuthTokens> {
    this.prune();
    const key = sha(token);
    const rec = this.refresh.get(key);
    if (!rec) {
      const used = this.rotated.get(key);
      if (used) {
        // reuse of a rotated token: revoke the whole family
        this.revokeFamily(used.familyId);
        this.persist();
      }
      throw new InvalidGrantError("invalid refresh token");
    }
    if (rec.clientId !== client.client_id) throw new InvalidGrantError("invalid refresh token");
    this.refresh.delete(key); // rotation
    this.rotated.set(key, { familyId: rec.familyId, expiresAt: rec.expiresAt });
    return this.issue(rec.clientId, rec.familyId, rec.scopes, rec.resource);
  }

  private revokeFamily(familyId: string): void {
    for (const m of [this.access, this.refresh]) for (const [k, v] of m) if (v.familyId === familyId) m.delete(k);
  }

  private issue(clientId: string, familyId: string, scopes: string[], resource?: string): OAuthTokens {
    const at = randomBytes(32).toString("hex");
    const rt = randomBytes(32).toString("hex");
    const t = nowS();
    this.access.set(sha(at), { clientId, familyId, scopes, resource, expiresAt: t + ACCESS_TTL_S });
    this.refresh.set(sha(rt), { clientId, familyId, scopes, resource, expiresAt: t + REFRESH_TTL_S });
    this.persist();
    return {
      access_token: at,
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: rt,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.access.get(sha(token));
    if (!rec || rec.expiresAt <= nowS()) throw new InvalidTokenError("invalid or expired token");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt,
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, req: { token: string }): Promise<void> {
    const key = sha(req.token);
    for (const m of [this.access, this.refresh]) {
      if (m.get(key)?.clientId === client.client_id) m.delete(key);
    }
    this.persist();
  }
}

export interface OAuthRuntime {
  provider: TradeOAuthProvider;
  /** Express app handling /authorize /token /register /revoke /login and the well-known endpoints. */
  app: express.Express;
  /** Value for the WWW-Authenticate header on 401 from /mcp. */
  wwwAuthenticate: string;
}

export const OAUTH_PATHS = ["/authorize", "/token", "/register", "/revoke", "/login", "/.well-known/"];

export function createOAuth(cfg: OAuthConfig): OAuthRuntime {
  const provider = new TradeOAuthProvider(cfg);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: Caddy
  const resourceServerUrl = new URL("/mcp", cfg.issuerUrl);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: cfg.issuerUrl,
      resourceServerUrl,
      resourceName: "trade-mcp",
    }),
  );
  app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), provider.login);
  return {
    provider,
    app,
    wwwAuthenticate: `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(resourceServerUrl)}"`,
  };
}
