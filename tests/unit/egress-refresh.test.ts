import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The egress refresh timer's ONE job is to keep the nft allowlist sets alive
// under their 1h element timeout. It did not: `nft add element` on an element
// the set already holds does NOT restart that element's timeout (upstream is
// explicit that only the packet-path `update` operation refreshes a previous
// timeout), so every element died exactly 1h after its FIRST insertion and its
// traffic was dropped until a later tick re-created it.
//
// On the host that showed up as 13 dropped dead-man SYNs to hc-ping.com at
// 2026-09-03T23:55Z and again at 00:57Z — ~hourly, because hc-ping.com's four
// A records never rotate and so never earned a fresh element the way a
// rotating name does. Measured proof: 47s after a SUCCESSFUL refresh tick had
// re-added them, all four still read `expires 43m` rather than 60m.
//
// The fix is delete-then-add inside one atomic `nft -f` batch. These tests pin
// that shape by invoking the script's renderer directly through its
// HH_EGRESS_LIB source-only seam — no nft, no kernel, no root, so it runs in
// the unit suite on any machine.

const SCRIPT = fileURLToPath(
  new URL('../../infra/egress/nftables.sh', import.meta.url),
);

function renderBatch(
  setName: string,
  timeout: string,
  elements: string,
  present: string,
): string {
  return execFileSync(
    'bash',
    [
      '-c',
      'source "$0"; render_refresh_batch "$1" "$2" "$3" "$4"',
      SCRIPT,
      setName,
      timeout,
      elements,
      present,
    ],
    { encoding: 'utf8', env: { ...process.env, HH_EGRESS_LIB: '1' } },
  );
}

/** A set listing shaped like real `nft list set` output. */
function listing(...tokens: readonly string[]): string {
  return `table inet hh_egress {
\tset allowed4 {
\t\ttype ipv4_addr
\t\tflags interval
\t\ttimeout 1h
\t\telements = { ${tokens.map((t) => `${t} expires 43m2s823ms`).join(',\n\t\t\t     ')} }
\t}
}`;
}

describe('egress refresh batch (nft element timeouts do not self-refresh)', () => {
  it('deletes before re-adding a held element, so its timeout restarts', () => {
    const batch = renderBatch('allowed4', '1h', '178.63.26.145', listing('178.63.26.145'));

    expect(batch).toContain('delete element inet hh_egress allowed4 { 178.63.26.145 }');
    expect(batch).toContain(
      'add element inet hh_egress allowed4 { 178.63.26.145 timeout 1h }',
    );
    // Order is the whole point: an add before its delete would leave the
    // element with its ORIGINAL expiry, which is exactly the bug.
    expect(batch.indexOf('delete element')).toBeLessThan(batch.indexOf('add element'));
  });

  it('never emits a bare add for a held element (the 2026-09-03 regression)', () => {
    const held = ['178.63.26.145', '176.9.71.146', '188.40.122.95', '159.69.66.229'];
    const batch = renderBatch('allowed4', '1h', held.join('\n'), listing(...held));

    for (const ip of held) {
      expect(
        batch,
        `${ip} was re-added without a preceding delete — its timeout would not restart`,
      ).toContain(`delete element inet hh_egress allowed4 { ${ip} }`);
    }
    expect(batch.match(/^delete element /gm)).toHaveLength(held.length);
    expect(batch.match(/^add element /gm)).toHaveLength(held.length);
  });

  it('adds a newly resolved element without a delete', () => {
    // `delete element` on an element the set does not hold aborts the whole
    // atomic batch, taking every other element's refresh down with it.
    const batch = renderBatch('allowed4', '1h', '1.2.3.4', listing('9.9.9.9'));

    expect(batch).not.toContain('delete element');
    expect(batch.trim()).toBe('add element inet hh_egress allowed4 { 1.2.3.4 timeout 1h }');
  });

  it('matches held elements whole, not by substring', () => {
    // A held 10.0.0.45 must not make 10.0.0.4 look present — that would emit a
    // delete for an absent element and fail the batch.
    const batch = renderBatch('allowed4', '1h', '10.0.0.4', listing('10.0.0.45'));

    expect(batch).not.toContain('delete element');
    expect(batch).toContain('add element inet hh_egress allowed4 { 10.0.0.4 timeout 1h }');
  });

  it('refreshes CIDR elements too (the S3 backup ranges in allowed_nets4)', () => {
    // allowed_nets4 carries AWS's published S3 ranges, which are just as static
    // as hc-ping's addresses — so backups were exposed to the same hourly gap.
    const batch = renderBatch('allowed_nets4', '1h', '52.216.0.0/15', listing('52.216.0.0/15'));

    expect(batch).toContain('delete element inet hh_egress allowed_nets4 { 52.216.0.0/15 }');
    expect(batch).toContain(
      'add element inet hh_egress allowed_nets4 { 52.216.0.0/15 timeout 1h }',
    );
  });

  it('emits nothing for an empty resolve rather than rewriting the set', () => {
    expect(renderBatch('allowed4', '1h', '', listing('1.2.3.4'))).toBe('');
  });
});
