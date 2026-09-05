import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// that shape by invoking the script's helpers directly through its
// HH_EGRESS_LIB source-only seam — no nft, no kernel, no root, so they run in
// the unit suite on any machine. The `refresh_set_elements` cases go one layer
// further and put a stub `nft` on PATH, so the batch the real function hands
// the kernel is asserted rather than inferred from the renderer.

const SCRIPT = fileURLToPath(
  new URL('../../infra/egress/nftables.sh', import.meta.url),
);

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Source the script for its helpers only, then run one snippet against them. */
function runScript(
  snippet: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Run {
  const result = spawnSync('bash', ['-c', `source "$0"; ${snippet}`, SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HH_EGRESS_LIB: '1', ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function renderBatch(
  setName: string,
  timeout: string,
  elements: string,
  present: string,
): string {
  const run = runScript('render_refresh_batch "$1" "$2" "$3" "$4"', [
    setName,
    timeout,
    elements,
    present,
  ]);
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

/** A stand-in `nft` on PATH: fakes `list`, records the batch `-f` is handed. */
const NFT_STUB = [
  '#!/usr/bin/env bash',
  'if [[ "$1" == "list" ]]; then',
  '  if [[ -n "${NFT_LIST_FAILS:-}" ]]; then',
  '    echo "nft: Error: No such file or directory" >&2',
  '    exit 1',
  '  fi',
  '  printf %s "${NFT_LIST_OUTPUT:-}"',
  '  exit 0',
  'fi',
  'if [[ "$1" == "-f" ]]; then',
  '  cat > "${NFT_BATCH_LOG}"',
  '  exit 0',
  'fi',
  'echo "stub nft: unexpected argv: $*" >&2',
  'exit 99',
].join('\n');

/**
 * Drive the real `refresh_set_elements` against the stub. `batch` is the text
 * nft was handed, or null when nft was never asked to change anything.
 */
function refreshSet(
  setName: string,
  elements: string,
  env: NodeJS.ProcessEnv = {},
): Run & { readonly batch: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'hh-egress-'));
  const stub = join(dir, 'nft');
  writeFileSync(stub, NFT_STUB);
  chmodSync(stub, 0o755);
  const log = join(dir, 'batch.txt');
  const run = runScript('refresh_set_elements "$1" "$2" "$3"', [setName, '1h', elements], {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    NFT_BATCH_LOG: log,
    ...env,
  });
  return { ...run, batch: existsSync(log) ? readFileSync(log, 'utf8') : null };
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

  it('emits nothing at all for an element that is not an address or CIDR', () => {
    // `nft -f` reads a command language, so an element carrying nft syntax
    // would be executed rather than matched. The batch is all-or-nothing:
    // finding the bad token halfway through must still emit nothing.
    const run = runScript('render_refresh_batch "$1" "$2" "$3" "$4"', [
      'allowed4',
      '1h',
      '1.2.3.4 }; flush ruleset; add element x',
      listing('1.2.3.4'),
    ]);

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('refusing to batch malformed allowed4 element');
  });
});

describe('egress refresh (what refresh_set_elements actually hands nft)', () => {
  it('sends one batch that deletes held elements before re-adding them all', () => {
    const run = refreshSet('allowed4', '1.2.3.4\n9.9.9.9', {
      NFT_LIST_OUTPUT: listing('1.2.3.4', '10.0.0.45'),
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.batch).toBe(
      'delete element inet hh_egress allowed4 { 1.2.3.4 }\n' +
        'add element inet hh_egress allowed4 { 1.2.3.4 timeout 1h }\n' +
        // Newly resolved, so no delete; 10.0.0.45 is held but not resolved
        // this tick, so it is left alone to age out on its own clock.
        'add element inet hh_egress allowed4 { 9.9.9.9 timeout 1h }\n',
    );
  });

  it('leaves the set untouched on an empty resolve — nft is never invoked', () => {
    // A DNS blip must not rewrite the set. Asserting on the renderer cannot
    // show this: it emits nothing for empty input either way, so the guard
    // could be deleted outright with every renderer case still green.
    const run = refreshSet('allowed4', '   \n  ', { NFT_LIST_OUTPUT: listing('1.2.3.4') });

    expect(run.status).toBe(0);
    expect(run.batch).toBeNull();
    expect(run.stderr).toContain('resolved nothing for allowed4 — left untouched');
  });

  it('fails loudly rather than degrading to an add-only refresh when the set cannot be read', () => {
    // An unreadable set read as "holds nothing" emits no deletes at all — that
    // IS the add-only refresh whose timeouts never restart, returning silently
    // while the tick still prints "refreshed …" and exits 0.
    const run = refreshSet('allowed4', '1.2.3.4', { NFT_LIST_FAILS: '1' });

    expect(run.status).not.toBe(0);
    expect(run.batch).toBeNull();
    expect(run.stderr).toContain('cannot read set allowed4 — refusing an add-only refresh');
  });

  it('refuses a malformed element instead of feeding it to nft', () => {
    const run = refreshSet('allowed4', '1.2.3.4 }; flush ruleset', {
      NFT_LIST_OUTPUT: listing('1.2.3.4'),
    });

    expect(run.status).not.toBe(0);
    expect(run.batch).toBeNull();
  });
});

describe('egress script source-only seam', () => {
  it('announces itself rather than silently dispatching nothing', () => {
    // If HH_EGRESS_LIB ever leaked into the refresh unit's environment, the
    // timer would exit 0 having done nothing — a firewall refresh that
    // silently never runs, the failure mode this entry was twice bitten by.
    const run = spawnSync('bash', [SCRIPT, 'refresh'], {
      encoding: 'utf8',
      env: { ...process.env, HH_EGRESS_LIB: '1' },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('HH_EGRESS_LIB set — helpers loaded, no subcommand dispatched');
  });
});
