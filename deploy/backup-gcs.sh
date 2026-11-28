#!/usr/bin/env bash
# Usage: deploy/backup-gcs.sh
# Runs backup.sh into a private temp dir, encrypts the result with age (public-key
# recipient only; the private key is never on this host) and uploads ONLY the
# encrypted archive to gs://$BACKUP_BUCKET/$BACKUP_PREFIX/<UTC timestamp>.tar.age.
# Env: BACKUP_BUCKET (required, bucket name without gs://),
#      AGE_RECIPIENTS_FILE (required, file of age public recipients),
#      BACKUP_PREFIX (default tradedesk), COMPOSE_PROJECT_NAME and
#      TRADEDESK_DEPLOY_DIR (passed through to backup.sh),
#      BACKUP_WORKDIR (default /var/lib/tradedesk-backup; absolute, not /; created 700 or must already be an owned 700 dir).
#      TRADEDESK_BACKUP_SH: TEST-ONLY override of the backup.sh path; not part of the
#      supported interface and deliberately not documented in docs/backup.md.
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
# Only plain age X25519 recipients (age1 + 58 bech32 chars) or comments: age would otherwise
# run age-plugin-* binaries from PATH for plugin recipients.
if grep -qvE '^(age1[02-9ac-hj-np-z]{58}|#.*|[[:space:]]*)$' "$AGE_RECIPIENTS_FILE"; then
  conf "recipient file may contain only plain age1... recipients, comments and blank lines"
fi
grep -qE '^age1[02-9ac-hj-np-z]{58}$' "$AGE_RECIPIENTS_FILE" || conf "recipient file has no age1... recipient"
[ -f "$BACKUP_SH" ] || conf "backup.sh not found: $BACKUP_SH"

# Root-only work dir on disk (not RAM-backed /tmp) so a SIGKILL/OOM/power loss cannot leave
# plaintext in memory-backed storage. Stale dirs from killed runs are swept after a day.
[ "${BACKUP_WORKDIR-x}" != "" ] || conf "BACKUP_WORKDIR is set but empty"
WORKDIR="${BACKUP_WORKDIR:-/var/lib/tradedesk-backup}"
case "$WORKDIR" in /*) ;; *) conf "BACKUP_WORKDIR must be an absolute path";; esac
case "$WORKDIR" in /|//*) conf "BACKUP_WORKDIR must not be /";; esac
if [ -d "$WORKDIR" ]; then
  # Never chmod a directory this script did not create: require it to be already private.
  [ -O "$WORKDIR" ] || conf "work dir $WORKDIR is not owned by the current user"
  [ "$(stat -c %a "$WORKDIR")" = 700 ] || conf "existing work dir $WORKDIR must have mode 700 (it is not changed automatically)"
else
  # umask 077 (set above) makes the new dir mode 700; chmod is never run on a pre-existing dir.
  mkdir -p "$WORKDIR" 2>/dev/null || conf "cannot create work dir $WORKDIR (run as root or set BACKUP_WORKDIR)"
fi
find "$WORKDIR" -mindepth 1 -maxdepth 1 -type d -name 'tradedesk-gcs.*' -mtime +0 -exec rm -rf {} + 2>/dev/null || true
TMP="$(mktemp -d "$WORKDIR/tradedesk-gcs.XXXXXX")"
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
  # objectCreator cannot get/delete, so parallel composite uploads (default on for files
  # >= 150 MiB: they compose and delete temp parts) would fail. Force plain uploads.
  # Source: Google Cloud docs, "Parallel composite uploads" (gcloud property
  # storage/parallel_composite_upload_enabled; env CLOUDSDK_<SECTION>_<PROPERTY>).
  export CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False
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
