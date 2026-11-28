#!/usr/bin/env bash
# Usage: deploy/restore.sh [--force] <BACKUP_DIR>
# Env: COMPOSE_PROJECT_NAME (default deploy), TRADEDESK_DEPLOY_DIR.
# Volumes are extracted over existing contents (not cleared first).
# Never print file contents.
set -euo pipefail
umask 077

DEPLOY_DIR="${TRADEDESK_DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
PREFIX="${COMPOSE_PROJECT_NAME:-deploy}"
VOLUMES=(openalgo_db openalgo_log openalgo_strategies openalgo_keys trade_mcp_data paper_bot_data)
SNAPSHOT_VOL="paper_bot_data"
FILES=("env:.env" "openalgo.env:openalgo.env" "risk.json:risk.json")

FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi
if [ $# -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: restore.sh [--force] <BACKUP_DIR>" >&2; exit 2
fi
BDIR="$(cd "$1" && pwd)"

if command -v sha256sum >/dev/null 2>&1; then
  check() { sha256sum -c --quiet MANIFEST.txt; }
else
  check() { shasum -a 256 -c --quiet MANIFEST.txt; }
fi

[ -f "$BDIR/MANIFEST.txt" ] || { echo "MANIFEST.txt missing in $BDIR" >&2; exit 1; }
# Manifest names must be plain file names; the folder must match the manifest exactly.
listed=()
while IFS= read -r line || [ -n "$line" ]; do
  if [[ ! "$line" =~ ^[0-9a-fA-F]{64}\ [\ \*](.+)$ ]]; then
    echo "malformed MANIFEST line; nothing changed" >&2; exit 1
  fi
  name="${BASH_REMATCH[1]}"
  if [[ "$name" == */* || "$name" == *\\* || "$name" == *..* || "$name" =~ ^[A-Za-z]: ]]; then
    echo "unsafe name in MANIFEST; nothing changed" >&2; exit 1
  fi
  [ -f "$BDIR/$name" ] || { echo "file listed in MANIFEST is missing; nothing changed" >&2; exit 1; }
  listed+=("$name")
done < "$BDIR/MANIFEST.txt"
for f in "$BDIR"/* "$BDIR"/.[!.]* "$BDIR"/..?*; do
  [ -e "$f" ] || continue
  b="${f##*/}"
  [ "$b" = "MANIFEST.txt" ] && continue
  found=0
  for n in "${listed[@]+"${listed[@]}"}"; do
    if [ "$n" = "$b" ]; then found=1; break; fi
  done
  [ "$found" -eq 1 ] || { echo "backup folder has a file not in MANIFEST; nothing changed" >&2; exit 1; }
done
if ! (cd "$BDIR" && check >/dev/null 2>&1); then
  echo "MANIFEST verification failed (mismatch or missing file); nothing changed" >&2
  exit 1
fi

if [ "$FORCE" -ne 1 ]; then
  running="$(docker compose -f "$DEPLOY_DIR/docker-compose.yml" ps -aq)"
  if [ -n "$running" ]; then
    echo "stack is running; stop it first (docker compose down) or pass --force" >&2
    exit 1
  fi
fi

for vol in "${VOLUMES[@]}"; do
  if [ "$vol" = "$SNAPSHOT_VOL" ]; then
    # Snapshot db (see backup.sh): stop the bot, replace paper.db, drop stale -wal/-shm
    # (they belong to the old db), then start the bot again if it was running.
    if [ -f "$BDIR/$vol.db" ]; then
      was_up="$(docker ps -q --filter "name=^${PREFIX}[-_]paper-bot[-_]")"
      [ -z "$was_up" ] || docker stop $was_up
      docker run --rm -v "${PREFIX}_${vol}:/dst" -v "$BDIR:/src:ro" alpine \
        sh -c "rm -f /dst/paper.db /dst/paper.db-wal /dst/paper.db-shm && cp /src/${vol}.db /dst/paper.db && chown 10001:10001 /dst /dst/paper.db && chmod 600 /dst/paper.db"
      [ -z "$was_up" ] || docker start $was_up
      echo "restored volume ${PREFIX}_${vol}"
    fi
    continue
  fi
  if [ -f "$BDIR/$vol.tgz" ]; then
    docker run --rm -v "${PREFIX}_${vol}:/dst" -v "$BDIR:/src:ro" alpine \
      sh -c "tar xzf /src/${vol}.tgz -C /dst"
    echo "restored volume ${PREFIX}_${vol}"
  fi
done

for pair in "${FILES[@]}"; do
  src="$BDIR/${pair%%:*}"
  dst="$DEPLOY_DIR/${pair##*:}"
  if [ -f "$src" ]; then
    if [ -e "$dst" ]; then
      bak="$dst.pre-restore"
      if [ -e "$bak" ]; then
        bak="$bak.$(date -u +%Y%m%dT%H%M%SZ)"
        n=1
        while [ -e "$bak" ]; do bak="$dst.pre-restore.$(date -u +%Y%m%dT%H%M%SZ).$n"; n=$((n + 1)); done
      fi
      mv "$dst" "$bak"
    fi
    cp "$src" "$dst"
    chmod 600 "$dst"
    echo "restored $dst"
  fi
done
