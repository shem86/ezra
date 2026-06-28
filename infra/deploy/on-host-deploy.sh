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
#   SECRETS_MODE       how to materialize .env before deploy (V2_NOTES §3): unset
#                      or `none` (default) keeps the on-disk .env untouched —
#                      preserves portability + the historical behavior; `ssm`
#                      pulls it from an SSM SecureString (SECRETS_PARAM); `sops`
#                      decrypts SOPS_ENV_FILE with an age key from AGE_KEY_PARAM.
#                      The CD workflow (deploy.yml) sets ssm; a non-AWS host
#                      (Hetzner) can set sops or leave it none.
#   SECRETS_PARAM      SECRETS_MODE=ssm: SSM param holding the full .env (default /hh-assistant/env)
#   AGE_KEY_PARAM      SECRETS_MODE=sops: SSM param holding the SOPS age private key
#   SOPS_ENV_FILE      SECRETS_MODE=sops: repo-relative encrypted env, e.g. .env.prod.enc
#   AWS_REGION         region for SSM lookups (default us-east-1; ssm/sops modes only)
set -euo pipefail

EZRA_TAG="${EZRA_TAG:?set EZRA_TAG to the image tag to deploy}"
REPO_DIR="${REPO_DIR:-$HOME/hh-assistant}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
SECRETS_MODE="${SECRETS_MODE:-none}"
SECRETS_PARAM="${SECRETS_PARAM:-/hh-assistant/env}"
AWS_REGION="${AWS_REGION:-us-east-1}"
IMAGE="ghcr.io/shem86/hh-assistant"

cd "$REPO_DIR"

# --env-file .env is load-bearing: with `-f infra/...` the compose project dir
# becomes infra/, so ${POSTGRES_PASSWORD}/${EZRA_TAG} interpolation would look
# for infra/.env and miss the repo-root file (§4/§9, infra/runtime.md).
compose() { docker compose --env-file .env -f infra/docker-compose.prod.yml "$@"; }

# Full-project compose: prod + the backup sidecar overlay. The backup container
# (hh-assistant-backup-1) shares this project via docker-compose.backup.yml
# (enable-replication.sh / cloud-init bring the stack up with BOTH files). A
# clean `down`/`up` MUST include the overlay — otherwise `down` orphans the
# backup and can't remove the shared `internal` network, and `up` wouldn't
# restore the sidecar. Only the recreate path needs this; the fast in-place
# swap touches just ezra/backoffice and uses `compose` above.
BACKUP_OVERLAY="infra/backup/docker-compose.backup.yml"
compose_full() {
  if [[ -f "$BACKUP_OVERLAY" ]]; then
    docker compose --env-file .env -f infra/docker-compose.prod.yml -f "$BACKUP_OVERLAY" "$@"
  else
    docker compose --env-file .env -f infra/docker-compose.prod.yml "$@"
  fi
}

log() { printf '[deploy] %s\n' "$*"; }

# Re-apply the host egress firewall to the (possibly recreated) docker bridge.
# This script runs as the `hh` deploy user (deploy.yml: `sudo -u hh … bash`), so
# the re-apply needs the NOPASSWD sudoers right from infra/host/sudoers-hh-ops.
# If that drop-in is missing — e.g. the adopted prod host that never ran
# cloud-init (V2_NOTES §2) — the sudo is DENIED and the firewall stays unbound to
# the new bridge: FAIL-OPEN egress. That must never be silent: emit a structured
# marker the CD workflow (deploy.yml) annotates as a warning, with the one-line
# fix (run the reconcile script). `sudo -n` fails fast instead of hanging on a
# password prompt under the non-interactive SSM shell.
EGRESS_DEGRADED=0
reapply_egress() {
  if sudo -n systemctl start hh-egress.service 2>/dev/null; then
    log "egress re-applied to the live bridge (hh-egress.service)"
  else
    EGRESS_DEGRADED=1
    log "EGRESS-REAPPLY-FAILED: 'sudo systemctl start hh-egress.service' was denied/failed — host is FAIL-OPEN on egress until fixed"
    log "  fix: run 'sudo bash ${REPO_DIR}/infra/host/reconcile-host-config.sh' on the host (installs the missing sudoers drop-in), then redeploy"
  fi
}

# --- 0. materialize .env from the secret store (V2_NOTES §3) ------------------
# Mirrors the cloud-init fetch (infra/pulumi/cloud-init/user-data.yaml.tmpl) so
# the create path and steady-state CD share one source of truth: secrets live
# in SSM (or a SOPS+age blob), never a hand-scp'd file. The write is atomic
# (fetch to a temp, require non-empty, then mv) so a failed fetch aborts the
# deploy BEFORE any pull/swap — the running container is left untouched.
# POSTGRES_PASSWORD footgun (§3/§9): the stored .env must carry the SAME
# host-generated POSTGRES_PASSWORD the data dir was initialized with — Postgres
# binds it at first init, so a divergent value silently breaks app auth.
materialize_env() {
  case "$SECRETS_MODE" in
    none) log "secrets: SECRETS_MODE=none — using the on-disk .env as-is"; return 0 ;;
    ssm)
      log "secrets: fetching .env from SSM ${SECRETS_PARAM}"
      aws ssm get-parameter --name "$SECRETS_PARAM" --with-decryption \
        --region "$AWS_REGION" --query Parameter.Value --output text > "$REPO_DIR/.env.ssm.tmp"
      ;;
    sops)
      log "secrets: decrypting ${SOPS_ENV_FILE:?set SOPS_ENV_FILE for sops mode} with age key from ${AGE_KEY_PARAM:?set AGE_KEY_PARAM for sops mode}"
      local keyfile; keyfile="$(mktemp)"
      aws ssm get-parameter --name "$AGE_KEY_PARAM" --with-decryption \
        --region "$AWS_REGION" --query Parameter.Value --output text > "$keyfile"
      SOPS_AGE_KEY_FILE="$keyfile" sops -d "$REPO_DIR/$SOPS_ENV_FILE" > "$REPO_DIR/.env.ssm.tmp"
      shred -u "$keyfile" 2>/dev/null || rm -f "$keyfile"
      ;;
    *) log "secrets: unknown SECRETS_MODE=$SECRETS_MODE"; return 1 ;;
  esac
  if [[ ! -s "$REPO_DIR/.env.ssm.tmp" ]]; then
    log "secrets: fetched .env is empty — aborting before any swap"
    rm -f "$REPO_DIR/.env.ssm.tmp"
    return 1
  fi
  mv "$REPO_DIR/.env.ssm.tmp" "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
  log "secrets: .env materialized from $SECRETS_MODE"
}
materialize_env

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

# --- 4. detect a network-definition change that forces a clean recreate -------
# Docker can't apply a network driver_opts change (e.g. the egress bridge-name
# pin, V2_NOTES §5) to a LIVE network with containers attached — ANY compose
# `up`/`run` then tries to recreate the network and errors "container … is not
# connected to network …", wedging the deploy (2026-06-24 incident). compose
# reconciles ALL project networks on every up/run, so even the migrate-gate
# trips it. Detect the drift UP FRONT (compare the live egress bridge name to
# the compose spec) and, when present, take the clean down/up path below instead
# of the in-place migrate-gate — a one-time event: once recreated, live==spec
# and future deploys take the fast in-place path.
DESIRED_EGRESS_BRIDGE="$(grep 'com.docker.network.bridge.name' infra/docker-compose.prod.yml | head -1 | awk '{print $NF}')"
LIVE_EGRESS_BRIDGE="$(docker network inspect hh-assistant_egress \
  --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null || echo "")"
NEED_RECREATE=0
if [[ -n "$DESIRED_EGRESS_BRIDGE" && "$DESIRED_EGRESS_BRIDGE" != "$LIVE_EGRESS_BRIDGE" ]]; then
  log "egress network drift: live bridge='${LIVE_EGRESS_BRIDGE:-<none>}' desired='${DESIRED_EGRESS_BRIDGE}' — clean recreate required"
  NEED_RECREATE=1
fi

if [[ "$NEED_RECREATE" == 1 ]]; then
  # --- 5a. clean down/up (the only way to apply a network-definition change) ---
  # Recreates networks correctly with named volumes (pgdata, wa-session)
  # PRESERVED — never `-v`. ezra applies migrations at launch (main.ts
  # runMigrations), and the healthcheck + auto-rollback below catch a bad
  # migration just as they catch a bad swap. A brief, one-time planned downtime.
  log "clean down/up to ${EZRA_TAG} (full stack incl backup sidecar; named volumes preserved; ezra migrates at launch)"
  EZRA_TAG="$EZRA_TAG" compose_full down
  EZRA_TAG="$EZRA_TAG" compose_full up -d
  # The egress network now carries its pinned bridge name; re-apply the host
  # nftables allowlist so it matches immediately rather than waiting for the
  # refresh timer. A failure here is a fail-OPEN security regression, not a
  # cosmetic note — reapply_egress surfaces it loudly (see above).
  reapply_egress
else
  # --- 4. migrate-gate: run migrations with the NEW image, before the swap -----
  # `--no-recreate postgres` + `--no-deps`: ensure Postgres is up WITHOUT
  # recreating it, so a postgres-service change doesn't trigger a live recreate
  # here (that's the clean-recreate path's job).
  log "ensuring Postgres is up without recreating it"
  EZRA_TAG="$EZRA_TAG" compose up -d --no-recreate postgres
  log "migrate-gate: applying migrations with ${EZRA_TAG}"
  if ! EZRA_TAG="$EZRA_TAG" compose run --rm --no-deps ezra node dist/memory/migrate-cli.js; then
    log "MIGRATION FAILED — aborting before swap; old container left running"
    exit 1
  fi
  # --- 5. swap the running app + backoffice to the new tag (in-place) ---------
  log "swapping ezra + backoffice to ${EZRA_TAG}"
  if ! EZRA_TAG="$EZRA_TAG" compose up -d ezra backoffice; then
    log "in-place swap failed — clean down/up (full stack; named volumes preserved)"
    EZRA_TAG="$EZRA_TAG" compose_full down
    EZRA_TAG="$EZRA_TAG" compose_full up -d
    reapply_egress
  fi
fi

# --- 5b. refresh the backup sidecar to the released image (V2_NOTES §6) --------
# The sidecar image now ships from GHCR (CI-built, like ezra) instead of being
# hand-built on the host — so pull the matched tag and recreate the long-running
# `receivewal` container if it moved. `up -d backup` is a no-op when the tag is
# unchanged; when it moved, the brief reconnect loses no WAL (the replication
# slot retains it server-side). Fail-soft: a backup-image hiccup must not fail an
# otherwise-healthy app deploy — a genuinely stalled sidecar is caught by the
# freshness dead-man (hh-backup-freshness.*), not here.
if EZRA_TAG="$EZRA_TAG" compose_full pull backup 2>/dev/null; then
  log "refreshing backup sidecar to ${EZRA_TAG}"
  EZRA_TAG="$EZRA_TAG" compose_full up -d backup \
    || log "WARN: backup sidecar recreate failed — left running on the prior image"
else
  log "WARN: backup image pull failed (${IMAGE}-backup:${EZRA_TAG}) — sidecar left as-is"
fi

# --- 6. healthcheck gate: launch markers + no restart-loop ---------------------
# No HTTP endpoint exists (src/ops/health.ts is a socket/alert monitor), so the
# readiness signal is the launch lines the processes print (`ezra up:` and
# `backoffice up:`) plus both containers staying `running` without crash-looping.
log "waiting up to ${HEALTH_TIMEOUT}s for the launch markers (ezra + backoffice)"
ezra_cid="$(EZRA_TAG="$EZRA_TAG" compose ps -q ezra)"
bo_cid="$(EZRA_TAG="$EZRA_TAG" compose ps -q backoffice)"
ezra_up=false
bo_up=false
deadline=$(( SECONDS + HEALTH_TIMEOUT ))
crashed=false
while (( SECONDS < deadline )); do
  for pair in "ezra:$ezra_cid" "backoffice:$bo_cid"; do
    name="${pair%%:*}"; cid="${pair#*:}"
    status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo missing)"
    restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
    if [[ "$status" == "exited" || "$status" == "dead" || "${restarts:-0}" -ge 2 ]]; then
      log "$name is crash-looping (status=$status restarts=$restarts)"
      crashed=true
    fi
  done
  $crashed && break
  docker logs "$ezra_cid" 2>&1 | grep -q 'ezra up:' && ezra_up=true
  docker logs "$bo_cid" 2>&1 | grep -q 'backoffice up:' && bo_up=true
  if [[ "$ezra_up" == true && "$bo_up" == true ]]; then break; fi
  sleep 3
done

if [[ "$ezra_up" == true && "$bo_up" == true ]]; then
  log "healthy: ${EZRA_TAG} spine + backoffice are up (steady-state via the hc-ping dead-man)"
  # App is up, so the deploy succeeds — but if egress couldn't be re-applied the
  # host is fail-OPEN and the CD workflow annotates this as a warning. Repeat the
  # marker at the tail so it's the last thing in the deploy log, not buried.
  if [[ "$EGRESS_DEGRADED" == 1 ]]; then
    log "DEGRADED: deploy succeeded but EGRESS-REAPPLY-FAILED — re-apply the firewall (see fix above) ASAP"
  fi
  exit 0
fi

# --- 7. auto-rollback ---------------------------------------------------------
log "HEALTHCHECK FAILED for ${EZRA_TAG} (ezra_up=$ezra_up backoffice_up=$bo_up)"
if [[ -n "$PRIOR_TAG" && "$PRIOR_TAG" != "$EZRA_TAG" ]]; then
  log "rolling back ezra + backoffice to ${PRIOR_TAG}"
  EZRA_TAG="$PRIOR_TAG" compose up -d ezra backoffice
else
  log "no prior tag to roll back to — leaving the failed containers for diagnosis"
fi
exit 1
