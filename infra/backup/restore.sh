#!/usr/bin/env bash
# infra/backup/restore.sh — restore the encrypted PITR backups from S3 (T17).
#
#   restore.sh into <container-name>   restore latest base + all archived WAL
#                                      into a throwaway pgvector container and
#                                      recover; leaves it running for inspection
#   restore.sh drill                   self-asserting end-to-end PITR drill
#                                      (base + post-base WAL + restore + verify)
#
# Decryption needs the offline private identity (BACKUP_AGE_IDENTITY). Plaintext
# only ever lives in a mktemp dir we remove, and inside the scratch container.
#
# WHY a scratch container, not a bind mount: Postgres demands PGDATA be owned by
# its run user and chmod 700 — building the data dir INSIDE the container (as
# the postgres user) sidesteps host↔container uid skew. age/aws stay on the host.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

readonly RESTORE_IMAGE="${RESTORE_IMAGE:-pgvector/pgvector:pg17}"

restore_into() {
  local cname="$1"
  local ts; ts="$(latest_base_ts)"
  [[ -n "${ts}" ]] || die "no base backup found under ${S3_BASE}/base/"
  log "restoring base ${ts} into scratch container ${cname}"

  local stage; stage="$(mktemp -d)"
  trap '[[ -n "${stage:-}" ]] && rm -rf "${stage}"' RETURN
  s3_get_dec "base/${ts}/base.tar.gz" >"${stage}/base.tar.gz"
  s3_get_dec "base/${ts}/pg_wal.tar.gz" >"${stage}/pg_wal.tar.gz"
  mkdir -p "${stage}/wal"
  # Every archived segment since the slot was created — staged into pg_wal so
  # recovery replays from local files (no in-container restore_command/tooling).
  # (ls on an empty prefix exits 1; capture-first keeps pipefail from aborting.)
  local wal_list; wal_list="$(aws s3 ls "${S3_BASE}/wal/" 2>/dev/null || true)"
  echo "${wal_list}" | awk '{print $4}' | while read -r obj; do
    [[ -n "${obj}" ]] || continue
    s3_get_dec "wal/${obj}" >"${stage}/wal/${obj%.age}"
  done
  log "staged $(echo "${wal_list}" | grep -c . ) archived WAL object(s)"

  docker rm -f "${cname}" >/dev/null 2>&1 || true
  docker run -d --name "${cname}" --entrypoint sleep "${RESTORE_IMAGE}" infinity >/dev/null
  docker exec -u postgres "${cname}" mkdir -p /var/lib/postgresql/data /tmp/wal
  docker cp "${stage}/base.tar.gz" "${cname}:/tmp/base.tar.gz"
  docker cp "${stage}/pg_wal.tar.gz" "${cname}:/tmp/pg_wal.tar.gz"
  [[ -n "$(ls -A "${stage}/wal")" ]] && docker cp "${stage}/wal/." "${cname}:/tmp/wal/"
  # docker cp lands as root; hand the staging to postgres so the run-user can read.
  docker exec -u root "${cname}" chown -R postgres:postgres \
    /tmp/base.tar.gz /tmp/pg_wal.tar.gz /tmp/wal

  # Heredoc avoids %f/%p and single-quote escaping hell in the conf line.
  # restore_command serves the AUTHORITATIVE archived segments from /tmp/wal;
  # the base's bundled WAL is `cp -n`'d in only to fill any gap the archive
  # lacks, never to overwrite it (the base copy predates post-base writes).
  docker exec -i -u postgres "${cname}" bash -eus <<'INNER'
cd /var/lib/postgresql/data
tar xzf /tmp/base.tar.gz
chmod 700 /var/lib/postgresql/data
mkdir -p /tmp/basewal && tar xzf /tmp/pg_wal.tar.gz -C /tmp/basewal || true
cp -n /tmp/basewal/* /tmp/wal/ 2>/dev/null || true
# Archive recovery requires a restore_command even with WAL in pg_wal; serve
# the staged segments locally and promote at the end of available WAL.
cat >> postgresql.auto.conf <<'CONF'
restore_command = 'cp /tmp/wal/%f %p'
recovery_target_action = 'promote'
CONF
touch recovery.signal
pg_ctl -D /var/lib/postgresql/data -w -t 90 -l /tmp/restore.log start
INNER
  log "scratch container ${cname} recovered and running"
}

# Full PITR drill. Self-contained: provisions its OWN isolated source Postgres
# (a throwaway pgvector container) so it touches no shared dev DB, and drives
# the real backup.sh against it over the source's local socket (BACKUP_PGRUN) —
# replication trust-works on a fresh container with no pg_hba edits anywhere.
# Self-asserting: a post-base write must survive ONLY via archived WAL, proving
# PITR rather than just a base-backup snapshot.
SRC_IMAGE="${SRC_IMAGE:-pgvector/pgvector:pg17}"

# EXIT-trap teardown. Script-level (not drill-locals) and :- guarded, because
# `set -e` unwinds the function before the trap fires.
DRILL_SRC="" DRILL_SCRATCH="" DRILL_SPOOL=""
drill_cleanup() {
  if [[ "${BACKUP_DRILL_KEEP:-0}" == "1" ]]; then
    log "BACKUP_DRILL_KEEP=1 — leaving source/scratch containers, spool, and S3 for inspection"
    return
  fi
  docker rm -f "${DRILL_SRC:-}" "${DRILL_SCRATCH:-}" >/dev/null 2>&1 || true
  [[ -n "${DRILL_SPOOL:-}" ]] && rm -rf "${DRILL_SPOOL}"
  if [[ "${BACKUP_DRILL_KEEP_S3:-0}" != "1" ]]; then
    aws s3 rm "${S3_BASE}/" --recursive --only-show-errors || true
    log "drill S3 artifacts removed (set BACKUP_DRILL_KEEP_S3=1 to keep)"
  fi
}

drill() {
  local drilldb="hh_backup_drill"
  DRILL_SRC="hh-drill-src-$$"
  DRILL_SCRATCH="hh-drill-restore-$$"
  DRILL_SPOOL="$(mktemp -d "${HOME}/.hh-backup-drill.XXXXXX")" # Colima-shared (/Users)
  local src="${DRILL_SRC}" scratch="${DRILL_SCRATCH}" spool="${DRILL_SPOOL}"
  log "=== PITR restore drill starting (isolated source ${src}) ==="
  trap drill_cleanup EXIT

  # Isolated source: default superuser role `postgres`, trust auth, and the
  # spool bind-mounted at the SAME path the host sees so in-container
  # pg_basebackup output is readable host-side.
  docker run -d --name "${src}" -e POSTGRES_PASSWORD=drill \
    -e POSTGRES_HOST_AUTH_METHOD=trust -v "${spool}:${spool}" "${SRC_IMAGE}" >/dev/null

  local ex=(docker exec -u postgres "${src}")
  # Wait on a real query, not pg_isready: the postgres image bounces a temp
  # init server before the real one, and pg_isready can catch the wrong one.
  local ready=0
  for _ in $(seq 1 60); do
    "${ex[@]}" psql -tAc 'select 1' >/dev/null 2>&1 && { ready=1; break; }
    sleep 1
  done
  [[ "${ready}" == "1" ]] || die "source container ${src} never became ready"
  "${ex[@]}" psql -v ON_ERROR_STOP=1 -tAc "create database ${drilldb}" >/dev/null
  "${ex[@]}" psql -d "${drilldb}" -v ON_ERROR_STOP=1 -c \
    "create table restore_sentinel(id serial primary key, note text, created_at timestamptz default now())" >/dev/null
  local baseline="baseline-$(date -u +%s)"
  "${ex[@]}" psql -d "${drilldb}" -v ON_ERROR_STOP=1 -c \
    "insert into restore_sentinel(note) values ('${baseline}')" >/dev/null
  log "isolated source seeded; taking base backup via real backup.sh"

  # Drive the production backup.sh against the source over its socket.
  export BACKUP_PGRUN="docker exec -u postgres ${src}"
  export BACKUP_SPOOL="${spool}"
  "${HERE}/backup.sh" ensure-slot # slot before base ⇒ no WAL gap vs the base

  # Start the CONTINUOUS WAL receiver (real backup.sh receivewal) BEFORE the
  # base — exactly as production runs it. This is load-bearing: a receiver
  # started AFTER the base begins at a later segment and leaves a gap between
  # base-end and the first archived segment, so a post-base write that lands in
  # that gap is lost. Streaming from before the base guarantees contiguity.
  export BACKUP_WAL_SPOOL="${spool}/wal-spool" BACKUP_SHIP_INTERVAL=2
  "${HERE}/backup.sh" receivewal &
  local rx=$!
  sleep 2 # let the receiver attach to the current segment before the base

  "${HERE}/backup.sh" base

  # Post-base write — exists ONLY in archived WAL, never in the base tar.
  # (pg_basebackup -Xstream issues its own WAL switch at backup end, so this
  # row lands in the NEXT segment — capture which, then switch to complete it.)
  local sentinel="sentinel-$(date -u +%s)-${RANDOM}"
  "${ex[@]}" psql -d "${drilldb}" -v ON_ERROR_STOP=1 -c \
    "insert into restore_sentinel(note) values ('${sentinel}')" >/dev/null
  local sentinel_seg
  sentinel_seg="$("${ex[@]}" psql -v ON_ERROR_STOP=1 -tAc \
    "select pg_walfile_name(pg_current_wal_lsn())" | tr -d '[:space:]')"
  "${ex[@]}" psql -v ON_ERROR_STOP=1 -tAc "select pg_switch_wal()" >/dev/null
  log "post-base sentinel in WAL segment ${sentinel_seg}; waiting for it to ship"
  # Deterministic: wait until the sentinel's completed segment is actually in
  # S3, rather than racing a fixed sleep against the ship interval.
  local shipped=0
  for _ in $(seq 1 30); do
    if s3_exists "wal/${sentinel_seg}.age"; then shipped=1; break; fi
    sleep 1
  done
  kill "${rx}" 2>/dev/null || true
  wait "${rx}" 2>/dev/null || true
  [[ "${shipped}" == "1" ]] || die "sentinel WAL segment ${sentinel_seg} never shipped"

  restore_into "${scratch}"

  local rows note_present
  rows="$(docker exec -u postgres "${scratch}" psql -d "${drilldb}" -tAc \
    'select count(*) from restore_sentinel' | tr -d '[:space:]')"
  note_present="$(docker exec -u postgres "${scratch}" psql -d "${drilldb}" -tAc \
    "select count(*) from restore_sentinel where note='${sentinel}'" | tr -d '[:space:]')"
  log "restored: total sentinel rows=${rows}, post-base row present=${note_present}"

  local ok=1
  [[ "${rows}" == "2" ]] || { log "FAIL: expected 2 sentinel rows, got ${rows}"; ok=0; }
  [[ "${note_present}" == "1" ]] || { log "FAIL: post-base WAL did not replay — PITR broken"; ok=0; }

  if [[ "${ok}" == "1" ]]; then
    log "=== DRILL PASS: base + archived WAL restored; post-base write recovered ==="
  else
    die "=== DRILL FAILED ==="
  fi
}

case "${1:-}" in
  into) shift; restore_into "${1:?usage: restore.sh into <container-name>}" ;;
  drill) drill ;;
  *) die "usage: $0 {into <container-name>|drill}" ;;
esac
