# Backup and restore

## What is backed up

- Volumes (as `<name>.tgz`): `openalgo_db`, `openalgo_log`, `openalgo_strategies`,
  `openalgo_keys`, `trade_mcp_data` (audit log, risk state, `oauth.json`).
  Skipped (rebuildable): `openalgo_tmp`, `caddy_data`, `caddy_config`.
- Files from `deploy/` if present: `.env` (saved as `env`), `openalgo.env`, `risk.json`.
- `MANIFEST.txt` (sha256 of every file).

**The whole backup is secret** (API keys, OAuth client secrets, audit log). Files
are mode 600, directories 700; keep it so off-site.

## Backup
`deploy/backup.sh [DEST_DIR]` writes `DEST/<UTC timestamp>/` (built as a hidden
`.<timestamp>.partial` dir, renamed when complete; stale partials over 1 day old are
removed). Default DEST is `/var/backups/tradedesk`. `KEEP` (default 14, must be >= 1)
newest backups are kept, older timestamped dirs are deleted. A lock stops concurrent
runs. `COMPOSE_PROJECT_NAME` (default `deploy`) sets the volume prefix.
`TRADEDESK_DEPLOY_DIR` overrides where the env/risk files are read.

Volumes are archived live, so SQLite may be mid-write. For a consistent copy run
`docker compose stop` -> `backup.sh` -> `docker compose start`; 02:15 IST is outside
market hours, so a short stop is fine.

## Cron (daily 02:15 IST)
Host clock UTC (02:15 IST = 20:45 UTC the previous day):

    45 20 * * * /opt/tradedesk/deploy/backup.sh >> /var/log/tradedesk-backup.log 2>&1

Otherwise set the zone in the crontab:

    CRON_TZ=Asia/Kolkata
    15 2 * * * /opt/tradedesk/deploy/backup.sh >> /var/log/tradedesk-backup.log 2>&1

## Off-site copy (rsync over SSH)
    rsync -a --delete --exclude '.*.partial' --chmod=D700,F600 -e ssh /var/backups/tradedesk/ backup@other-host:/srv/tradedesk-backups/

`--delete` mirrors local retention off-site (drop it to keep everything). Use a
dedicated SSH key.

## Restore
1. `docker compose -f deploy/docker-compose.yml down`, then
   `deploy/restore.sh /var/backups/tradedesk/<timestamp>`, then `... up -d`.

The script first checks that every MANIFEST entry is a plain file name, exists and
matches its hash, and that the folder has no unlisted files. Any problem aborts
before anything changes. It refuses if any container exists (`ps -aq`, running or
stopped) unless `--force`. Volumes are NOT cleared first: the archive is extracted
over existing files, so stale files may remain. Existing `.env`, `openalgo.env`,
`risk.json` are moved to `<file>.pre-restore` (or `.pre-restore.<UTC timestamp>` if
that exists).

## Restore drill checklist
- [ ] Pick a backup at least a week old; copy it to a scratch host.
- [ ] Use a different `COMPOSE_PROJECT_NAME` so production volumes are untouched.
- [ ] Run `restore.sh`, start the stack, log in, check audit log and risk state.
- [ ] Confirm `.pre-restore` files exist; permissions are 600/700.
- [ ] Record the time taken; delete the scratch copy.
