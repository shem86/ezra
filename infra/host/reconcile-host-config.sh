#!/usr/bin/env bash
# infra/host/reconcile-host-config.sh — bring a host's config up to the baseline
# a fresh cloud-init box gets, idempotently.
#
# WHY THIS EXISTS: the production host was hand-built at T45 and is *adopted* by
# Pulumi (V2_NOTES §2), so cloud-init NEVER ran on it. cloud-init
# (infra/pulumi/cloud-init/user-data.yaml.tmpl) is what installs the host-config
# layer on a *fresh* box — the sudoers drop-in, the egress systemd units, and the
# §6 backup timers. On the adopted host those were partly hand-installed and can
# drift; notably the `/etc/sudoers.d/hh-ops` drop-in was missing, so the deploy's
# automatic egress re-apply (`sudo systemctl start hh-egress.service` in
# on-host-deploy.sh) was denied and the firewall silently stayed unbound after a
# network recreate — fail-OPEN egress (2026-06-24). This script reconciles the
# adopted host to the cloud-init baseline so that automation works.
#
# IDEMPOTENT and safe to re-run: every step is install/enable, no destructive op.
# Run it once on the adopted host now, and any time host-config drift is
# suspected (the deploy's `EGRESS-REAPPLY-FAILED` warning points here).
#
# MUST be run as root (installs into /etc). From the cloud `ubuntu` account:
#   ssh ubuntu@<host> 'sudo bash /home/hh/hh-assistant/infra/host/reconcile-host-config.sh'
# or over SSM (the agent runs as root) with REPO_DIR pointed at the checkout.
#
# SOURCE-OF-TRUTH NOTE: the artifact set below MUST mirror the host-config block
# in infra/pulumi/cloud-init/user-data.yaml.tmpl (the "sudoers drop-in + egress
# systemd unit/timer" install at §4 and the enable/start at §6). If you add a
# host unit there, add it here too (and vice-versa). A fresh box runs cloud-init;
# an adopted/drifted box runs this — same end state.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/hh/hh-assistant}"
DEPLOY_USER="${DEPLOY_USER:-hh}"

log() { printf '[reconcile] %s\n' "$*"; }

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "[reconcile] must run as root (installs into /etc) — re-run with sudo" >&2
  exit 1
fi
if [[ ! -d "$REPO_DIR/infra" ]]; then
  echo "[reconcile] REPO_DIR=$REPO_DIR has no infra/ — point REPO_DIR at the checkout" >&2
  exit 1
fi
cd "$REPO_DIR"

# --- 1. sudoers drop-in (the gap that broke the deploy's egress re-apply) ------
# Validate the SOURCE before placing it: a broken drop-in can lock sudo out
# entirely, so `visudo -c` the file in the repo first, then install. (cloud-init
# installs-then-checks on a fresh box where a lockout is recoverable from the
# console; on a live host we check first.)
log "validating + installing /etc/sudoers.d/hh-ops"
visudo -cf infra/host/sudoers-hh-ops
install -m 0440 -o root -g root infra/host/sudoers-hh-ops /etc/sudoers.d/hh-ops
visudo -cf /etc/sudoers.d/hh-ops

# --- 2. egress + backup systemd units -----------------------------------------
# Glob the egress units so the apply/refresh split (V2_NOTES §11) is fully
# installed — hh-egress.service + hh-egress-refresh.service; the timer triggers
# the refresh unit and refuses to start if it isn't loaded.
log "installing egress units (hh-egress*.service + hh-egress.timer)"
install -m 0644 infra/egress/hh-egress*.service /etc/systemd/system/
install -m 0644 infra/egress/hh-egress.timer /etc/systemd/system/hh-egress.timer

# Backup scheduling (V2_NOTES §6): base + freshness service/timer pairs. They run
# as the deploy user via the docker group (no sudo), hence not in the sudoers.
log "installing backup units (hh-backup-*.service + hh-backup-*.timer)"
install -m 0644 infra/backup/hh-backup-*.service /etc/systemd/system/
install -m 0644 infra/backup/hh-backup-*.timer /etc/systemd/system/

systemctl daemon-reload

# The deploy user needs the docker group for the timers' compose calls + the
# GHCR login (idempotent — usermod is a no-op if already a member).
usermod -aG docker "$DEPLOY_USER"

# --- 3. enable timers + apply egress ------------------------------------------
# Backup timers: base (daily) + freshness dead-man (hourly).
log "enabling backup timers"
systemctl enable --now hh-backup-base.timer hh-backup-freshness.timer || \
  log "warn: could not enable backup timers (is the backup stack present?)"

# Egress: apply FIRST (creates the nft table on the live bridge), THEN enable the
# timer (its refresh unit is After=hh-egress.service and only swaps set elements
# on an already-loaded table). If apply fails the bridge likely isn't up yet —
# bring the compose stack up, then re-run.
log "applying egress (hh-egress.service) + enabling the refresh timer"
if systemctl start hh-egress.service; then
  systemctl enable --now hh-egress.timer
  log "egress applied — host firewall is bound to the live bridge"
else
  log "warn: hh-egress.service failed to start — is the docker egress network up?"
  log "      bring the stack up (make up) and re-run this script"
  exit 1
fi

log "done — host reconciled to the cloud-init baseline"
