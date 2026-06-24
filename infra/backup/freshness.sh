#!/usr/bin/env bash
# infra/backup/freshness.sh — surface base-backup freshness to the monitoring
# channel (V2_NOTES §6). The continuous WAL stream is the RPO-critical path, but
# nothing alerts when *base* backups stop (a stalled base cron silently extends
# every future restore's WAL-replay window until WAL retention itself expires and
# PITR breaks). This closes that gap the same way the process liveness is
# watched: a healthchecks.io-style dead-man.
#
# It reads the latest base timestamp from S3 (via lib.sh's latest_base_ts, which
# needs only `aws s3 ls` — NO decryption, so it runs with just the public-side
# config and the instance role), computes its age, and:
#   * pings  ${BACKUP_FRESHNESS_PING_URL}          when the newest base is FRESH
#   * pings  ${BACKUP_FRESHNESS_PING_URL}/fail     when it is STALE or missing
# A separate healthchecks.io check (its own URL, distinct from the process
# dead-man DEADMAN_PING_URL) then alerts from OUTSIDE — surviving the case the
# in-process pinger can't: the whole host/backup pipeline being wedged.
#
# Threshold: BACKUP_MAX_AGE_HOURS (default 30h) — comfortably over the daily
# (24h) base cadence so a single slightly-late run isn't a false alarm, but well
# under WAL retention (14d) so a real stall is caught with days of margin.
#
# Exit code mirrors the ping: 0 fresh, 1 stale/missing — so it is also usable
# standalone (cron/CI/manual) without a ping URL configured.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"
PING_URL="${BACKUP_FRESHNESS_PING_URL:-}"

# ping_fresh / ping_stale: best-effort signal to the dead-man check. A failed
# ping is itself the kind of thing the external check exists to catch, so it is
# logged, never fatal (mirrors src/ops/deadman.ts's swallow-and-report).
ping() {
  [[ -n "${PING_URL}" ]] || return 0
  local url="${PING_URL}${1}"
  curl -fsS -m 10 -o /dev/null "${url}" \
    || log "WARN: freshness ping failed (${url%%\?*})"
}

# latest_base_ts yields a stamp like 20260615T031500Z (UTC, from backup.sh).
latest="$(latest_base_ts || true)"
if [[ -z "${latest}" ]]; then
  log "no base backup found under ${S3_BASE}/base/ — STALE"
  ping /fail
  die "no base backup present"
fi

# Parse 20260615T031500Z → epoch. GNU date (the Linux host/sidecar) needs the
# stamp reshaped to an ISO form it accepts.
iso="${latest:0:4}-${latest:4:2}-${latest:6:2}T${latest:9:2}:${latest:11:2}:${latest:13:2}Z"
if ! base_epoch="$(date -u -d "${iso}" +%s 2>/dev/null)"; then
  die "could not parse latest base timestamp '${latest}' (expected YYYYMMDDThhmmssZ)"
fi

now_epoch="$(date -u +%s)"
age_hours=$(( (now_epoch - base_epoch) / 3600 ))
log "latest base: ${latest} (age ${age_hours}h; threshold ${MAX_AGE_HOURS}h)"

if (( age_hours > MAX_AGE_HOURS )); then
  log "STALE: latest base is ${age_hours}h old (> ${MAX_AGE_HOURS}h)"
  ping /fail
  exit 1
fi

log "FRESH: latest base within ${MAX_AGE_HOURS}h"
ping ""
exit 0
