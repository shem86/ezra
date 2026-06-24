import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ARTIFACT_PATH,
  renderArtifact,
} from '../../infra/egress/render-allowlist.ts';
import { egressAllowlist } from '../../src/ops/egress-allowlist.ts';

// V2_NOTES §4: the host firewall (infra/egress/nftables.sh) no longer shells
// out to `node render-allowlist.ts` — it reads the committed static artifact
// infra/egress/allowlist.generated.txt, so the box needs no Node. That trade is
// only safe if the committed artifact can never silently drift from the
// src/ops/egress-allowlist.ts source of truth. This unit test is that guard
// (mirrors the egress-allowlist.test.ts drift discipline): it re-runs the
// generator and fails if the committed bytes differ — regenerate with
// `node infra/egress/render-allowlist.ts --write`. Runs in the unit suite (no
// DB), so CI catches drift before a deploy ships a stale firewall list.

describe('egress allowlist generated artifact (V2_NOTES §4 drift guard)', () => {
  const onDisk = readFileSync(ARTIFACT_PATH, 'utf8');

  it('matches what render-allowlist.ts emits (regenerate with --write if this fails)', () => {
    expect(onDisk).toBe(renderArtifact());
  });

  it('contains every apex host declared in the source of truth', () => {
    const hostLines = onDisk
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    for (const d of egressAllowlist) {
      expect(hostLines, `artifact missing host ${d.host}`).toContain(d.host);
    }
  });

  it('carries a do-not-edit header the firewall skips as comments', () => {
    // nftables.sh strips `#`/blank lines, so the header must be comment lines —
    // a header without `#` would be fed to getent as a bogus hostname.
    const firstLine = onDisk.split('\n')[0] ?? '';
    expect(firstLine.startsWith('#')).toBe(true);
    expect(onDisk).toContain('DO NOT EDIT');
  });
});
