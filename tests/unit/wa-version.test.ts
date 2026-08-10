import { describe, expect, it, vi } from 'vitest';
import {
  createWaVersionSource,
  formatWaVersion,
  interpretProbeResult,
  parseWaVersion,
  sameWaVersion,
  type WaVersion,
  type WaVersionEvent,
} from '../../src/transport/wa-version.ts';

// The 2026-07-28 outage: the WhatsApp Web client version is enforced
// SERVER-side, and ours silently froze at the Baileys-bundled fallback because
// the upstream probe failed behind the egress allowlist without throwing.
// These tests pin the three behaviours that make that unrepeatable: the probe
// result is interpreted (not just try/caught), the pin is authoritative, and a
// version rejection falls forward instead of retrying the same dead version.

const PINNED: WaVersion = [2, 3000, 1043857760];
const NEWER: WaVersion = [2, 3000, 1050000000];

describe('parseWaVersion / formatWaVersion', () => {
  it('parses a dotted triple', () => {
    expect(parseWaVersion('2.3000.1043857760')).toEqual([2, 3000, 1043857760]);
  });

  it('round-trips through format', () => {
    expect(formatWaVersion(PINNED)).toBe('2.3000.1043857760');
    expect(parseWaVersion(formatWaVersion(PINNED))).toEqual(PINNED);
  });

  it('rejects malformed input rather than guessing', () => {
    for (const bad of ['', '2.3000', '2.3000.1.4', 'a.b.c', '2.3000.x', '2..3']) {
      expect(parseWaVersion(bad), `expected ${bad} to be rejected`).toBeNull();
    }
  });

  it('rejects negative and non-integer components', () => {
    expect(parseWaVersion('2.-3000.1')).toBeNull();
    expect(parseWaVersion('2.3000.1.5')).toBeNull();
  });
});

describe('sameWaVersion', () => {
  it('compares component-wise', () => {
    expect(sameWaVersion(PINNED, [2, 3000, 1043857760])).toBe(true);
    expect(sameWaVersion(PINNED, NEWER)).toBe(false);
  });
});

describe('interpretProbeResult (the root-cause regression guard)', () => {
  // fetchLatestBaileysVersion() RESOLVES with {version: <bundled fallback>,
  // isLatest: false, error} when the fetch fails — it does not throw. A caller
  // that only try/catches silently accepts a stale version. That is exactly
  // what went dark for 5.7 days.
  it('returns null when the probe carried an error, even though a version is present', () => {
    expect(
      interpretProbeResult({
        version: [2, 3000, 1035194821],
        isLatest: false,
        error: new Error('UND_ERR_CONNECT_TIMEOUT'),
      }),
    ).toBeNull();
  });

  it('returns null when the probe reports it is not the latest', () => {
    expect(interpretProbeResult({ version: [2, 3000, 1035194821], isLatest: false })).toBeNull();
  });

  it('returns the version on a clean probe', () => {
    expect(interpretProbeResult({ version: [2, 3000, 1043857760], isLatest: true })).toEqual(
      PINNED,
    );
  });

  it('returns null for a structurally bad payload', () => {
    expect(interpretProbeResult({ isLatest: true })).toBeNull();
    expect(interpretProbeResult({ version: [2, 3000], isLatest: true })).toBeNull();
    expect(interpretProbeResult({ version: 'nope' as unknown, isLatest: true })).toBeNull();
  });
});

function harness(
  fetchUpstream: () => Promise<WaVersion | null>,
  pinned: WaVersion = PINNED,
): { source: ReturnType<typeof createWaVersionSource>; events: WaVersionEvent[] } {
  const events: WaVersionEvent[] = [];
  const source = createWaVersionSource({
    pinned,
    fetchUpstream,
    onEvent: (e) => events.push(e),
  });
  return { source, events };
}

describe('createWaVersionSource — the pin is authoritative', () => {
  it('serves the pinned version before any probe', () => {
    const { source } = harness(async () => NEWER);
    expect(source.current()).toEqual(PINNED);
  });

  it('does NOT swap to upstream on a staleness check — it only reports', async () => {
    const { source, events } = harness(async () => NEWER);
    await source.checkUpstream();
    expect(source.current()).toEqual(PINNED);
    expect(events).toEqual([{ kind: 'stale', pinned: PINNED, upstream: NEWER }]);
  });

  it('reports current when upstream matches the pin', async () => {
    const { source, events } = harness(async () => PINNED);
    await source.checkUpstream();
    expect(events).toEqual([{ kind: 'current', version: PINNED }]);
  });

  it('reports a failed probe instead of swallowing it', async () => {
    const { source, events } = harness(async () => null);
    await source.checkUpstream();
    expect(events).toEqual([{ kind: 'probe-failed' }]);
    expect(source.current()).toEqual(PINNED);
  });

  it('survives a probe that throws', async () => {
    const { source, events } = harness(async () => {
      throw new Error('boom');
    });
    await expect(source.checkUpstream()).resolves.toBeUndefined();
    expect(events).toEqual([{ kind: 'probe-failed' }]);
    expect(source.current()).toEqual(PINNED);
  });
});

describe('createWaVersionSource — fall forward on rejection', () => {
  it('adopts a newer upstream version and reports the adoption', async () => {
    const { source, events } = harness(async () => NEWER);
    await expect(source.fallForward()).resolves.toBe(true);
    expect(source.current()).toEqual(NEWER);
    expect(events).toEqual([{ kind: 'adopted', from: PINNED, to: NEWER }]);
  });

  it('reports no-upgrade when upstream still equals what was just rejected', async () => {
    const { source, events } = harness(async () => PINNED);
    await expect(source.fallForward()).resolves.toBe(false);
    expect(source.current()).toEqual(PINNED);
    expect(events).toEqual([{ kind: 'no-upgrade', version: PINNED }]);
  });

  it('reports no-upgrade when the probe fails — there is nothing to fall forward to', async () => {
    const { source, events } = harness(async () => null);
    await expect(source.fallForward()).resolves.toBe(false);
    expect(source.current()).toEqual(PINNED);
    expect(events).toEqual([{ kind: 'probe-failed' }]);
  });

  it('does not re-adopt the same version twice', async () => {
    const fetchUpstream = vi.fn(async () => NEWER);
    const { source, events } = harness(fetchUpstream);
    await expect(source.fallForward()).resolves.toBe(true);
    await expect(source.fallForward()).resolves.toBe(false);
    expect(source.current()).toEqual(NEWER);
    expect(events).toEqual([
      { kind: 'adopted', from: PINNED, to: NEWER },
      { kind: 'no-upgrade', version: NEWER },
    ]);
  });

  it('compares against the ADOPTED version, not the original pin', async () => {
    const versions = [NEWER, PINNED];
    let i = 0;
    const { source } = harness(async () => versions[i++]!);
    await source.fallForward(); // adopts NEWER
    // Upstream now reports the original pin again: that is a change relative to
    // the adopted version, so it is a legitimate fall-forward target.
    await expect(source.fallForward()).resolves.toBe(true);
    expect(source.current()).toEqual(PINNED);
  });

  it('never lets a broken observer take the transport down', async () => {
    const source = createWaVersionSource({
      pinned: PINNED,
      fetchUpstream: async () => NEWER,
      onEvent: () => {
        throw new Error('observer exploded');
      },
    });
    await expect(source.fallForward()).resolves.toBe(true);
    expect(source.current()).toEqual(NEWER);
  });
});
