// T16: the single source of truth for every host Ezra's production process is
// permitted to reach. The host-level nftables ruleset (infra/egress/) is
// rendered FROM this list, and tests/unit/egress-allowlist.test.ts keeps it
// honest — a new dependency that dials an unlisted host turns the suite red
// until the host is justified here.
//
// This is static, declared data (no env, no I/O) — it intentionally lives in
// src/ops rather than infra/ so `pnpm build` type-checks it and CI runs its
// drift test. Enforcement is still host-level (Docker's own iptables churn
// fights host nftables — see infra/runtime.md for the Compose+nftables split).
//
// Why hostnames and not IPs: WhatsApp, Google, and the model/embedding APIs
// all sit behind rotating CDN IPs, so the firewall resolves these names into
// nft sets on a timer rather than pinning addresses (infra/egress/nftables.sh).

export const egressCategories = [
  'model',
  'embeddings',
  'calendar',
  'tracing',
  'alerts',
  'deadman',
  'whatsapp',
  'backup',
  'tailscale',
] as const;

export type EgressCategory = (typeof egressCategories)[number];

export interface EgressDestination {
  /** Exact host, or the base domain when `subdomains` is set. */
  readonly host: string;
  /** When true, `host` and any `*.host` are allowed; otherwise exact only. */
  readonly subdomains?: boolean;
  readonly category: EgressCategory;
  /** Why this host is reachable — rendered into the firewall comment. */
  readonly reason: string;
}

export const egressAllowlist: readonly EgressDestination[] = [
  // --- Model + embeddings (the turn loop) -----------------------------------
  {
    host: 'api.anthropic.com',
    category: 'model',
    reason: 'Claude turn + classification calls (@ai-sdk/anthropic; not a src literal)',
  },
  {
    host: 'api.voyageai.com',
    category: 'embeddings',
    reason: 'Voyage embeddings for semantic recall + compaction (src/memory/embedder.ts)',
  },
  // --- Google Calendar (M5.5) -----------------------------------------------
  {
    host: 'oauth2.googleapis.com',
    category: 'calendar',
    reason: 'service-account token endpoint (src/tools/calendar-client.ts)',
  },
  {
    host: 'www.googleapis.com',
    category: 'calendar',
    reason: 'Calendar API events read/write (src/tools/calendar-client.ts)',
  },
  // --- Observability (T31) --------------------------------------------------
  {
    host: 'cloud.langfuse.com',
    subdomains: true,
    category: 'tracing',
    reason: 'Langfuse trace ingestion — EU host is the config default, us.* is the US region',
  },
  // --- Independent alerting + dead-man (T12) --------------------------------
  {
    host: 'api.telegram.org',
    category: 'alerts',
    reason: 'Telegram Bot API — the non-WhatsApp alert channel (src/ops/alerts.ts)',
  },
  {
    host: 'hc-ping.com',
    category: 'deadman',
    reason: 'healthchecks.io ping host — the configured DEADMAN_PING_URL target (T12)',
  },
  {
    host: 'healthchecks.io',
    subdomains: true,
    category: 'deadman',
    reason: 'healthchecks.io self-hosted/region variants of the dead-man check',
  },
  // --- WhatsApp transport (Baileys) -----------------------------------------
  // Baileys dials many rotating hosts under these two apexes (web socket,
  // media MMS, group servers); pinning subdomains rather than IPs.
  {
    host: 'whatsapp.net',
    subdomains: true,
    category: 'whatsapp',
    reason: 'Baileys socket + media + group servers (g.whatsapp.net, mmg.whatsapp.net, …)',
  },
  {
    host: 'whatsapp.com',
    subdomains: true,
    category: 'whatsapp',
    reason: 'Baileys web endpoints (web.whatsapp.com, …)',
  },
  {
    // 2026-06-17 incident: WhatsApp serves media (images/video) from Meta's
    // fbcdn.net CDN, which is neither whatsapp.net nor whatsapp.com. Without
    // this, a media fetch hits the default-deny firewall, the drop wedges
    // Baileys into a reconnect, and the dead-man trips a "service down" alert.
    // Runtime-resolved (whatsapp-cdn-shv-NN-<pop>.fbcdn.net) so it never shows
    // up as a src literal — the drift scan can't catch its absence; the named
    // test in egress-allowlist.test.ts is the guard.
    host: 'fbcdn.net',
    subdomains: true,
    category: 'whatsapp',
    reason: 'WhatsApp media CDN (whatsapp-cdn-*.fbcdn.net) — image/video downloads (2026-06-17)',
  },
  // --- Backups (T17 — AWS S3, same account/region as the EC2 host) ----------
  // Both the path-style regional endpoint and bucket virtual-host
  // (<bucket>.s3.us-east-1.amazonaws.com) sit under this subdomains entry.
  {
    host: 's3.us-east-1.amazonaws.com',
    subdomains: true,
    category: 'backup',
    reason: 'AWS S3 (us-east-1) — encrypted base backups + archived WAL (T17)',
  },
  {
    host: 's3.amazonaws.com',
    subdomains: true,
    category: 'backup',
    reason: 'AWS S3 global endpoint fallback (bucket virtual-host) — T17 backups',
  },
  // --- Backoffice exposure: Tailscale (BO-16) -------------------------------
  // The backoffice CONTAINER's own egress (Langfuse read API, Google Calendar,
  // Anthropic, Voyage) reuses the spine entries above — same hosts, already
  // allowed. The one genuinely new outbound is Tailscale, which runs on the
  // HOST (tailscaled / `tailscale serve`), not the docker egress bridge this
  // ruleset polices — so it is host-OUTPUT, not forwarded container traffic.
  // It is declared here to keep this list the single source of truth for ALL
  // of Ezra's outbound (a from-zero host whose firewall also polices OUTPUT,
  // or a future in-container tailscaled, then has it covered).
  {
    host: 'tailscale.com',
    subdomains: true,
    category: 'tailscale',
    reason: 'Tailscale coordination (controlplane.tailscale.com) + DERP relays (derpN.tailscale.com) — fronts the backoffice over the tailnet (BO-16/22)',
  },
  {
    host: 'tailscale.io',
    subdomains: true,
    category: 'tailscale',
    reason: 'Tailscale control/logging (log.tailscale.io) — host tailscaled',
  },
];

/** True when `host` is reachable under the allowlist (exact or subdomain). */
export function isHostAllowed(
  host: string,
  list: readonly EgressDestination[] = egressAllowlist,
): boolean {
  const needle = host.trim().toLowerCase();
  return list.some((d) => {
    const base = d.host.toLowerCase();
    if (needle === base) return true;
    // Dot boundary is load-bearing: 'notwhatsapp.net' must not match 'whatsapp.net'.
    return d.subdomains === true && needle.endsWith(`.${base}`);
  });
}
