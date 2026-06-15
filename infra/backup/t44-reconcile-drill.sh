#!/usr/bin/env bash
# infra/backup/t44-reconcile-drill.sh — the T44 gate: PROVE the recovery-runbook
# external-effect reconciliation end to end, against REAL S3 and the REAL Google
# Calendar wire.
#
# It builds the exact timeline the runbook (§4, "The restore drill") describes:
#
#   PRE-base : an *approved* pending_actions row (action A) + a baseline
#              at-least-once sent_log row.
#   base     : pg_basebackup of that state (real backup.sh → encrypted → S3).
#   POST-base: the effects that "already left the box" — A flips to *executed*,
#              one at-most-once + one at-least-once sent_log row land, AND a REAL
#              Google event with id hh+sha256(A) is created. None are in the base.
#   restore  : base-only recovery into a scratch container = the DB rewound to
#              BEFORE the post-base effects.
#   reconcile: (4c) A is back to *approved* (the executed flip rewound);
#              (4a) the post-base sent_log rows are ABSENT (the rewound window);
#              (4b) re-execute A → re-derive the SAME id → Google 409 → folded to
#                   already-exists → the window still holds exactly ONE event.
#
# Isolation & blast radius:
#   * an ISOLATED source Postgres (touches no real DB; mirrors restore.sh drill);
#   * a DRILL-SCOPED S3 prefix (never the production `pitr/`), purged on exit;
#   * an EPHEMERAL age keypair (the production private identity is offline and
#     not needed — encrypt + decrypt both happen within this one run);
#   * a far-future calendar slot, prechecked empty, deleted on exit.
#
# Run on the dev Mac (Colima) with .env present (GOOGLE_SA_KEY_B64, AWS creds)
# and AWS credentials configured for the backup account:
#   BACKUP_S3_BUCKET=hh-assistant-backups-001467466089 infra/backup/t44-reconcile-drill.sh
# The calendar leg reads .env itself via `node --env-file`; the bash side needs
# only BACKUP_S3_BUCKET + ambient AWS creds. Real S3 + real Google writes —
# never CI; ask-first (SPEC). Self-cleaning (T44_DRILL_KEEP=1 to retain).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"

log() { printf '[t44 %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf '[t44 ERROR] %s\n' "$*" >&2; exit 1; }

: "${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET (e.g. hh-assistant-backups-001467466089)}"
SRC_IMAGE="${SRC_IMAGE:-pgvector/pgvector:pg17}"

# Drill-scoped so it can NEVER read or clobber production PITR data under pitr/.
export BACKUP_S3_PREFIX="t44drill-$(date -u +%Y%m%dT%H%M%SZ)-$$"

# Ephemeral age keypair: the host-held production key is the PUBLIC recipient
# only and the private identity is offline; a self-contained drill needs both,
# so it mints its own throwaway pair. Same code path as production (lib.sh age).
DRILL_DIR="$(mktemp -d "${HOME}/.hh-t44-drill.XXXXXX")" # Colima-shared (/Users)
AGE_KEY="${DRILL_DIR}/age.key"
age-keygen -o "${AGE_KEY}" 2>"${DRILL_DIR}/age.pub"
export BACKUP_AGE_IDENTITY="${AGE_KEY}"
export BACKUP_AGE_RECIPIENT="$(grep -oE 'age1[0-9a-z]+' "${DRILL_DIR}/age.pub" | head -1)"
[[ -n "${BACKUP_AGE_RECIPIENT}" ]] || die "could not parse age recipient"

# shellcheck source=lib.sh
source "${HERE}/lib.sh" # gives S3_BASE (with our drill prefix), s3_get_dec, etc.

DRILL_SRC="hh-t44-src-$$"
DRILL_SCRATCH="hh-t44-restore-$$"
SPOOL="${DRILL_DIR}/spool"
DRILLDB="hh_t44_drill"
ACTION_ID="t44-$(date -u +%s)-${RANDOM}"
CREATED_EVENT_ID=""

# Far-future slot (~300d out, distinctive minute), prechecked empty below.
if SLOT_START="$(date -u -v+300d +%Y-%m-%dT06:17:00Z 2>/dev/null)"; then :; # BSD/macOS
else SLOT_START="$(date -u -d '+300 days' +%Y-%m-%dT06:17:00Z)"; fi          # GNU/Linux
SLOT_END="${SLOT_START%T*}T07:17:00Z"

caleffect() { node --env-file="${REPO}/.env" "${HERE}/t44-calendar-effect.ts" "$@"; }

cleanup() {
  local code=$?
  if [[ "${T44_DRILL_KEEP:-0}" == "1" ]]; then
    log "T44_DRILL_KEEP=1 — leaving containers, S3 (${S3_BASE}), and ${DRILL_DIR}"
    return
  fi
  [[ -n "${CREATED_EVENT_ID}" ]] && { log "cleanup: deleting drill calendar event"; caleffect delete "${CREATED_EVENT_ID}" || true; }
  docker rm -f "${DRILL_SRC}" "${DRILL_SCRATCH}" >/dev/null 2>&1 || true
  aws s3 rm "${S3_BASE}/" --recursive --only-show-errors >/dev/null 2>&1 || true
  rm -rf "${DRILL_DIR}"
  log "cleanup done (exit ${code})"
}
trap cleanup EXIT

# -i so a heredoc on stdin reaches psql (docker exec drops stdin without it);
# harmless for the -c argv calls.
sql_src() { docker exec -i -u postgres "${DRILL_SRC}" psql -d "${DRILLDB}" -v ON_ERROR_STOP=1 "$@"; }
sql_scratch() { docker exec -u postgres "${DRILL_SCRATCH}" psql -d "${DRILLDB}" -tAc "$1" | tr -d '[:space:]'; }

log "=== T44 reconciliation drill ==="
log "action_id=${ACTION_ID}  slot=${SLOT_START}  s3=${S3_BASE}"

# --- 0. Calendar precheck BEFORE any state change ---------------------------
caleffect precheck "${ACTION_ID}" "${SLOT_START}"

# --- 1. Isolated source Postgres + the two tables we reconcile --------------
docker run -d --name "${DRILL_SRC}" -e POSTGRES_PASSWORD=drill \
  -e POSTGRES_HOST_AUTH_METHOD=trust -v "${DRILL_DIR}:${DRILL_DIR}" "${SRC_IMAGE}" >/dev/null
for _ in $(seq 1 60); do
  docker exec -u postgres "${DRILL_SRC}" psql -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec -u postgres "${DRILL_SRC}" psql -v ON_ERROR_STOP=1 -tAc "create database ${DRILLDB}" >/dev/null
# Verbatim subset of migration 0001 — only the tables reconciliation reads.
sql_src <<SQL >/dev/null
CREATE TABLE pending_actions (
  action_id text PRIMARY KEY,
  conversation_id text NOT NULL,
  tool_call jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','executed','expired','stale')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE sent_log (
  idempotency_key text PRIMARY KEY,
  conversation_id text NOT NULL,
  delivery_class text NOT NULL CHECK (delivery_class IN ('at-least-once','at-most-once')),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SQL

# --- 2. PRE-base state: approved action + a baseline at-least-once send ------
sql_src -c "INSERT INTO pending_actions(action_id, conversation_id, tool_call, status, expires_at)
  VALUES ('${ACTION_ID}', 'conv-t44', '{\"name\":\"create_calendar_event\",\"args\":{\"owner\":\"husband\"}}', 'approved', now() + interval '12 hours')" >/dev/null
sql_src -c "INSERT INTO sent_log(idempotency_key, conversation_id, delivery_class, body)
  VALUES ('baseline-reminder-${ACTION_ID}', 'conv-t44', 'at-least-once', '{\"text\":\"pre-base\"}')" >/dev/null
log "pre-base: approved action + baseline at-least-once sent_log row"

# --- 3. Base backup (real backup.sh → encrypted → S3) -----------------------
export BACKUP_PGRUN="docker exec -u postgres ${DRILL_SRC}"
export BACKUP_SPOOL="${SPOOL}"
mkdir -p "${SPOOL}"
"${HERE}/backup.sh" base
log "base backup shipped"

# --- 4. POST-base effects (exist only after the base = the rewound window) ---
sql_src -c "UPDATE pending_actions SET status='executed' WHERE action_id='${ACTION_ID}'" >/dev/null
sql_src -c "INSERT INTO sent_log(idempotency_key, conversation_id, delivery_class, body)
  VALUES ('reply-${ACTION_ID}', 'conv-t44', 'at-most-once', '{\"text\":\"post-base reply\"}')" >/dev/null
sql_src -c "INSERT INTO sent_log(idempotency_key, conversation_id, delivery_class, body)
  VALUES ('approval-${ACTION_ID}', 'conv-t44', 'at-least-once', '{\"text\":\"post-base approval prompt\"}')" >/dev/null
CREATED_EVENT_ID="$(caleffect create "${ACTION_ID}" "${SLOT_START}" | awk '{print $2}')"
[[ -n "${CREATED_EVENT_ID}" ]] || die "calendar create returned no event id"
log "post-base: action→executed, +2 sent_log rows, REAL event ${CREATED_EVENT_ID}"

# --- 5. Base-only restore (the rewind) into a scratch container -------------
# Restore the base + its bundled -Xstream WAL only (NO archived WAL) → recovery
# stops at base-end = before any post-base write. This IS the rewind.
ts="$(latest_base_ts)"; [[ -n "${ts}" ]] || die "no base backup found"
s3_get_dec "base/${ts}/base.tar.gz" >"${SPOOL}/base.tar.gz"
s3_get_dec "base/${ts}/pg_wal.tar.gz" >"${SPOOL}/pg_wal.tar.gz"
docker run -d --name "${DRILL_SCRATCH}" --entrypoint sleep "${SRC_IMAGE}" infinity >/dev/null
docker exec -u postgres "${DRILL_SCRATCH}" mkdir -p /var/lib/postgresql/data
docker cp "${SPOOL}/base.tar.gz" "${DRILL_SCRATCH}:/tmp/base.tar.gz"
docker cp "${SPOOL}/pg_wal.tar.gz" "${DRILL_SCRATCH}:/tmp/pg_wal.tar.gz"
docker exec -u root "${DRILL_SCRATCH}" chown postgres:postgres /tmp/base.tar.gz /tmp/pg_wal.tar.gz
docker exec -i -u postgres "${DRILL_SCRATCH}" bash -eus <<'INNER'
cd /var/lib/postgresql/data
tar xzf /tmp/base.tar.gz
chmod 700 /var/lib/postgresql/data
# Bundled -Xstream WAL into pg_wal so startup recovers the base to consistency
# (base-end) WITHOUT a restore_command — no archived WAL = no post-base replay.
tar xzf /tmp/pg_wal.tar.gz -C pg_wal
pg_ctl -D /var/lib/postgresql/data -w -t 90 -l /tmp/restore.log start
INNER
log "restored base-only into ${DRILL_SCRATCH} (rewound to base-end)"

# --- 6. Reconcile ------------------------------------------------------------
ok=1

# (4c) the executed flip rewound → A is approved again.
status="$(sql_scratch "select status from pending_actions where action_id='${ACTION_ID}'")"
[[ "${status}" == "approved" ]] && log "ok 4c: action restored as 'approved' (executed flip rewound)" \
  || { log "FAIL 4c: expected approved, got '${status}'"; ok=0; }

# (4a) the rewound window: post-base sent_log rows absent; baseline present.
post_base="$(sql_scratch "select count(*) from sent_log where idempotency_key in ('reply-${ACTION_ID}','approval-${ACTION_ID}')")"
baseline="$(sql_scratch "select count(*) from sent_log where idempotency_key='baseline-reminder-${ACTION_ID}'")"
[[ "${post_base}" == "0" && "${baseline}" == "1" ]] \
  && log "ok 4a: post-base sent_log rows absent (rewound), baseline survived" \
  || { log "FAIL 4a: post_base=${post_base} (want 0), baseline=${baseline} (want 1)"; ok=0; }

# (4b) re-execute the restored action: action_id read back from the RESTORED row
# (proving it survived) → re-derive the id → Google 409 → folded → no duplicate.
restored_action="$(sql_scratch "select action_id from pending_actions where action_id='${ACTION_ID}'")"
[[ "${restored_action}" == "${ACTION_ID}" ]] || { log "FAIL 4b: action_id did not survive restore"; ok=0; }
recreate_out="$(caleffect recreate "${restored_action}" "${SLOT_START}")"
echo "${recreate_out}" | grep -q '^already-exists ' \
  && log "ok 4b: re-execute folded 409 → already-exists (${recreate_out%% *})" \
  || { log "FAIL 4b: re-execute did not fold to already-exists: ${recreate_out}"; ok=0; }
count_out="$(caleffect count "${SLOT_START}" "${SLOT_END}")"
[[ "${count_out%% *}" == "1" ]] \
  && log "ok 4b: window holds exactly ONE event (no duplicate)" \
  || { log "FAIL 4b: expected 1 event in window, got: ${count_out}"; ok=0; }

[[ "${ok}" == "1" ]] && log "=== T44 DRILL PASS ===" || die "=== T44 DRILL FAILED ==="
