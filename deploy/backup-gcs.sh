#!/usr/bin/env bash
# Usage: deploy/backup-gcs.sh
# Runs backup.sh into a private temp dir, encrypts the result with age (public-key
# recipient only; the private key is never on this host) and uploads ONLY the
# encrypted archive to gs://$BACKUP_BUCKET/$BACKUP_PREFIX/<UTC timestamp>.tar.age.
# Env: BACKUP_BUCKET (required, bucket name without gs://),
#      AGE_RECIPIENTS_FILE (required, file of age public recipients),
#      BACKUP_PREFIX (default tradedesk), COMPOSE_PROJECT_NAME and
#      TRADEDESK_DEPLOY_DIR (passed through to backup.sh),
#      TRADEDESK_BACKUP_SH (override of backup.sh path; for tests).
# Exit codes as backup.sh: 2 = bad configuration/usage, 1 = runtime failure.
# The backup contains secrets. Never print file contents or key material.
set -euo pipefail
umask 077

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SH="${TRADEDESK_BACKUP_SH:-$SELF_DIR/backup.sh}"
PREFIX="${BACKUP_PREFIX:-tradedesk}"
AGE_MAGIC="age-encryption.org/v1"

die()  { echo "backup-gcs: $*" >&2; exit 1; }
conf() { echo "backup-gcs: $*" >&2; exit 2; }

[ -n "${BACKUP_BUCKET:-}" ] || conf "BACKUP_BUCKET is not set (bucket name, no gs:// prefix)"
case "$BACKUP_BUCKET" in gs://*|*/*) conf "BACKUP_BUCKET must be a bare bucket name";; esac
[ -n "${AGE_RECIPIENTS_FILE:-}" ] || conf "AGE_RECIPIENTS_FILE is not set (file with age public recipient(s))"
case "$PREFIX" in ''|/*|*/|*..*|*[!A-Za-z0-9._/-]*) conf "BACKUP_PREFIX must be a relative path of [A-Za-z0-9._/-]";; esac
command -v age >/dev/null 2>&1 || conf "age is not installed"
command -v gcloud >/dev/null 2>&1 || conf "gcloud is not installed"
[ -f "$AGE_RECIPIENTS_FILE" ] && [ -r "$AGE_RECIPIENTS_FILE" ] || conf "recipient file is not a readable file: $AGE_RECIPIENTS_FILE"
[ -s "$AGE_RECIPIENTS_FILE" ] || conf "recipient file is empty: $AGE_RECIPIENTS_FILE"
[ -f "$BACKUP_SH" ] || conf "backup.sh not found: $BACKUP_SH"

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf -- "$TMP"' EXIT   # plaintext and ciphertext both live only here

# The ONLY path to gcloud. Refuses anything that is not an age-encrypted .age file.
upload_encrypted() {
  local file="$1" dest="$2" magic
  case "$file" in *.tar.age) ;; *) die "refusing to upload non-.age file";; esac
  case "$dest" in gs://*.tar.age) ;; *) die "refusing non-.age destination";; esac
  [ -f "$file" ] || die "encrypted file missing"
  magic="$(head -c "${#AGE_MAGIC}" "$file" 2>/dev/null || true)"
  [ "$magic" = "$AGE_MAGIC" ] || die "output is not age-encrypted (bad header); NOT uploading"
  gcloud storage cp "$file" "$dest" >/dev/null
}

PLAIN="$TMP/plain"; OUT="$TMP/out"
mkdir "$PLAIN" "$OUT"
chmod 700 "$PLAIN" "$OUT"

"$BACKUP_SH" "$PLAIN" >/dev/null || die "backup.sh failed; nothing uploaded"

BDIR=""; n=0
for d in "$PLAIN"/*/; do
  [ -d "$d" ] || continue
  BDIR="${d%/}"; n=$((n + 1))
done
[ "$n" -eq 1 ] || die "expected exactly one backup dir from backup.sh, found $n"
STAMP="${BDIR##*/}"
ENC="$OUT/$STAMP.tar.age"

# Plaintext tar goes straight into the encryptor via a pipe; never to a file.
if ! tar -C "$BDIR" -cf - . | age -R "$AGE_RECIPIENTS_FILE" -o "$ENC"; then
  rm -f -- "$ENC"
  die "encryption failed; nothing uploaded"
fi

DEST="gs://$BACKUP_BUCKET/$PREFIX/$STAMP.tar.age"
upload_encrypted "$ENC" "$DEST" || die "upload failed"
echo "backup-gcs: uploaded encrypted backup to $DEST"
