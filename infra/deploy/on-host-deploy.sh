#!/usr/bin/env bash
# infra/deploy/on-host-deploy.sh — pull-and-swap deploy of the ezra image.
#
# Invoked on the host by the CD workflow (.github/workflows/deploy.yml) over AWS
# SSM, but provider-portable by design: it takes only EZRA_TAG + a GHCR login,
# nothing AWS-specific (the ~Oct-2026 Hetzner migration reuses it unchanged).
# It mirrors the manual T45 recipe in infra/runtime.md.
#
# Sequence (V2_NOTES §1): record prior tag → pull → MIGRATE-GATE → swap →
# healthcheck → auto-rollback. The migrate-gate runs migrations with the NEW
# image BEFORE the running app is swapped, so a bad migration fails the deploy
# instead of crash-looping a swapped container. Forward-only caveat: image-swap
# rollback reverts the APP, not the schema (migrations are not down-migratable).
#
# Usage (from anywhere; REPO_DIR defaults to the deploy user's checkout):
#   EZRA_TAG=sha-abc1234 infra/deploy/on-host-deploy.sh
#
# Env:
#   EZRA_TAG            (required) immutable image tag to deploy, e.g. sha-abc1234 or 2.0.0
#   REPO_DIR           repo root holding .env + infra/ (default: ~/hh-assistant)
#   GHCR_USER/GHCR_PAT optional; if set, `docker login ghcr.io` runs first.
#                      Omit when the host already holds a persistent GHCR login.
#   HEALTH_TIMEOUT     seconds to wait for the launch marker (default: 180 —
#                      real startup is ~60s: WhatsApp connect + DBOS launch/recovery)
set -euo pipefail

EZRA_TAG="${EZRA_TAG:?set EZRA_TAG to the image tag to deploy}"
REPO_DIR="${REPO_DIR:-$HOME/hh-assistant}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
IMAGE="ghcr.io/shem86/hh-assistant"

cd "$REPO_DIR"

# --env-file .env is load-bearing: with `-f infra/...` the compose project dir
# becomes infra/, so ${POSTGRES_PASSWORD}/${EZRA_TAG} interpolation would look
# for infra/.env and miss the repo-root file (§4/§9, infra/runtime.md).
compose() { docker compose --env-file .env -f infra/docker-compose.prod.yml "$@"; }

log() { printf '[deploy] %s\n' "$*"; }

# --- 1. GHCR auth (optional — skipped if the host is already logged in) -------
if [[ -n "${GHCR_PAT:-}" ]]; then
  log "logging in to ghcr.io as ${GHCR_USER:-?}"
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "${GHCR_USER:?set GHCR_USER with GHCR_PAT}" --password-stdin
fi

# --- 2. record the currently-running tag for rollback -------------------------
PRIOR_TAG=""
prior_cid="$(compose ps -q ezra || true)"
if [[ -n "$prior_cid" ]]; then
  prior_image="$(docker inspect -f '{{.Config.Image}}' "$prior_cid" 2>/dev/null || true)"
  PRIOR_TAG="${prior_image##*:}" # tag after the last colon
  log "currently running tag: ${PRIOR_TAG:-<none>}"
else
  log "no ezra container running — this is a first deploy (no rollback target)"
fi

# --- 3. pull the new image ----------------------------------------------------
log "pulling ${IMAGE}:${EZRA_TAG}"
EZRA_TAG="$EZRA_TAG" compose pull ezra

# --- 4. migrate-gate: run migrations with the NEW image, before the swap ------
# Postgres is a dependency, so `run` (no --no-deps) brings it up if needed.
# migrate-cli reads DATABASE_URL from the compose environment block.
log "migrate-gate: applying migrations with ${EZRA_TAG}"
if ! EZRA_TAG="$EZRA_TAG" compose run --rm ezra node dist/memory/migrate-cli.js; then
  log "MIGRATION FAILED — aborting before swap; old container left running"
  exit 1
fi

# --- 5. swap the running app to the new tag -----------------------------------
log "swapping ezra to ${EZRA_TAG}"
EZRA_TAG="$EZRA_TAG" compose up -d ezra

# --- 6. healthcheck gate: launch marker + no restart-loop ----------------------
# No HTTP endpoint exists (src/ops/health.ts is a socket/alert monitor), so the
# readiness signal is the launch line main.ts prints (`ezra up:`) plus the
# container staying `running` without crash-looping.
log "waiting up to ${HEALTH_TIMEOUT}s for the launch marker"
cid="$(EZRA_TAG="$EZRA_TAG" compose ps -q ezra)"
healthy=false
deadline=$(( SECONDS + HEALTH_TIMEOUT ))
while (( SECONDS < deadline )); do
  status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo missing)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
  if [[ "$status" == "exited" || "$status" == "dead" || "${restarts:-0}" -ge 2 ]]; then
    log "container is crash-looping (status=$status restarts=$restarts)"
    break
  fi
  if docker logs "$cid" 2>&1 | grep -q 'ezra up:'; then
    healthy=true
    break
  fi
  sleep 3
done

if [[ "$healthy" == true ]]; then
  log "healthy: ${EZRA_TAG} is up (steady-state monitored by the hc-ping dead-man)"
  exit 0
fi

# --- 7. auto-rollback ---------------------------------------------------------
log "HEALTHCHECK FAILED for ${EZRA_TAG}"
if [[ -n "$PRIOR_TAG" && "$PRIOR_TAG" != "$EZRA_TAG" ]]; then
  log "rolling back to ${PRIOR_TAG}"
  EZRA_TAG="$PRIOR_TAG" compose up -d ezra
else
  log "no prior tag to roll back to — leaving the failed container for diagnosis"
fi
exit 1
