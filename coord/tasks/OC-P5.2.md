# OC-P5.2 · deploy · route the OAuth endpoints through Caddy and pass the OAuth env to trade-mcp
Branch: oc/OC-P5.2        Base: main @ eddb02b
Owner: OC2

## Files you may touch (≤5)
- `deploy/Caddyfile`
- `deploy/docker-compose.yml` (trade-mcp `environment:` block only)
- `deploy/.env.example`
- `deploy/test_deploy.py`
- `docs/vps-runbook.md`

## Do not touch
Anything under `trade-mcp/`, `bt-service/` or `agent-runner/`. The OAuth code is being finished in another branch; you only wire up deployment.

## Context (read only these)
- `deploy/Caddyfile:1-15`: the `mcp.{$DOMAIN}` site. Today the `@allowed` matcher passes only `/mcp*` and `/healthz` to `trade-mcp:8787`, and everything else returns 404.
- `deploy/docker-compose.yml:36-46`: the trade-mcp environment block.
- `deploy/test_deploy.py`: the existing static tests (35). The test `test_caddy_mcp_routes_only_mcp_and_healthz` encodes the old rule; you update it to the new allowed set.
- Facts about the OAuth server (from the P5.1 developer's report):
  - Paths served by trade-mcp: `/authorize`, `/token`, `/register`, `/revoke`, `/login`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.
  - Env: `OAUTH_ENABLED` ("1" to enable), `OAUTH_ISSUER_URL` (https, = `https://mcp.<DOMAIN>`), `OAUTH_PASSWORD_HASH` (format `scrypt:<32 hex salt>:<128 hex hash>`), optional `OAUTH_ALLOWED_REDIRECT_HOSTS` (comma list, default `chatgpt.com,claude.ai,claude.com`).
  - Hash generator command, to put in `.env.example` and the runbook:
    `node -e "const c=require('crypto');const s=c.randomBytes(16);console.log('scrypt:'+s.toString('hex')+':'+c.scryptSync(process.argv[1],s,64).toString('hex'))" 'your-password'`
  - The login rate limiter trusts exactly one proxy hop (X-Forwarded-For). So trade-mcp's port must never be published or reachable except through Caddy.

## Acceptance criteria
- The Caddy `mcp.{$DOMAIN}` matcher allows exactly: `/mcp`, `/mcp/*`, `/healthz`, `/authorize`, `/token`, `/register`, `/revoke`, `/login` and `/.well-known/*`. Everything else still returns 404, and nothing routes to bt-service.
- Compose passes `OAUTH_ENABLED: ${OAUTH_ENABLED:-0}`, `OAUTH_ISSUER_URL: ${OAUTH_ISSUER_URL:-}`, `OAUTH_PASSWORD_HASH: ${OAUTH_PASSWORD_HASH:-}` and `OAUTH_ALLOWED_REDIRECT_HOSTS: ${OAUTH_ALLOWED_REDIRECT_HOSTS:-chatgpt.com,claude.ai,claude.com}` to trade-mcp. OAuth stays off by default.
- `.env.example` documents each var with a placeholder value (no real hash) and the generator command.
- `docs/vps-runbook.md` gets a short "ChatGPT / claude.ai connectors (OAuth)" section: how to enable it, the generator, the connector URL `https://mcp.<DOMAIN>/mcp`, and the warning that trade-mcp's port must never be published.
- `deploy/test_deploy.py`: the Caddy route test asserts the new exact set (positive and negative paths, e.g. `/admin` and `/mcpx` still 404). A new test asserts compose has the four OAUTH vars and `OAUTH_ENABLED` defaults to 0. All other existing tests stay unchanged and green.

## Verify (must pass before you report)
```
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config -q
uv run --with pytest --with pyyaml pytest -q deploy/test_deploy.py
```

YAGNI: no new services, no Caddy plugins, no changes outside the listed files.
