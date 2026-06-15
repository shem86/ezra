// infra/egress/render-allowlist.ts — emit the egress allowlist as data the
// host firewall consumes, straight from the one source of truth in
// src/ops/egress-allowlist.ts. Run with bare node (type-stripping, spikes
// pattern); the host already has Node 22 as the app runtime, so nftables.sh
// calls this at apply/refresh time instead of carrying a committed copy that
// could drift.
//
//   node infra/egress/render-allowlist.ts            # newline-separated hosts
//   node infra/egress/render-allowlist.ts --table    # host  category  reason
//
// `--table` is for humans (and the runbook); the bare form is for the resolver.

import { egressAllowlist } from '../../src/ops/egress-allowlist.ts';

const asTable = process.argv.includes('--table');

if (asTable) {
  const rows = egressAllowlist.map((d) => {
    const host = d.subdomains === true ? `*.${d.host}` : d.host;
    return `${host}\t${d.category}\t${d.reason}`;
  });
  process.stdout.write(`${['HOST\tCATEGORY\tREASON', ...rows].join('\n')}\n`);
} else {
  // Bare apex hosts only; the firewall resolves each and (for subdomains
  // entries) also resolves the common service subdomains it knows about. DNS
  // for a rotating subdomain it has not seen is handled by the resolve-on-miss
  // refresh loop in nftables.sh — apex coverage is the floor, not the ceiling.
  const hosts = egressAllowlist.map((d) => d.host);
  process.stdout.write(`${[...new Set(hosts)].join('\n')}\n`);
}
