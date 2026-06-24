#!/usr/bin/env bash
# infra/backup/initdb-replication.sh — bake the backup sidecar's replication
# wiring into the Postgres cluster at FIRST INIT, so continuous WAL archiving
# works on first boot of a fresh data dir (V2_NOTES §6). This is the declarative
# replacement for the hand-run infra/backup/enable-replication.sh.
#
# IMPORTANT — runs ONLY on a FRESH (empty) PGDATA. Postgres's entrypoint executes
# /docker-entrypoint-initdb.d/* exactly once, during the very first `initdb` of a
# new data dir. It does NOT run on a container restart over an existing volume.
# So this script HELPS rebuilds / create-from-zero (a new pgdata volume); it does
# NOT and cannot mutate the already-initialized production data dir — that one
# was wired by enable-replication.sh at T45 and stays as-is. After this lands,
# the rebuild path no longer needs the hand-run post-step; enable-replication.sh
# is kept for the existing prod box / belt-and-suspenders (idempotent).
#
# What it does, in the single transaction-free init window where the server is
# already up on its local socket as the POSTGRES_USER superuser:
#   1. create a LEAST-PRIVILEGE `hh_backup` role with REPLICATION + LOGIN
#      (not the `hh` superuser — a replication connection reads the whole cluster
#      regardless, but a dedicated role keeps the backup credential off the app's
#      superuser and lets it be rotated/revoked independently). Its password is
#      BACKUP_ROLE_PASSWORD, defaulting to POSTGRES_PASSWORD so a fresh box works
#      with no extra secret to custody.
#   2. append `host replication hh_backup samenet scram-sha-256` to pg_hba.conf
#      (the stock pgvector image trusts replication only from localhost — the
#      T17 item). `samenet` matches whatever subnet Docker assigns the internal
#      bridge, so it survives a network/volume rebuild with no hardcoded CIDR.
#
# POSTGRES_PASSWORD footgun (§3/§9): this script NEVER writes/regenerates
# POSTGRES_PASSWORD — it only reads it to seed the backup role's password when no
# dedicated one is supplied. The superuser password is bound by initdb before
# this runs and is left untouched.
set -euo pipefail

log() { printf '[initdb-repl %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# Dedicated backup role. Defaults reuse POSTGRES_PASSWORD so a fresh box needs no
# extra secret; override BACKUP_ROLE_PASSWORD (+ point the sidecar at it) to give
# the backup credential its own life independent of the app superuser.
BACKUP_ROLE="${BACKUP_ROLE:-hh_backup}"
BACKUP_ROLE_PASSWORD="${BACKUP_ROLE_PASSWORD:-${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set at init}}"

# 1. Least-privilege replication role. CREATE ROLE is idempotent-guarded so a
#    re-run (only possible if this file is re-added to a partially-init'd dir) is
#    a no-op rather than an error. psql connects over the local socket as the
#    bootstrap superuser ($POSTGRES_USER), the only auth available mid-init.
log "creating replication role ${BACKUP_ROLE} (REPLICATION, LOGIN, no superuser)"
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname postgres \
  --set=role="${BACKUP_ROLE}" --set=pw="${BACKUP_ROLE_PASSWORD}" <<'SQL'
SELECT format(
  $f$CREATE ROLE %I WITH REPLICATION LOGIN PASSWORD %L$f$,
  :'role', :'pw'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
SQL

# 2. Replication pg_hba line for that role from the internal Docker subnet.
#    PGDATA is exported by the entrypoint; pg_hba.conf lives at its root.
HBA="${PGDATA:-/var/lib/postgresql/data}/pg_hba.conf"
HBA_LINE="host replication ${BACKUP_ROLE} samenet scram-sha-256"
if grep -qF "${HBA_LINE}" "${HBA}"; then
  log "pg_hba already carries the replication line — skipping"
else
  log "appending replication line to pg_hba.conf"
  printf '\n# hh-assistant backup sidecar (V2_NOTES §6): physical replication from the internal network\n%s\n' \
    "${HBA_LINE}" >>"${HBA}"
fi

# No reload needed: the entrypoint restarts the server once after running every
# initdb.d script (it runs them against a temporary single-user listener, then
# brings up the real server), so the appended pg_hba line is read on that start.
log "replication baked for role ${BACKUP_ROLE} from samenet — sidecar can stream on first boot"
