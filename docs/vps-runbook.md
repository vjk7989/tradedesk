# VPS runbook

Stack: Caddy (80/443) -> trade-mcp, OpenAlgo; bt-service internal only. Files live in `deploy/`. A `paper-bot` section is coming (PB-2).

## 1. Server
- GCP: step-by-step guide from a real deploy: [gcp-deploy.md](gcp-deploy.md).
- Ubuntu 24.04, minimum 2 vCPU / 4 GB RAM / 40 GB disk. The compose file caps container memory so trade-mcp, bt-service and Caddy total at most 2176 MB by default, leaving the rest for OpenAlgo and the OS (see section 5, Memory limits). Do not go below 4 GB without lowering the limits.
- A static public IP. Under the SEBI/broker static-IP rule, register this IP with your Indian broker (API app settings) and with Delta Exchange (API key IP whitelist). Orders from other IPs are rejected.
- DNS: A records `mcp.<DOMAIN>` and `openalgo.<DOMAIN>` -> the VPS IP.

## 2. Harden
```
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```
SSH key-only: in `/etc/ssh/sshd_config` set `PasswordAuthentication no` and `PermitRootLogin no`, then `sudo systemctl restart ssh`. Docker-published ports bypass ufw; compose publishes only 80/443 (via caddy), so this is fine. Do not add `ports:` to other services.

## 3. Install Docker
Follow https://docs.docker.com/engine/install/ubuntu/ (apt repo method), then `sudo usermod -aG docker $USER` and re-login.

## 4. Get the code
```
git clone <this-repo> <repo-dir> && cd <repo-dir>
git clone https://github.com/marketcalls/openalgo vendor/openalgo
git -C vendor/openalgo checkout f83592a
```
`vendor/` is not part of this repo; the OpenAlgo checkout above is required (compose builds from `OPENALGO_SRC`, default `../vendor/openalgo`).

## 5. Configure
```
cd deploy
cp .env.example .env          # edit: see the checklist below
sed -i "s/^MCP_TOKEN=.*/MCP_TOKEN=$(openssl rand -hex 32)/; s/^BT_TOKEN=.*/BT_TOKEN=$(openssl rand -hex 32)/" .env
cp ../vendor/openalgo/.sample.env openalgo.env
cp risk.example.json risk.json   # edit limits; then set RISK_CONFIG_FILE=./risk.json in .env
chmod 600 .env openalgo.env
sudo chown 1000 openalgo.env
```
The OpenAlgo container user is uid 1000 and OpenAlgo writes its generated keys back to the bind-mounted `/app/.env`, so the file must be owned by uid 1000 (otherwise OpenAlgo logs ".env file not found" and restart-loops).
**Minimum env to fill in** (`deploy/.env`; compose refuses to start if `DOMAIN`, `ACME_EMAIL`, `MCP_TOKEN`, `BT_TOKEN` or `OPENALGO_API_KEY` is empty):
- [ ] `DOMAIN` (not `example.com`) and `ACME_EMAIL`
- [ ] `MCP_TOKEN` and `BT_TOKEN` (the `sed` above sets both)
- [ ] `OPENALGO_API_KEY` (a placeholder is fine for the first start; replace it in section 7)
- [ ] `MODE=paper` (leave as is until section 10)
- [ ] `RISK_CONFIG_FILE=./risk.json` (default is `./risk.example.json`)
- [ ] `openalgo.env`: `HOST_SERVER`, `FLASK_HOST_IP`, `WEBSOCKET_HOST`, `WEBSOCKET_URL`, and the broker keys (below)
- Everything else (`MCP_TOKEN_READONLY`, `EXECUTE_*`, `*_MEM_LIMIT`, `BT_CPUS`, `OAUTH_*`, `OPENALGO_ENV_FILE`, `OPENALGO_SRC`) has a working default or is optional.

Lint `risk.json` with the linter in the trade-mcp image (the host needs only Docker; run from `deploy/`). The `run` form builds the image first (slow on the first run) and works before the stack is up; the `exec` form works only after section 6. Candidate file before deploying: `docker compose run --rm --no-deps -v "$PWD/risk.json:/tmp/risk.json:ro" trade-mcp node dist/src/risk/lint.js /tmp/risk.json [--strict]`. Deployed file (the running container's `/config/risk.json`): `docker compose exec trade-mcp node dist/src/risk/lint.js /config/risk.json [--strict]`. Exit 0 = OK or warnings only, 1 = invalid config, unreadable file or usage error, 2 = warnings under `--strict`. Re-run each January to confirm the new year's NSE/MCX `marketHolidays` are filled in. From a local checkout instead: `cd trade-mcp && npm ci && npm run build && npm run risk:lint -- <file>`.
To fill `marketHolidays` from OpenAlgo, use `deploy/sync_holidays.py` after the stack is up with the real API key: see section 7, step 5.
`EXECUTE_TIMEOUT_MS` (default 60000) is the execute time limit in ms, clamped 5000-900000. Set it to 660000 or more if you use `backtest.walkForward`; MCP clients also have their own tool-call timeout.
`EXECUTE_MAX_CONCURRENT` (default 4, range 1-32) caps simultaneous execute runs; each can use up to about 160 MB (memoryBytes 64 MB + 32 MB WASM + up to 64 MB of pending binding arguments), so size it to the VPS RAM, see Memory limits below. If clients see "busy: too many concurrent executes, retry shortly", raise it and restart.
Edit `openalgo.env`:
- `APP_KEY`, `API_KEY_PEPPER`, `FERNET_SALT`: leave the placeholders; OpenAlgo replaces them on first run with `secrets.token_hex(32)` and writes them back (the file is bind-mounted read-write). To set them yourself: `python3 -c "import secrets;print(secrets.token_hex(32))"` for each. Never reuse or commit.
- `HOST_SERVER='https://openalgo.<DOMAIN>'`
- `FLASK_HOST_IP='0.0.0.0'`, `WEBSOCKET_HOST='0.0.0.0'` (container-internal; not published)
- `WEBSOCKET_URL='wss://openalgo.<DOMAIN>/ws'` (Caddy strips `/ws`). Verify after first login that live-data pages connect; if not, check the browser console and adjust.
- Broker `BROKER_API_KEY` / `BROKER_API_SECRET` / `REDIRECT_URL` (`https://openalgo.<DOMAIN>/<broker>/callback`) per OpenAlgo docs for your broker.

**Memory limits.** trade-mcp, bt-service and Caddy have a Docker `mem_limit` (and an equal `memswap_limit`), so a runaway service is OOM-killed and restarted by `restart: unless-stopped` while the others keep running. Defaults, overridable in `.env`: `TRADE_MCP_MEM_LIMIT=1g`, `BT_MEM_LIMIT=1g` (with `BT_CPUS=1`), `CADDY_MEM_LIMIT=128m`; together 2176 MB, leaving the rest of a 4 GB VPS for OpenAlgo and the OS. trade-mcp worst case is base (about 100 MB measured) + `EXECUTE_MAX_CONCURRENT` x (64 MB memoryBytes + 32 MB WASM + 64 MB pending binding arguments) = 100 + 4 x 160 = 740 MB at the default of 4; add about 160 MB per extra run if you raise it. **OpenAlgo has no memory limit by default**: it holds the broker session and an OOM kill there is the failure we avoid. To cap it anyway, create `deploy/docker-compose.override.yml` with `services: {openalgo: {mem_limit: 1536m, memswap_limit: 1536m}}`; its 512 MB `shm_size` counts against the limit. Check with `docker stats --no-stream`; an OOM kill shows as exit code 137 or `docker inspect -f '{{.State.OOMKilled}}' <container>`.

## 6. Start
```
docker compose up -d --build     # from deploy/
docker compose ps
curl -s https://mcp.<DOMAIN>/healthz
```
Until you set the real `OPENALGO_API_KEY` in section 7, trade-mcp is up but `/readyz` returns 503 and calls to OpenAlgo fail; that is expected on this first start.

Check that the OpenAlgo container can read its mode-600 env file (unverified until you run this):
```
docker compose exec openalgo sh -c 'id; test -r /app/.env && echo readable'
```
If it does not print `readable`, `chown` `openalgo.env` to the uid shown by `id`, or use mode 640 with a group the container user is in, then `docker compose restart openalgo`.
`/healthz` is the liveness check. `GET /readyz` is the readiness check: no auth, internal only (Caddy does not route it, so run it inside the stack, e.g. `docker compose exec trade-mcp wget -qO- http://127.0.0.1:8787/readyz`), cached 5 s, 200 when ready or 503, body `{ok, checks:{openalgo, bt, auditWritable}}`. `bt` is `not_configured` when `BT_URL` is unset, which does not cause a 503.

## 7. First login
1. Open `https://openalgo.<DOMAIN>`, create the admin account, log in to your broker.
2. Generate an API key (API Key page). Put it in `deploy/.env` as `OPENALGO_API_KEY`, then `docker compose up -d`.
3. Set that key's order mode to `semi_auto` (optional human approval: orders wait in the Action Center until you approve in the UI). Do this from the UI session only.
4. Enable Analyzer mode (paper/sandbox) in OpenAlgo. Keep `MODE=paper` in `.env`.
5. Fill `marketHolidays` (needs the stack up and the real key; details and mapping rules: [docs/holidays.md](holidays.md)). **Untested, confirm on first deploy.** bt-service already has `OPENALGO_URL` and `OPENALGO_API_KEY`, and the script uses only the Python standard library, so run it there from `deploy/` (the script is not in the image, so mount the directory). bt-service runs as uid 1000 and the script writes a temp file and `risk.json.bak` next to the target, so use a writable scratch dir:
```
mkdir sync-work && cp sync_holidays.py risk.json sync-work/ && chown -R 1000 sync-work
docker compose run --rm --no-deps -v "$PWD/sync-work:/work" -w /work bt-service python sync_holidays.py --risk risk.json --dry-run
docker compose run --rm --no-deps -v "$PWD/sync-work:/work" -w /work bt-service python sync_holidays.py --risk risk.json
cat sync-work/risk.json > risk.json && rm -rf sync-work && docker compose restart trade-mcp
```
`cat >` keeps the bind-mounted file's inode, so the restart picks it up. Optional `--year <YYYY>`. Fallback, which sends the API key over the public path: from a host with Python, `OPENALGO_URL=https://openalgo.<DOMAIN> OPENALGO_API_KEY=<key> python3 sync_holidays.py --risk risk.json`.

## 8. Daily routine
Broker sessions expire daily (typically early morning IST). Each trading day log in to `https://openalgo.<DOMAIN>` and complete the broker login before the market opens. Check the Action Center for pending approvals.

## 9. Kill switch
Orders are refused while the file `/data/KILL` exists in the trade-mcp container (DATA_DIR=/data, volume `trade_mcp_data`):
```
docker compose exec trade-mcp touch /data/KILL     # halt
docker compose exec trade-mcp rm /data/KILL        # resume
```
Hard stop: `docker compose stop trade-mcp`. Also disable the OpenAlgo API key or log out the broker in the UI.

## 10. Going live checklist
- [ ] Paper (Analyzer) run for at least N = 5 trading days with no unexpected orders; review the audit log `/data/audit.jsonl` (`docker compose exec trade-mcp ls -l /data`).
- [ ] `risk.json` limits set conservatively (small qty/notional/daily loss).
- [ ] Static IP registered with broker / Delta; broker login works.
- [ ] `semi_auto` on for the first live days.
- [ ] Turn Analyzer mode off in OpenAlgo, set `MODE=live` in `deploy/.env`, `docker compose up -d trade-mcp`.
- [ ] Place one minimal order and confirm; know how to trigger the kill switch.

## 11. Backups
- Backups and restore: see [docs/backup.md](backup.md) (daily `deploy/backup.sh`, off-site rsync, restore drill).
- Every volume, plus `.env`, `openalgo.env` and `risk.json`, is covered. Backups contain secrets, so store them off-server and encrypted.

## 12. Updates and logs
```
git pull && git -C vendor/openalgo fetch   # re-pin to a reviewed commit
docker compose up -d --build
docker compose logs -f --tail=200 trade-mcp   # also: openalgo, bt-service, caddy
```

## 13. ChatGPT / claude.ai connectors (OAuth)
Off by default. To enable, in `deploy/.env` set `OAUTH_ENABLED=1`, `OAUTH_ISSUER_URL=https://mcp.<DOMAIN>`, and `OAUTH_PASSWORD_HASH` from:
```
node -e "const c=require('crypto');const s=c.randomBytes(16);console.log('scrypt:'+s.toString('hex')+':'+c.scryptSync(process.argv[1],s,64).toString('hex'))" 'your-password'
```
Optional: `OAUTH_ALLOWED_REDIRECT_HOSTS` (default `chatgpt.com,claude.ai,claude.com`). Then `docker compose up -d` and add the connector URL `https://mcp.<DOMAIN>/mcp`.
- Warning: never publish trade-mcp's port (8787) or make it reachable except through Caddy. The login rate limiter trusts exactly one proxy hop (X-Forwarded-For).
- Scheduled jobs: set `MCP_TOKEN_READONLY` (optional, >=24 chars, different from `MCP_TOKEN`) and give that token to them instead of `MCP_TOKEN`.

### Emergency: revoke all OAuth tokens
Use when a connector token may have leaked. Kills every OAuth access token, refresh token and pending code; registered clients and login rate-limit state are kept, so users just log in again.
```
docker compose stop trade-mcp && sleep 20 && docker compose run --rm --no-deps trade-mcp node dist/src/oauth/revoke-cli.js --force && docker compose start trade-mcp
```
From a local checkout the same tool is `npm run oauth:revoke-all -- --force` (with `DATA_DIR` set; same rules). If revoke exits 4, wait and rerun it; trade-mcp stays stopped until you run `docker compose start trade-mcp`.
- Do not run against a live server: it re-persists its in-memory store and undoes the revoke. `--force` means "trade-mcp is stopped". Do not use `docker compose exec`.
- Exit codes: 0 ok or nothing to revoke; 1 corrupt or wrong-shape store (untouched); 2 usage (missing `--force` or unknown argument); 3 unexpected error; 4 trade-mcp is running (live `DATA_DIR/trade-mcp.lock`; checked first, with or without `--force`).
- Lock heartbeat: the server refreshes the lock mtime every 5 s; a lock younger than 15 s counts as live whatever the container or hostname. After `docker compose stop trade-mcp`, wait ~20 s before running revoke (exit 4 until the heartbeat ages out). Keep the order stop, wait, run, start.
- Trade-off: after a crash or SIGKILL a NEW container may wait up to 15 s before it can start (compose `restart:` retries cover this); a same-container restart is immediate. If `DATA_DIR` is read-only or permission-denied, trade-mcp now refuses to start (message names the lock); on a full disk it warns and runs without a lock.
- Don't set a fixed `hostname:` for trade-mcp in compose; the DATA_DIR lock's same-host pid check relies on per-container hostnames (the 5 s heartbeat and 15 s live window still cover it).
- Then rotate `MCP_TOKEN` and `MCP_TOKEN_READONLY` in `deploy/.env` if exposed (static tokens are not affected).

## 14. Troubleshooting
See [docs/troubleshooting.md](troubleshooting.md).
