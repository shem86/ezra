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
# STATUS: T45 drill PASS on host (2026-06-15, docs/ops-drills.md). On-host
# enforcement is proven both directions: a non-listed host (1.1.1.1) is dropped,
# the allowlisted hosts + S3 + IMDS pass. DOCKER-USER/nftables coexistence held.
# Two on-host-only findings are baked into this script: the link-local IMDS
# allow (backup sidecar creds) and the S3-by-CIDR set (S3 can't be DNS-resolved
# — see the AWS_IP_RANGES_URL block). The destructive `apply` deletes the table
# before loading, so a render error fails OPEN — dry-run `nft -c -f -` before
# applying a change (a bad interval overlap did exactly this once).
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

# AWS S3 cannot be allowlisted by DNS like the CDN-fronted hosts: its address
# pool spans several large, per-query-randomized ranges, so a resolved A-record
# never matches the IP the AWS SDK next dials. Proven on-host at T45 — the
# backup-bucket endpoint and the connection the SDK actually opened landed on
# DISJOINT S3 IPs, and the policed chain dropped the real traffic. AWS instead
# PUBLISHES the authoritative ranges; we load those CIDRs straight into the
# interval set. Region must track the backup bucket (egress-allowlist.ts
# 'backup' category → s3.us-east-1.amazonaws.com).
readonly AWS_IP_RANGES_URL="${AWS_IP_RANGES_URL:-https://ip-ranges.amazonaws.com/ip-ranges.json}"
readonly S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
readonly S3_CIDR_CACHE="/var/lib/hh-egress/s3-${S3_REGION}-cidrs.txt"

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

# Emit the published S3 CIDRs for the backup region (see the block-comment by
# AWS_IP_RANGES_URL for why DNS can't do this). The set has `flags interval`, so
# these CIDR elements live alongside the resolved single-host addresses. We
# cache the last-good list: a transient fetch/parse failure falls back to it so
# the refresh timer can never silently strip S3 from the allowlist and break
# backups mid-day. Needs curl + jq on the host (installed by provision-host.sh).
aws_s3_cidrs() {
  local tmp cidrs
  tmp="$(mktemp)"
  cidrs=""
  if curl -fsS --max-time 15 "$AWS_IP_RANGES_URL" -o "$tmp" 2>/dev/null; then
    cidrs="$(jq -r --arg r "$S3_REGION" \
      '.prefixes[] | select(.service=="S3" and .region==$r) | .ip_prefix' \
      "$tmp" 2>/dev/null | sort -u)"
  fi
  rm -f "$tmp"
  if [[ -n "$cidrs" ]]; then
    mkdir -p "$(dirname "$S3_CIDR_CACHE")" 2>/dev/null \
      && printf '%s\n' "$cidrs" > "$S3_CIDR_CACHE" 2>/dev/null || true
    printf '%s\n' "$cidrs"
  elif [[ -s "$S3_CIDR_CACHE" ]]; then
    cat "$S3_CIDR_CACHE"
  fi
}

render_ruleset() {
  local ips nets host_elems="" net_elems=""
  ips="$(resolve_ipv4)"
  nets="$(aws_s3_cidrs)"
  if [[ -n "$ips" ]]; then
    host_elems="$(printf '%s' "$ips" | paste -sd, -)"
  fi
  if [[ -n "$nets" ]]; then
    net_elems="$(printf '%s' "$nets" | paste -sd, -)"
  fi
  cat <<EOF
table inet ${TABLE} {
  set allowed4 {
    type ipv4_addr
    flags interval
    timeout 1h
    ${host_elems:+elements = { ${host_elems} }}
  }

  # AWS S3 published CIDRs (aws_s3_cidrs) live in their OWN interval set: a
  # DNS-resolved single host IP in allowed4 routinely lands inside one of these
  # ranges, and nft rejects overlapping intervals WITHIN a set ("conflicting
  # intervals"). Two sets, two accepts — no overlap possible across them.
  set allowed_nets4 {
    type ipv4_addr
    flags interval
    timeout 1h
    ${net_elems:+elements = { ${net_elems} }}
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
    # EC2 instance metadata (IMDSv2) so the backup sidecar can fetch the
    # least-priv S3 role's temporary credentials (T45). Link-local, HTTP only;
    # Docker's bridge masquerade SNATs it to the instance IP so IMDS replies,
    # and the reply returns via the established rule above. Blast radius of a
    # compromised container reaching this is exactly the backup-bucket role —
    # acceptable; a dedicated creds path is a V2 option (see backup/README.md).
    ip daddr 169.254.169.254 tcp dport 80 accept
    ip daddr @allowed4 accept
    ip daddr @allowed_nets4 accept
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
    nets="$(aws_s3_cidrs)"
    nft flush set inet "${TABLE}" allowed4
    nft flush set inet "${TABLE}" allowed_nets4
    while read -r ip; do
      [[ -n "$ip" ]] && nft add element inet "${TABLE}" allowed4 "{ ${ip} timeout 1h }"
    done <<<"$ips"
    while read -r n; do
      [[ -n "$n" ]] && nft add element inet "${TABLE}" allowed_nets4 "{ ${n} timeout 1h }"
    done <<<"$nets"
    echo "refreshed allowed4 ($(wc -w <<<"$ips" | tr -d ' ') addresses) + allowed_nets4 ($(wc -w <<<"$nets" | tr -d ' ') nets)"
    ;;
  *)
    echo "usage: $0 {apply|refresh|print}" >&2
    exit 1
    ;;
esac
