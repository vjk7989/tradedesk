#!/usr/bin/env bash
# Usage: deploy/restore.sh [--force] <BACKUP_DIR>
# Env: COMPOSE_PROJECT_NAME (default deploy), TRADEDESK_DEPLOY_DIR.
# Volumes are extracted over existing contents (not cleared first).
# Never print file contents.
set -euo pipefail
umask 077

DEPLOY_DIR="${TRADEDESK_DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
PREFIX="${COMPOSE_PROJECT_NAME:-deploy}"
VOLUMES=(openalgo_db openalgo_log openalgo_strategies openalgo_keys trade_mcp_data)
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
if ! (cd "$BDIR" && check >/dev/null 2>&1); then
  echo "MANIFEST verification failed (mismatch or missing file); nothing changed" >&2
  exit 1
fi

if [ "$FORCE" -ne 1 ]; then
  running="$(docker compose -f "$DEPLOY_DIR/docker-compose.yml" ps -q)"
  if [ -n "$running" ]; then
    echo "stack is running; stop it first (docker compose down) or pass --force" >&2
    exit 1
  fi
fi

for vol in "${VOLUMES[@]}"; do
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
    if [ -e "$dst" ]; then mv "$dst" "$dst.pre-restore"; fi
    cp "$src" "$dst"
    chmod 600 "$dst"
    echo "restored $dst"
  fi
done
