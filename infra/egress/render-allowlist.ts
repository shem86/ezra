// infra/egress/render-allowlist.ts — emit the egress allowlist as data the
// host firewall consumes, straight from the one source of truth in
// src/ops/egress-allowlist.ts. Run with bare node (type-stripping, spikes
// pattern).
//
// V2_NOTES §4: this is now the GENERATOR, run at author/CI time, NOT on the
// host. `nftables.sh` reads the committed static artifact
// `infra/egress/allowlist.generated.txt` instead of shelling out to host
// `node`, so the firewall no longer requires Node on the box. This file stays
// the source-of-truth renderer; a unit drift test
// (tests/unit/egress-allowlist-artifact.test.ts) fails CI if the committed
// artifact diverges from what this emits — re-run `--write` to regenerate.
//
//   node infra/egress/render-allowlist.ts            # newline-separated hosts (stdout)
//   node infra/egress/render-allowlist.ts --table    # host  category  reason (humans/runbook)
//   node infra/egress/render-allowlist.ts --write     # (re)generate the committed artifact
//   node infra/egress/render-allowlist.ts --check     # exit 1 if the artifact is stale (drift)
//
// `--table` is for humans (and the runbook); the bare form is for the resolver.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { egressAllowlist } from '../../src/ops/egress-allowlist.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Path to the committed static artifact the host firewall reads. */
export const ARTIFACT_PATH = join(here, 'allowlist.generated.txt');

/**
 * The exact bytes of the committed artifact: a "do-not-edit" header (shell-
 * comment lines `nftables.sh` skips) followed by the bare apex hosts, one per
 * line. Apex coverage is the floor — the firewall resolves each name (and the
 * known rotating service subdomains baked into nftables.sh) at apply/refresh
 * time; this static list never sees a runtime-only subdomain, which is exactly
 * why egress-allowlist.test.ts name-checks those.
 */
export function renderArtifact(): string {
  const hosts = [...new Set(egressAllowlist.map((d) => d.host))];
  const header = [
    '# infra/egress/allowlist.generated.txt — GENERATED, DO NOT EDIT BY HAND.',
    '# Source of truth: src/ops/egress-allowlist.ts. Regenerate with:',
    '#   node infra/egress/render-allowlist.ts --write',
    '# Drift is CI-guarded (tests/unit/egress-allowlist-artifact.test.ts).',
    '# nftables.sh reads this file so the host firewall needs no Node (V2_NOTES §4).',
  ];
  return `${[...header, ...hosts].join('\n')}\n`;
}

function main(argv: readonly string[]): void {
  if (argv.includes('--write')) {
    writeFileSync(ARTIFACT_PATH, renderArtifact());
    process.stdout.write(`wrote ${ARTIFACT_PATH}\n`);
  } else if (argv.includes('--check')) {
    const onDisk = readFileSync(ARTIFACT_PATH, 'utf8');
    if (onDisk !== renderArtifact()) {
      process.stderr.write(
        `${ARTIFACT_PATH} is stale — run: node infra/egress/render-allowlist.ts --write\n`,
      );
      process.exit(1);
    }
    process.stdout.write('allowlist artifact is up to date\n');
  } else if (argv.includes('--table')) {
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
}

// Run the CLI only when invoked directly (node infra/egress/render-allowlist.ts
// …), never on import — the drift test imports renderArtifact()/ARTIFACT_PATH
// and must not trigger stdout writes or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
