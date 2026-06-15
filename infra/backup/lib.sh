# infra/backup/lib.sh — shared config + S3 + client-side-encryption helpers for
# the T17 PITR pipeline. Sourced by backup.sh and restore.sh; never run direct.
#
# Encryption is asymmetric (age): the host carries only the PUBLIC recipient
# (BACKUP_AGE_RECIPIENT), so a host compromise cannot decrypt existing backups.
# The private identity (BACKUP_AGE_IDENTITY) is needed ONLY to restore and is
# held offline by the builder — never on the host, never in the backup itself
# (same custody rule as the Baileys session, SPEC "Never").
#
# Storage is AWS S3 (account/region of the EC2 host). Backups are encrypted
# client-side regardless of bucket SSE — defence in depth if a bucket ACL slips.

set -euo pipefail

# --- required config ---------------------------------------------------------
: "${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET (e.g. hh-assistant-backups-<account>)}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"

# Prefix lets one bucket hold multiple hosts/generations without collision.
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-pitr}"
readonly S3_BASE="s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}"

# Replication slot pg_receivewal consumes (retains WAL on the primary until
# shipped — that retention IS the no-gap guarantee, and the thing to monitor).
BACKUP_SLOT="${BACKUP_SLOT:-hh_backup}"

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf '[backup ERROR] %s\n' "$*" >&2; exit 1; }

# --- encryption indirection --------------------------------------------------
# age is the production default and the only path the drill exercises. The
# helpers fail loud rather than silently shipping plaintext.
need_age() { command -v age >/dev/null 2>&1 || die "age not installed (apt install age)"; }

# encrypt < plaintext > ciphertext
encrypt() {
  need_age
  : "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT (age public key) to encrypt}"
  age -r "${BACKUP_AGE_RECIPIENT}"
}

# decrypt < ciphertext > plaintext   (restore-only; needs the private identity)
decrypt() {
  need_age
  : "${BACKUP_AGE_IDENTITY:?set BACKUP_AGE_IDENTITY (path to the age private key) to restore}"
  [[ -f "${BACKUP_AGE_IDENTITY}" ]] || die "BACKUP_AGE_IDENTITY not found: ${BACKUP_AGE_IDENTITY}"
  age -d -i "${BACKUP_AGE_IDENTITY}"
}

# --- S3 helpers (stream through encryption, never write plaintext to disk) ----
# s3_put_enc <s3-relative-key>   reads plaintext on stdin, ships encrypted.
s3_put_enc() {
  local key="$1"
  encrypt | aws s3 cp - "${S3_BASE}/${key}" --only-show-errors
}

# s3_get_dec <s3-relative-key>   writes decrypted plaintext to stdout.
s3_get_dec() {
  local key="$1"
  aws s3 cp "${S3_BASE}/${key}" - --only-show-errors | decrypt
}

# s3_exists <s3-relative-key>
s3_exists() {
  aws s3 ls "${S3_BASE}/$1" >/dev/null 2>&1
}

# Latest base-backup timestamp dir under base/ (lexicographic == chronological,
# because the key is a zero-padded UTC stamp — see backup.sh).
latest_base_ts() {
  aws s3 ls "${S3_BASE}/base/" \
    | awk '/PRE/ {print $2}' | sed 's:/$::' | sort | tail -1
}
