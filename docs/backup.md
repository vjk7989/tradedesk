# Backup and restore

## What is backed up

- Volumes (as `<name>.tgz`): `openalgo_db`, `openalgo_log`, `openalgo_strategies`,
  `openalgo_keys`, `trade_mcp_data` (audit log, risk state, `oauth.json`).
- `paper_bot_data` as `paper_bot_data.db`: a consistent snapshot of `paper.db` (every
  paper decision, trade and equity point), not a tarball. See "paper-bot database".
- Skipped (rebuildable), listed with reasons in `EXCLUDED_VOLUMES` in `backup.sh`:
  `openalgo_tmp` (scratch), `caddy_data` (TLS certs and ACME state; Caddy re-issues
  them automatically), `caddy_config` (regenerated from the Caddyfile). Every named
  volume in `docker-compose.yml` must be in `VOLUMES` or `EXCLUDED_VOLUMES`.
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

The other volumes are archived live, so SQLite files there may be mid-write. For a
fully consistent copy run `docker compose stop` -> `backup.sh` -> `docker compose start`;
02:15 IST is outside market hours, so a short stop is fine. `paper_bot_data` does not
need the stop (below).

## paper-bot database
paper-bot opens `paper.db` in WAL mode (`journal_mode=WAL`, 5 s busy timeout), so
copying `paper.db` alone can miss committed data sitting in `paper.db-wal`, and copying
the three files separately can tear. `backup.sh` therefore uses the SQLite online backup
API, run inside the paper-bot container with its own Python (stdlib `sqlite3`, no image
change, no new tools): `docker compose exec -T paper-bot python -c ...` streams a
`Connection.backup()` copy, checked with `PRAGMA integrity_check`, to
`paper_bot_data.db`. The bot keeps running (WAL readers do not block its writer) and the
snapshot is transactionally consistent. Chosen over stopping the bot (downtime, and a
failed start would leave it down) and over copying db+wal+shm (not atomic).

If the bot is not running, `backup.sh` runs the same snapshot in a one-off container
from the same image (`compose run --rm --no-deps`); with no writer a snapshot is just as
consistent, and it replays any WAL left by an unclean stop (a plain file copy would
lose it). If the snapshot fails (image missing, db missing or corrupt) the script exits
non-zero and removes the partial backup, the same as a failing volume archive.

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
over existing files, so stale files may remain.

`paper_bot_data.db` is restored with a verify-then-swap sequence:
1. `PRAGMA integrity_check` runs on the snapshot in a one-off `python:3.12-slim`
   container (stdlib sqlite3, read-only mount) after the MANIFEST and running-stack checks, before
   any volume is extracted or anything is stopped. A bad snapshot aborts with
   "nothing changed", which is true: no volume, container or file was touched.
2. paper-bot is stopped if it is running (only possible with `--force`; without it
   the stack must already be down).
3. The snapshot is copied to `paper.db.new` in the volume (mode 600, owner uid 10001,
   the image's `bot` user), moved over `paper.db` with an atomic `mv`, and only then
   are the stale `paper.db-wal` and `paper.db-shm` removed.
4. If any step after the stop fails, a trap removes `paper.db.new`, restarts the bot
   if it was running, and the old `paper.db` is left intact.
5. The bot is started again if it was running before; if the stack was down (no
   `--force`), start it with `up -d`.

`backup.sh` passes `-p "$PREFIX"` to its compose calls, so the paper-bot snapshot always
uses the same volume prefix as the tar archives, whatever the deploy dir is named.

Existing `.env`, `openalgo.env`,
`risk.json` are moved to `<file>.pre-restore` (or `.pre-restore.<UTC timestamp>` if
that exists).

## Restore drill checklist
- [ ] Pick a backup at least a week old; copy it to a scratch host.
- [ ] Use a different `COMPOSE_PROJECT_NAME` so production volumes are untouched.
- [ ] Run `restore.sh`, start the stack, log in, check audit log and risk state.
- [ ] Confirm `.pre-restore` files exist; permissions are 600/700.
- [ ] Record the time taken; delete the scratch copy.
