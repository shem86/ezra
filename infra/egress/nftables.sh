#!/usr/bin/env bash
# infra/egress/nftables.sh — host-level egress allowlist for the Ezra container
# (T16 v0). Default-deny on the container's forwarded egress; allow only the
# hosts declared in src/ops/egress-allowlist.ts — read from the committed,
# generated allowlist.generated.txt (no host Node; V2_NOTES §4) — plus DNS and
# established flows. Everything else is logged and dropped.
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
# rotating subdomains the apps actually hit, and ACCUMULATES answers rather
# than replacing them (see the refresh subcommand) because single-record
# rotators outpace any sane timer cadence.
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
#   EGRESS_IFACE=hh-egress0 infra/egress/nftables.sh apply    # build + load ruleset
#   EGRESS_IFACE=hh-egress0 infra/egress/nftables.sh refresh  # re-resolve sets only
#   infra/egress/nftables.sh print                            # dump rendered ruleset
# The bridge name is pinned to hh-egress0 in docker-compose.prod.yml
# (com.docker.network.bridge.name) — a STATIC iifname, no inspect needed.
set -euo pipefail

readonly TABLE="hh_egress"
readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly RESOLVER="${RESOLVER:-169.254.169.253}" # Docker's embedded DNS / VPC resolver
# Committed static allowlist artifact, generated from src/ops/egress-allowlist.ts
# by render-allowlist.ts at author/CI time (V2_NOTES §4). Reading this file
# instead of shelling out to `node` is what keeps the host firewall Node-free —
# the app is containerized, and the CD checkout already lands this on the host.
readonly ALLOWLIST_FILE="${HERE}/allowlist.generated.txt"

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
# space-separated IPv4 list. The apex list comes from the committed static
# artifact (ALLOWLIST_FILE) — drift from src is CI-guarded, so reading the file
# stays in lockstep with src without needing host Node (V2_NOTES §4). Comment
# (`#…`) and blank lines in the artifact are skipped.
resolve_ipv4() {
  local hosts extra
  if [[ ! -r "$ALLOWLIST_FILE" ]]; then
    echo "egress allowlist artifact missing: $ALLOWLIST_FILE" >&2
    exit 1
  fi
  hosts="$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$ALLOWLIST_FILE")"
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

# --- refresh helpers -------------------------------------------------------
# An element timeout is NOT restarted by re-adding the element. Upstream is
# explicit that only the packet-path `update` operation refreshes a previous
# element timeout, while plain `add` does not — and the host agreed: at
# 2026-09-04T01:16Z, 47s after a SUCCESSFUL refresh tick had re-added them,
# hc-ping.com's four addresses still read `expires 43m`, not 60m.
#
# So the original add-only refresh never held anything past the hour. Every
# element died exactly 1h after its FIRST insertion and stayed dropped until a
# later tick re-created it — an ~hourly outage window one tick wide. It bit the
# STABLE addresses hardest: a rotating name (oauth2.googleapis.com) keeps
# producing brand-new answers that enter as brand-new elements carrying a full
# hour, whereas hc-ping.com's four A records never change and so never earned a
# fresh element. Seen as 13 dropped dead-man SYNs at 2026-09-03T23:55Z and
# again at 00:57Z, plus the same pattern against Google and Meta addresses.
#
# Restarting a timeout therefore takes delete-then-add, and both halves go into
# ONE `nft -f` batch: nft applies a batch as a single kernel transaction (there
# is "no moment when the firewall is partially configured"), so the element is
# never observably absent and the reset cannot open a drop window of its own.
render_refresh_batch() {
  local set_name="$1" timeout="$2" elements="$3" present="$4"
  local held elem
  # The element tokens the set currently holds, one per line. The delete is
  # emitted ONLY for elements actually present, because `delete element` on a
  # missing element aborts the whole atomic batch. In steady state a resolved
  # element is re-timed every tick and so never approaches expiry, which is
  # what keeps this snapshot from racing its own apply.
  held="$(printf '%s' "$present" | tr ',' '\n' \
    | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?' || true)"
  for elem in $elements; do
    # -x -F: an exact whole-line token match, so a held 10.0.0.45 is never
    # mistaken for 10.0.0.4 (a substring test would emit a delete for an
    # element that is not there and fail the batch).
    if printf '%s\n' "$held" | grep -qxF "$elem"; then
      printf 'delete element inet %s %s { %s }\n' "$TABLE" "$set_name" "$elem"
    fi
    printf 'add element inet %s %s { %s timeout %s }\n' \
      "$TABLE" "$set_name" "$elem" "$timeout"
  done
}

# Give every element resolved for set $1 a fresh $2 timeout, atomically.
refresh_set_elements() {
  local set_name="$1" timeout="$2" elements="$3" batch
  # A DNS blip (or a failed ip-ranges fetch against a cold cache) must never
  # rewrite the set: with nothing resolved there is nothing to refresh, and the
  # elements already held keep aging out on their own clock. Failing closed
  # here would drop the very traffic the allowlist exists to permit.
  if [[ -z "${elements//[[:space:]]/}" ]]; then
    echo "refresh: resolved nothing for ${set_name} — left untouched" >&2
    return 0
  fi
  batch="$(render_refresh_batch "$set_name" "$timeout" "$elements" \
    "$(nft list set inet "${TABLE}" "${set_name}" 2>/dev/null || true)")"
  printf '%s' "$batch" | nft -f -
}

# Test seam: `HH_EGRESS_LIB=1 source nftables.sh` loads the helpers above
# WITHOUT dispatching a subcommand, so the batch renderer is unit-testable off
# the host (tests/unit/egress-refresh.test.ts), where there is no nft and no
# kernel to hold a set.
if [[ -n "${HH_EGRESS_LIB:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi

cmd="${1:-print}"
case "$cmd" in
  print)
    EGRESS_IFACE="${EGRESS_IFACE:-hh-egress0}" render_ruleset
    ;;
  apply)
    nft list table inet "${TABLE}" >/dev/null 2>&1 && nft delete table inet "${TABLE}"
    render_ruleset | nft -f -
    echo "applied table inet ${TABLE} on iface ${EGRESS_IFACE}"
    ;;
  refresh)
    # Re-resolve the current answers and give them a FRESH timeout on top of
    # the loaded sets — never flush first. Some allowlisted names
    # (oauth2.googleapis.com, the WhatsApp media CDN on fbcdn.net) answer with
    # a SINGLE A record that rotates every few minutes, so a flush-and-replace
    # pins the set to whichever answer this tick happened to get; the container
    # then resolves the next one and its SYNs are dropped until the answers
    # line up again (backoffice /api/status spent 10.5s in undici's connect
    # timeout on exactly this — STATUS.md item 8, 2026-09-03). Elements absent
    # from this tick's answers are left alone and age out on their own clock,
    # so the set still holds every answer seen in the last hour.
    ips="$(resolve_ipv4)"
    nets="$(aws_s3_cidrs)"
    refresh_set_elements allowed4 1h "$ips"
    refresh_set_elements allowed_nets4 1h "$nets"
    echo "refreshed allowed4 (+$(wc -w <<<"$ips" | tr -d ' ') addresses resolved, $(nft list set inet "${TABLE}" allowed4 | grep -oE '([0-9]+\.){3}[0-9]+' | wc -l | tr -d ' ') held) + allowed_nets4 (+$(wc -w <<<"$nets" | tr -d ' ') nets)"
    ;;
  *)
    echo "usage: $0 {apply|refresh|print}" >&2
    exit 1
    ;;
esac
