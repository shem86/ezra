#!/usr/bin/env bash
# infra/provision-host.sh — T15 host baseline, idempotent. Ubuntu 24.04.
#
# Codifies the manual first-login hardening run on the AWS box (2026-06-12) so
# the planned Hetzner migration (~mid-Oct 2026, see infra/host.md) is one run,
# not hand-typed from a doc. Scope is deliberately the LOGIN/OS baseline only:
# the `hh` user, SSH lockdown, OS patching, hostname. The application RUNTIME
# sandbox (non-root service user, read-only rootfs, writable volumes for the
# Baileys session + Postgres data, egress allowlist) is T16 and lives
# separately in infra/ as compose + host nftables.
#
# Run as root on a FRESH box, before it holds anything:
#   scp infra/provision-host.sh root@<ip>:  &&  ssh root@<ip> 'bash provision-host.sh'
# AWS's cloud default user is `ubuntu` (sudo, not root) — there, run:
#   sudo bash provision-host.sh
#
# Portability: the provider injects the SSH keypair into its default account
# (`ubuntu` on AWS, `root` on Hetzner), not into `hh`. The seed account is
# auto-detected; override with SEED_USER=<name> if neither default applies.
set -euo pipefail

readonly TARGET_USER="hh"
readonly HOSTNAME_WANT="hh-assistant"

if [[ $EUID -ne 0 ]]; then
  echo "must run as root: sudo bash $0" >&2
  exit 1
fi

# --- 1. login user -----------------------------------------------------------
if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$TARGET_USER"
fi
usermod -aG sudo "$TARGET_USER"

# --- 2. seed hh's SSH key from the cloud-default account ----------------------
seed_keys=""
if [[ -n "${SEED_USER:-}" ]]; then
  seed_home="$(getent passwd "$SEED_USER" | cut -d: -f6)"
  seed_keys="${seed_home}/.ssh/authorized_keys"
else
  for cand in /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys; do
    if [[ -s "$cand" ]]; then seed_keys="$cand"; break; fi
  done
fi

target_keys="/home/${TARGET_USER}/.ssh/authorized_keys"
install -d -m 700 -o "$TARGET_USER" -g "$TARGET_USER" "/home/${TARGET_USER}/.ssh"
# Seed only when hh has no key yet — re-runs must never clobber keys added by
# hand after first provisioning.
if [[ ! -s "$target_keys" ]]; then
  if [[ ! -s "$seed_keys" ]]; then
    echo "no source SSH key found (set SEED_USER=<account>); refusing to lock SSH down without a working key for $TARGET_USER" >&2
    exit 1
  fi
  install -m 600 -o "$TARGET_USER" -g "$TARGET_USER" "$seed_keys" "$target_keys"
fi

# --- 3. SSH lockdown ----------------------------------------------------------
# Self-lockout guard (load-bearing order): never disable password + root login
# unless hh can actually get in by key, and never restart on an invalid config.
if [[ ! -s "$target_keys" ]]; then
  echo "refusing SSH lockdown: $target_keys is empty" >&2
  exit 1
fi
printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-hardening.conf
sshd -t
systemctl restart ssh

# --- 4. OS patching -----------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
# unattended-upgrades: OS patching. curl+jq: the egress refresh timer
# (infra/egress/nftables.sh) needs them to load AWS's published S3 CIDR ranges —
# S3 can't be allowlisted by DNS (T45 finding).
apt-get -y install unattended-upgrades curl jq

# --- 5. identity --------------------------------------------------------------
# TZ stays UTC deliberately: reminders anchor to the household timezone
# (Eastern) in app config, never server time (CLAUDE.md / dbos.md).
hostnamectl set-hostname "$HOSTNAME_WANT"

echo "provision-host.sh: baseline applied. Verify key-only login as '$TARGET_USER' from a SECOND session before closing this one."
