import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type ServerDeps } from "./server.js";
import { probeAuditWritable } from "./risk/audit-probe.js";
import { loadOAuthConfig } from "./oauth/config.js";
import { createOAuth, OAUTH_PATHS, type OAuthRuntime } from "./oauth/provider.js";

const MAX_BODY = 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new TooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const READYZ_TIMEOUT_MS = 3000;
const READYZ_TTL_MS = 5000;
type Check = "ok" | "fail";
interface ReadyResult { status: number; body: { ok: boolean; checks: { openalgo: Check; bt: Check | "not_configured"; auditWritable: Check } } }

export function createHttpServer(
  deps: ServerDeps,
  oauthCfg = loadOAuthConfig(process.env),
): Server {
  const oauth: OAuthRuntime | undefined = oauthCfg ? createOAuth(oauthCfg) : undefined;

  // Bodies carry only fixed enum strings: never URLs, keys or error text.
  async function checkOpenalgo(): Promise<Check> {
    let timer: NodeJS.Timeout | undefined;
    const ctl = new AbortController();
    try {
      // On the deadline the controller aborts the in-flight OpenAlgo request as well as failing the check.
      // (setTimeout, not AbortSignal.timeout: existing TM2-5 fake-timer tests drive this deadline.)
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error("timeout")); }, READYZ_TIMEOUT_MS); });
      const r = await Promise.race([deps.client.analyzerStatus(ctl.signal), timeout]);
      return r?.status === "success" ? "ok" : "fail";
    } catch {
      return "fail";
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkBt(): Promise<Check | "not_configured"> {
    const btUrl = deps.cfg.btUrl;
    if (!btUrl) return "not_configured";
    try {
      const res = await fetch(`${btUrl.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(READYZ_TIMEOUT_MS), redirect: "manual" });
      if (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) return "fail";
      return res.ok ? "ok" : "fail";
    } catch {
      return "fail";
    }
  }

  function checkAudit(): Check {
    try {
      probeAuditWritable(deps.auditFile);
      return "ok";
    } catch {
      return "fail";
    }
  }

  async function computeReadyz(): Promise<ReadyResult> {
    const [openalgo, bt, auditWritable] = await Promise.all([checkOpenalgo(), checkBt(), Promise.resolve().then(checkAudit)]);
    const ok = openalgo === "ok" && bt !== "fail" && auditWritable === "ok";
    return { status: ok ? 200 : 503, body: { ok, checks: { openalgo, bt, auditWritable } } };
  }

  let readyCache: { at: number; p: Promise<ReadyResult> } | undefined;
  function readyz(): Promise<ReadyResult> {
    const now = Date.now();
    if (!readyCache || now < readyCache.at || now - readyCache.at >= READYZ_TTL_MS) {
      readyCache = { at: now, p: computeReadyz() };
    }
    return readyCache.p;
  }

  async function scopeOf(req: IncomingMessage): Promise<"full" | "readonly" | null> {
    if (authorized(req, deps.cfg.mcpToken)) return "full";
    if (deps.cfg.mcpTokenReadonly && authorized(req, deps.cfg.mcpTokenReadonly)) return "readonly";
    if (!oauth) return null;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    try {
      await oauth.provider.verifyAccessToken(m[1]);
      return "full";
    } catch {
      return null;
    }
  }

  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0];
      if (oauth && OAUTH_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p))) {
        oauth.app(req, res);
        return;
      }
      if (path === "/healthz" && req.method === "GET") return json(res, 200, { ok: true, mode: deps.cfg.mode });
      if (path === "/readyz") {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }, { Allow: "GET" });
        const r = await readyz();
        return json(res, r.status, r.body);
      }
      if (path !== "/mcp") return json(res, 404, { error: "not found" });
      const scope = await scopeOf(req);
      if (!scope) {
        return json(
          res,
          401,
          { error: "unauthorized" },
          oauth ? { "WWW-Authenticate": oauth.wwwAuthenticate } : {},
        );
      }
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" }, { Allow: "POST" });

      let raw: string;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e instanceof TooLarge) {
          json(res, 413, { error: "request body too large" }, { Connection: "close" });
          return;
        }
        throw e;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }

      // stateless: fresh server + transport per request
      const server = createMcpServer({ ...deps, scope });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("http error:", e instanceof Error ? e.message : String(e));
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  });
}
