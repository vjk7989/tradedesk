# PB-2 report: paper-bot deploy wiring

Files: deploy/docker-compose.yml, deploy/Caddyfile, deploy/.env.example, .github/workflows/ci.yml, deploy/test_pb2.py (new).

- Caddy is pinned `caddy:2-alpine` (floating v2, so >=2.8): used `basic_auth`.
- CI `paper-bot` job reuses the pinned checkout and setup-uv SHAs; uses `uv sync --frozen` per brief (bt-service uses plain `uv sync`). Fails until PB-1 merges (paper-bot/ and its uv.lock).
- Dashboard auth fails closed: DASH_USER defaults to admin, DASH_PASSWORD_HASH to a valid bcrypt hash of a discarded secret (locked until the operator sets one). Caddy validate not run (Docker daemon down).

## Pinned failures in existing tests (not edited; need the test writer)
- test_deploy.py::test_services_exact: expects the old service set (no paper-bot).
- Tests that write their own env file without DASH_USER/DASH_PASSWORD_HASH now fail on `:?set ...`:
  test_deploy.py (optional_vars_unset_defaults, empty_oauth_enabled, execute_timeout_ms_default, readonly_token), test_o11_edge.py::resolves_execute_max_concurrent (4), test_tm12_edge.py::resolves_execute_timeout (4), test_tm2_47_limits.py::docker_config_defaults_and_overrides.
  Fix: add the two vars to those fixtures, or relax to `:-` if the owner prefers.
Result: 14 failed, 269 passed, 3 skipped (new test_pb2.py passes).

## Runbook (add after deploy)
### paper-bot dashboard
1. DNS: add A record `dash.$DOMAIN` -> VPS.
2. Generate hash: `docker run --rm caddy:2-alpine caddy hash-password --plaintext '<pw>'`.
3. In deploy/.env set `DASH_USER=<user>` and `DASH_PASSWORD_HASH='<hash>'` (single quotes, hash contains `$`), plus optional SYMBOLS, RESOLUTION, INTERVAL_SEC, FAST, SLOW, ALLOW_SHORT, NOTIONAL_USD, START_CAPITAL_USD, TAKER_FEE, SLIPPAGE, DELTA_BASE_URL, PAPER_BOT_MEM_LIMIT (default 256m).
4. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build paper-bot caddy`.
5. Check: `docker compose ps` shows paper-bot healthy; `curl -I https://dash.$DOMAIN` returns 401; with `-u user:pw` returns 200.
6. State is in volume `paper_bot_data` (/data, SQLite). Not published on any host port; only reachable through Caddy. Paper only, no real orders.
