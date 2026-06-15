#!/usr/bin/env bash
# infra/egress/nftables.sh — host-level egress allowlist for the Ezra container
# (T16 v0). Default-deny on the container's forwarded egress; allow only the
# hosts declared in src/ops/egress-allowlist.ts (via render-allowlist.ts) plus
# DNS and established flows. Everything else is logged and dropped.
#
# WHY host nftables and not the container layer (CLAUDE.md / infra/host.md):
# Docker manages its own iptables rules; layering a hostname allowlist inside
# the container fights that. So enforcement lives on the host, scoped to the
# docker egress bridge interface, and the app image stays firewall-agnostic.
#
# WHY resolve names, not pin IPs: Anthropic/Voyage/Google/WhatsApp all rotate
# behind CDNs. We resolve the allowlist into nft sets with a timeout and
# refresh them on a timer (`refresh` subcommand → systemd timer, see
# infra/runtime.md). Apex coverage is the floor; the refresh re-resolves the
# rotating subdomains the apps actually hit.
#
# STATUS: v0. On-host enforcement — "blocked egress to a non-listed host
# confirmed" — is the T45 drill (this dev repo can't exercise host nftables).
# This script is the artifact T45 applies and verifies; treat the
# DOCKER-USER-vs-nftables coexistence as the sharp edge to validate there.
#
# Usage (root on the host):
#   EGRESS_IFACE=br-xxxx infra/egress/nftables.sh apply     # build + load ruleset
#   EGRESS_IFACE=br-xxxx infra/egress/nftables.sh refresh   # re-resolve sets only
#   infra/egress/nftables.sh print                          # dump rendered ruleset
# Find the bridge: docker network inspect hh-assistant_egress -f '{{.Id}}' → br-<first12>
set -euo pipefail

readonly TABLE="hh_egress"
readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly RESOLVER="${RESOLVER:-169.254.169.253}" # Docker's embedded DNS / VPC resolver

# Resolve every allowlist apex (and a few well-known service subdomains) to a
# space-separated IPv4 list. Bare-node render keeps this in lockstep with src.
resolve_ipv4() {
  local hosts extra
  hosts="$(node "${HERE}/render-allowlist.ts")"
  # Rotating subdomains the apex form won't resolve on its own:
  extra="g.whatsapp.net mmg.whatsapp.net web.whatsapp.com us.cloud.langfuse.com"
  {
    printf '%s\n' $hosts $extra
  } | sort -u | while read -r h; do
    getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' || true
  done | sort -u
}

render_ruleset() {
  local ips set_elems=""
  ips="$(resolve_ipv4)"
  if [[ -n "$ips" ]]; then
    set_elems="$(printf '%s' "$ips" | paste -sd, -)"
  fi
  cat <<EOF
table inet ${TABLE} {
  set allowed4 {
    type ipv4_addr
    flags interval
    timeout 1h
    ${set_elems:+elements = { ${set_elems} }}
  }

  chain egress {
    type filter hook forward priority 0; policy accept;
    # Only police traffic leaving the container egress bridge.
    iifname "${EGRESS_IFACE:?set EGRESS_IFACE to the docker egress bridge}" jump policed
  }

  chain policed {
    ct state established,related accept
    # DNS so name resolution itself is never blocked by the allowlist.
    ip daddr ${RESOLVER} udp dport 53 accept
    ip daddr ${RESOLVER} tcp dport 53 accept
    ip daddr @allowed4 accept
    log prefix "hh-egress-drop " level warn
    drop
  }
}
EOF
}

cmd="${1:-print}"
case "$cmd" in
  print)
    EGRESS_IFACE="${EGRESS_IFACE:-br-PLACEHOLDER}" render_ruleset
    ;;
  apply)
    nft list table inet "${TABLE}" >/dev/null 2>&1 && nft delete table inet "${TABLE}"
    render_ruleset | nft -f -
    echo "applied table inet ${TABLE} on iface ${EGRESS_IFACE}"
    ;;
  refresh)
    # Re-resolve and replace only the set elements (ruleset stays loaded).
    ips="$(resolve_ipv4)"
    nft flush set inet "${TABLE}" allowed4
    while read -r ip; do
      [[ -n "$ip" ]] && nft add element inet "${TABLE}" allowed4 "{ ${ip} timeout 1h }"
    done <<<"$ips"
    echo "refreshed allowed4 ($(wc -w <<<"$ips" | tr -d ' ') addresses)"
    ;;
  *)
    echo "usage: $0 {apply|refresh|print}" >&2
    exit 1
    ;;
esac
