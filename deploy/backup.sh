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
VOLUMES=(openalgo_db openalgo_log openalgo_strategies openalgo_keys trade_mcp_data)
# source file (in deploy dir) : name inside the backup
FILES=(".env:env" "openalgo.env:openalgo.env" "risk.json:risk.json")

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$@"; }
else
  sha() { shasum -a 256 "$@"; }
fi

case "$KEEP" in ''|*[!0-9]*|0) echo "KEEP must be an integer >= 1" >&2; exit 2;; esac

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$DEST/$STAMP"
BDIR="$DEST/.$STAMP.partial"
[ ! -e "$FINAL" ] || { echo "backup $FINAL already exists" >&2; exit 1; }
trap '[ -d "$BDIR" ] && rm -rf -- "$BDIR"' EXIT
mkdir "$BDIR"
chmod 700 "$BDIR"

for vol in "${VOLUMES[@]}"; do
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
trap - EXIT
BDIR="$FINAL"

# Retention: newest KEEP timestamped dirs survive.
old=()
while IFS= read -r d; do
  old+=("$d")
done < <(find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z' -printf '%f\n' | sort -r | tail -n +"$((KEEP + 1))")
for d in "${old[@]+"${old[@]}"}"; do
  rm -rf -- "${DEST:?}/$d"
done

echo "backup written: $BDIR ($(find "$BDIR" -type f | wc -l | tr -d ' ') files, pruned ${#old[@]})"
