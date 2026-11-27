# Backup and restore

Scripts: `deploy/backup.sh` and `deploy/restore.sh`.

## What is backed up

- Volumes (as `<name>.tgz`): `openalgo_db`, `openalgo_log`, `openalgo_strategies`,
  `openalgo_keys`, `trade_mcp_data` (audit log, risk state, `oauth.json`).
  Skipped: `openalgo_tmp`, `caddy_data`, `caddy_config` (rebuildable).
- Files from `deploy/` if present: `.env` (saved as `env`), `openalgo.env`, `risk.json`.
- `MANIFEST.txt` with sha256 of every file.

**The whole backup is secret.** It holds broker/API keys, OAuth client secrets and
the audit log. Files are mode 600, directories 700. Keep it that way off-site too.

## Backup

`deploy/backup.sh [DEST_DIR]` writes `DEST/<UTC timestamp>/`. Default DEST is
`/var/backups/tradedesk`. `KEEP` (default 14) newest backups are kept, older
timestamped dirs are deleted (KEEP must be >= 1). `COMPOSE_PROJECT_NAME` (default `deploy`) sets the
volume prefix. `TRADEDESK_DEPLOY_DIR` overrides where the env/risk files are read.

## Cron (daily 02:15 IST)

If the host clock is UTC, 02:15 IST is 20:45 UTC the previous day:

    45 20 * * * /opt/tradedesk/deploy/backup.sh >> /var/log/tradedesk-backup.log 2>&1

On a non-UTC host, set the zone in the crontab instead:

    CRON_TZ=Asia/Kolkata
    15 2 * * * /opt/tradedesk/deploy/backup.sh >> /var/log/tradedesk-backup.log 2>&1

## Off-site copy (rsync over SSH)

    rsync -a --chmod=D700,F600 -e ssh /var/backups/tradedesk/ backup@other-host:/srv/tradedesk-backups/

Run it from cron after the backup. Use a dedicated SSH key, and keep the
destination readable by that user only.

## Restore

1. `docker compose -f deploy/docker-compose.yml down`
2. `deploy/restore.sh /var/backups/tradedesk/<timestamp>`
3. `docker compose -f deploy/docker-compose.yml up -d`

The script verifies every MANIFEST hash first and aborts on any mismatch. It refuses
to run while containers exist unless `--force` is given. Volumes are NOT cleared
first: the archive is extracted over existing files, so stale files may remain.
Existing `.env`, `openalgo.env`, `risk.json` are moved to `<file>.pre-restore`.

## Restore drill checklist

- [ ] Pick a backup at least a week old; copy it to a scratch host.
- [ ] `sha256sum -c MANIFEST.txt` inside the dir passes.
- [ ] Use a different `COMPOSE_PROJECT_NAME` so production volumes are untouched.
- [ ] Run `restore.sh`, start the stack, log in, check the audit log and risk state.
- [ ] Confirm `.pre-restore` files exist and permissions are 600/700.
- [ ] Record date and time taken; delete the scratch copy securely.
