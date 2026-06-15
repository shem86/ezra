#!/usr/bin/env bash
# infra/backup/enable-replication.sh — the one open T45 wiring item: let the
# backup sidecar stream WAL from the PRODUCTION postgres.
#
# The stock pgvector/postgres image already accepts normal SQL connections from
# the internal network (`host all all all scram-sha-256` — that is how ezra and
# `backup.sh ensure-slot` connect), but its `replication` pg_hba lines trust
# ONLY localhost. pg_basebackup / pg_receivewal open a *replication* connection,
# which those lines do not cover — so the sidecar's stream is refused until this
# line is added.
#
# What this does (idempotent):
#   * appends `host replication hh samenet scram-sha-256` to pg_hba.conf if
#     absent, then `SELECT pg_reload_conf()`.
#   * verifies wal_level supports physical replication.
#
# WHY reuse the `hh` role rather than a dedicated `hh_backup`: `hh` is the
# cluster superuser (so it is replication-capable) and is already the identity
# the sidecar carries (compose `PGUSER: hh`, password from .env) — adding a
# separate role + password is real surface on a live DB for marginal gain, since
# a replication connection can read the whole cluster regardless. A least-priv
# `hh_backup REPLICATION` role is a clean V2 hardening (see V2_NOTES.md), not a
# launch blocker. `samenet` matches whatever subnet Docker assigns the internal
# bridge, so it survives a network/volume rebuild without a hardcoded CIDR.
#
# Run ON THE HOST after `docker compose -f infra/docker-compose.prod.yml up -d`
# (and again after a host-loss rebuild — recovery runbook Scenario 2, step 7):
#   infra/backup/enable-replication.sh
# Override the container if needed: PG_CONTAINER=hh-postgres-prod (default).

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-hh-postgres-prod}"
PG_ROLE="${PG_ROLE:-hh}"
HBA_LINE="host replication ${PG_ROLE} samenet scram-sha-256"

log() { printf '[enable-repl %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf '[enable-repl ERROR] %s\n' "$*" >&2; exit 1; }

docker inspect "${PG_CONTAINER}" >/dev/null 2>&1 \
  || die "container ${PG_CONTAINER} not found (start the prod stack first)"

# Append the replication line if absent. Runs as OS user postgres (owns PGDATA).
docker exec -i -u postgres "${PG_CONTAINER}" bash -eus <<EOF
HBA="\${PGDATA:-/var/lib/postgresql/data}/pg_hba.conf"
if grep -qF '${HBA_LINE}' "\${HBA}"; then
  echo "ALREADY_PRESENT"
else
  printf '\n# hh-assistant backup sidecar (T45): physical replication from the internal network\n%s\n' '${HBA_LINE}' >> "\${HBA}"
  echo "APPENDED"
fi
EOF

log "reloading postgres configuration"
# Local socket → `local all all trust`; no password needed for this admin call.
docker exec -u postgres "${PG_CONTAINER}" \
  psql -U "${PG_ROLE}" -d postgres -v ON_ERROR_STOP=1 -tAc 'SELECT pg_reload_conf()' >/dev/null \
  || die "pg_reload_conf failed"

wal_level="$(docker exec -u postgres "${PG_CONTAINER}" \
  psql -U "${PG_ROLE}" -d postgres -tAc 'SHOW wal_level' | tr -d '[:space:]')"
case "${wal_level}" in
  replica | logical) log "wal_level=${wal_level} — supports physical replication ✓" ;;
  *) die "wal_level=${wal_level} cannot stream WAL — set it to replica and restart postgres" ;;
esac

log "replication enabled for role '${PG_ROLE}' from samenet — start the sidecar:"
log "  docker compose -f infra/docker-compose.prod.yml -f infra/backup/docker-compose.backup.yml up -d"
