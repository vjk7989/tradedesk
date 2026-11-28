#!/usr/bin/env bash
# Usage: deploy/backup.sh [DEST_DIR]   (default /var/backups/tradedesk)
# Env: KEEP (default 14), COMPOSE_PROJECT_NAME (default deploy),
#      TRADEDESK_DEPLOY_DIR (override of the script's own directory).
# The backup contains secrets. Never print file contents.
set -euo pipefail
umask 077

DEPLOY_DIR="${TRADEDESK_DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
DEST="${1:-/var/backups/tradedesk}"
KEEP="${KEEP:-14}"
PREFIX="${COMPOSE_PROJECT_NAME:-deploy}"
VOLUMES=(openalgo_db openalgo_log openalgo_strategies openalgo_keys trade_mcp_data paper_bot_data)
# paper_bot_data holds a live WAL-mode SQLite db, so it is not tar'd: it is saved as a
# consistent snapshot (sqlite backup API run inside paper-bot) named paper_bot_data.db.
SNAPSHOT_VOL="paper_bot_data"
# Every named volume in docker-compose.yml must be in VOLUMES or here (name:reason).
# shellcheck disable=SC2034 # read by the guard test, not by this script
EXCLUDED_VOLUMES=(
  "openalgo_tmp:scratch space, rebuilt by the app"
  "caddy_data:TLS certs and ACME state, re-issued automatically"
  "caddy_config:Caddy autosaved config, regenerated from the Caddyfile"
)
# Run inside the paper-bot container: online-consistent copy of paper.db to stdout.
PYSNAP='import os,sqlite3,sys,tempfile
p=os.path.join(os.environ.get("DATA_DIR","/data"),"paper.db")
fd,tmp=tempfile.mkstemp(suffix=".db"); os.close(fd)
try:
    s=sqlite3.connect("file:"+p+"?mode=rw",uri=True,timeout=30)
    t=sqlite3.connect(tmp)
    s.backup(t)
    ok=t.execute("PRAGMA integrity_check").fetchone()[0]
    t.close(); s.close()
    if ok!="ok": sys.exit("integrity_check failed")
    with open(tmp,"rb") as f:
        while True:
            c=f.read(1<<20)
            if not c: break
            sys.stdout.buffer.write(c)
    sys.stdout.buffer.flush()
finally:
    os.remove(tmp)'
COMPOSE=(docker compose -p "$PREFIX" -f "$DEPLOY_DIR/docker-compose.yml")
# source file (in deploy dir) : name inside the backup
FILES=(".env:env" "openalgo.env:openalgo.env" "risk.json:risk.json")

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$@"; }
else
  sha() { shasum -a 256 "$@"; }
fi

case "$KEEP" in ''|*[!0-9]*) echo "KEEP must be an integer >= 1" >&2; exit 2;; esac
if [ "$((10#$KEEP))" -lt 1 ]; then echo "KEEP must be an integer >= 1" >&2; exit 2; fi
KEEP=$((10#$KEEP))

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$DEST/$STAMP"
BDIR="$DEST/.$STAMP.partial"
LOCKDIR=""
cleanup() {
  if [ -z "${PARTIAL_DONE:-}" ] && [ -n "$BDIR" ] && [ -d "$BDIR" ]; then rm -rf -- "$BDIR"; fi
  if [ -n "$LOCKDIR" ]; then rmdir "$LOCKDIR" 2>/dev/null || true; fi
}
trap cleanup EXIT

# Lock against concurrent runs: flock on DEST itself, else a mkdir lock dir.
if command -v flock >/dev/null 2>&1; then
  exec 9<"$DEST"
  flock -n 9 || { echo "another backup is running" >&2; BDIR=""; exit 1; }
else
  mkdir "$DEST/.backup.lock" 2>/dev/null || { echo "another backup is running" >&2; BDIR=""; exit 1; }
  LOCKDIR="$DEST/.backup.lock"
fi

# Remove stale partial dirs (older than 1 day) left by killed runs.
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '.*.partial' -mtime +0 -exec rm -rf {} +

[ ! -e "$FINAL" ] || { echo "backup $FINAL already exists" >&2; BDIR=""; exit 1; }
mkdir "$BDIR"
chmod 700 "$BDIR"

for vol in "${VOLUMES[@]}"; do
  if [ "$vol" = "$SNAPSHOT_VOL" ]; then
    # Running bot: exec into it. Stopped bot: one-off container from the same image
    # (no other writer, so the snapshot is consistent and replays any leftover WAL).
    if [ -n "$("${COMPOSE[@]}" ps -q --status running paper-bot)" ]; then
      "${COMPOSE[@]}" exec -T paper-bot python -c "$PYSNAP" > "$BDIR/${vol}.db"
    else
      "${COMPOSE[@]}" run --rm --no-deps -T paper-bot python -c "$PYSNAP" > "$BDIR/${vol}.db"
    fi
    continue
  fi
  docker run --rm -v "${PREFIX}_${vol}:/src:ro" -v "$BDIR:/dst" alpine \
    sh -c "tar czf /dst/${vol}.tgz -C /src . && chown $(id -u):$(id -g) /dst/${vol}.tgz"
done

for pair in "${FILES[@]}"; do
  src="$DEPLOY_DIR/${pair%%:*}"
  if [ -f "$src" ]; then
    cp "$src" "$BDIR/${pair##*:}"
  fi
done

(
  cd "$BDIR"
  : > MANIFEST.txt
  for f in *; do
    [ "$f" = "MANIFEST.txt" ] && continue
    sha "$f" >> MANIFEST.txt
  done
)
chmod 600 "$BDIR"/*
chmod 700 "$BDIR"
mv "$BDIR" "$FINAL"
BDIR="$FINAL"
PARTIAL_DONE=1

# Retention: newest KEEP timestamped dirs survive.
all=()
for d in "$DEST"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z; do
  [ -d "$d" ] && all+=("${d##*/}")
done
old=()
while IFS= read -r d; do
  [ -n "$d" ] && old+=("$d")
done < <(printf '%s\n' "${all[@]}" | sort -r | tail -n +"$((KEEP + 1))")
for d in "${old[@]+"${old[@]}"}"; do
  rm -rf -- "${DEST:?}/$d"
done

echo "backup written: $BDIR ($(find "$BDIR" -type f | wc -l | tr -d ' ') files, pruned ${#old[@]})"
