# PB-2 · deploy · wire paper-bot into compose + Caddy (basic auth) + CI
Branch: own/PB-2        Base: main        Owner: OWNER

## Contract (from PB-1)
Service `paper-bot`, built from `paper-bot/` (Dockerfile there), listening on 8090. `/healthz` returns ok. SQLite lives in `/data`. There is no app auth.

## Files you may touch
- `deploy/docker-compose.yml`: add a `paper-bot` service:
  - build `../paper-bot`;
  - `networks: [internal]`, with **no published ports**;
  - volume `paper_bot_data:/data`;
  - `mem_limit: ${PAPER_BOT_MEM_LIMIT:-256m}`, `memswap_limit` set to the same value;
  - `restart: unless-stopped`;
  - a healthcheck on `/healthz` (use python urllib, since the slim image has no wget/curl);
  - env vars passed through with defaults: SYMBOLS, RESOLUTION, INTERVAL_SEC, FAST, SLOW, ALLOW_SHORT, NOTIONAL_USD, START_CAPITAL_USD, TAKER_FEE, SLIPPAGE, DELTA_BASE_URL.

  Copy the pattern TM2-47 used for the other services.
- `deploy/Caddyfile`: a new site `dash.{$DOMAIN}` with `basic_auth { {$DASH_USER} {$DASH_PASSWORD_HASH} }` and `reverse_proxy paper-bot:8090`. Check the current Caddy major version in compose for the directive name (`basic_auth` in v2.8+, `basicauth` earlier). Pass DASH_USER and DASH_PASSWORD_HASH to caddy's environment in compose.
- `deploy/.env.example`: the new vars, with comments. `DASH_PASSWORD_HASH` is generated with `docker run --rm caddy:<pinned> caddy hash-password --plaintext '<pw>'`.
- `.github/workflows/ci.yml`: add a `paper-bot` job in the bt-service style (setup-uv with the same pinned SHA, Python 3.12, `uv sync --frozen`, `uv run pytest -q`). Keep the SHA pins and permissions.
- `deploy/test_pb2.py` (new): compose has paper-bot on the internal network, no ports, mem limit and healthcheck; the Caddy site has basic_auth before reverse_proxy; `.env.example` has the vars; `docker compose config` resolves (skip if no Docker).

The runbook section goes in the report; the owner adds it after deploy.

## Notes
- PB-1 creates `paper-bot/` at the same time. Your CI job will fail until PB-1 merges, which is expected. Coordinate by merging PB-1 first.
- Existing deploy tests stay green. Pinned compose key-set tests may need the test writer.

## Verify
`uv run --with pytest --with pyyaml pytest -q deploy/` and `docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config -q`
