#!/usr/bin/env bash
# infra/backup/backup.sh — produce encrypted PITR artifacts to S3 (T17).
#
#   backup.sh base          one base backup (pg_basebackup -Ft -z -Xstream)
#   backup.sh receivewal    continuous WAL streaming + ship (the sidecar loop)
#   backup.sh wal-drain     stream + ship up to the current LSN, then exit (drill)
#   backup.sh ensure-slot   create the replication slot if missing
#
# Connection: standard libpq env (PGHOST/PGPORT/PGUSER/PGPASSWORD). The role
# needs REPLICATION. Encryption + S3 config come from lib.sh.
#
# WHY pg_receivewal (not archive_command): it is fully client-side — no server
# config change, and no silent archive_command-fails-disk-fills footgun. The
# replication slot provides backpressure/no-gap retention instead.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

# pg-tool execution seam. Production leaves BACKUP_PGRUN empty → pg_basebackup /
# pg_receivewal / psql run here on the host (or sidecar) over libpq/TCP. The
# restore DRILL sets it to `docker exec -u postgres <src>` so the very same
# invocations run INSIDE an isolated source container over its local socket —
# which trust-covers replication without touching any shared pg_hba.
PGRUN=()
[[ -n "${BACKUP_PGRUN:-}" ]] && read -ra PGRUN <<<"${BACKUP_PGRUN}"

ensure_slot() {
  # idempotent: create the physical slot only if absent.
  "${PGRUN[@]}" psql -v ON_ERROR_STOP=1 -tAc \
    "select 1 from pg_replication_slots where slot_name='${BACKUP_SLOT}'" \
    | grep -q 1 \
    || "${PGRUN[@]}" psql -v ON_ERROR_STOP=1 -tAc \
      "select pg_create_physical_replication_slot('${BACKUP_SLOT}')" >/dev/null
  log "slot ${BACKUP_SLOT} present"
}

base_backup() {
  local ts spool
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  # BACKUP_SPOOL lets the drill pin a path the source container and host both
  # see (a Colima-shared bind mount); production uses a private mktemp dir.
  spool="${BACKUP_SPOOL:-$(mktemp -d)}/base-${ts}"
  mkdir -p "${spool}"
  trap 'rm -rf "${spool}"' RETURN
  log "base backup → ${spool} (ts=${ts})"
  # -Xstream bundles the WAL generated DURING the backup, so each base is
  # independently restorable to its own end; archived WAL extends PITR forward.
  # -z gzip on the client; tar format → base.tar.gz + pg_wal.tar.gz.
  "${PGRUN[@]}" pg_basebackup -D "${spool}" -F tar -z -X stream -P -c fast
  for f in base.tar.gz pg_wal.tar.gz; do
    [[ -f "${spool}/${f}" ]] || die "expected ${f} from pg_basebackup"
    log "encrypt + upload base/${ts}/${f}"
    s3_put_enc "base/${ts}/${f}" <"${spool}/${f}"
  done
  # A tiny marker records WAL we must keep to restore this base (its redo seg).
  printf 'ts=%s\ncreated_utc=%s\n' "${ts}" "$(date -u +%FT%TZ)" \
    | s3_put_enc "base/${ts}/MANIFEST"
  log "base backup ${ts} complete"
}

# Stream WAL into a spool dir and ship each COMPLETE segment (no .partial) to
# S3 encrypted, then remove it locally. Shared by the continuous loop and the
# bounded drain.
ship_completed() {
  local spool="$1"
  shopt -s nullglob
  for seg in "${spool}"/[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]; do
    local name; name="$(basename "${seg}")"
    s3_exists "wal/${name}.age" && { rm -f "${seg}"; continue; }
    log "ship wal/${name}"
    s3_put_enc "wal/${name}.age" <"${seg}"
    rm -f "${seg}"
  done
  shopt -u nullglob
}

receivewal_loop() {
  ensure_slot
  local spool="${BACKUP_WAL_SPOOL:-/var/lib/backup/wal-spool}"
  mkdir -p "${spool}"
  log "pg_receivewal → ${spool} (slot ${BACKUP_SLOT}); shipping completed segments"
  # Run the receiver in the background; ship completed segments on an interval.
  "${PGRUN[@]}" pg_receivewal -D "${spool}" --slot="${BACKUP_SLOT}" --no-loop &
  local rx=$!
  trap 'kill ${rx} 2>/dev/null || true' EXIT
  while kill -0 "${rx}" 2>/dev/null; do
    ship_completed "${spool}"
    sleep "${BACKUP_SHIP_INTERVAL:-30}"
  done
  ship_completed "${spool}"
}

# Bounded variant for the drill: stream up to the server's current LSN, exit,
# ship. --endpos makes pg_receivewal stop deterministically rather than block.
wal_drain() {
  ensure_slot
  local spool endpos
  spool="${BACKUP_SPOOL:-$(mktemp -d)}/wal-drain"
  mkdir -p "${spool}"
  trap 'rm -rf "${spool}"' RETURN
  endpos="$("${PGRUN[@]}" psql -v ON_ERROR_STOP=1 -tAc 'select pg_current_wal_lsn()')"
  log "drain WAL up to ${endpos} (slot ${BACKUP_SLOT})"
  "${PGRUN[@]}" pg_receivewal -D "${spool}" --slot="${BACKUP_SLOT}" --no-loop --endpos="${endpos}" || true
  ship_completed "${spool}"
  log "wal-drain complete"
}

case "${1:-}" in
  base) base_backup ;;
  receivewal) receivewal_loop ;;
  wal-drain) wal_drain ;;
  ensure-slot) ensure_slot ;;
  *) die "usage: $0 {base|receivewal|wal-drain|ensure-slot}" ;;
esac
