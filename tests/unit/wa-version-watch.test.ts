import { describe, expect, it, vi } from 'vitest';
import { createWaVersionWatch } from '../../src/ops/wa-version-watch.ts';
import type { WaVersion } from '../../src/transport/wa-version.ts';

// ADR-0006. The builder's stated tolerance is "an alert once a month or two
// telling me I need to update the version" — so this is edge-triggered like
// the health monitor: a standing condition alerts once, not once per check.

const PINNED: WaVersion = [2, 3000, 1043857760];
const NEWER: WaVersion = [2, 3000, 1050000000];

function harness() {
  const alerts: string[] = [];
  const logs: string[] = [];
  const watch = createWaVersionWatch({
    alert: async (text) => {
      alerts.push(text);
    },
    log: (line) => logs.push(line),
  });
  return { watch, alerts, logs };
}

/** Alerts are fired and forgotten inside a sync handler. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('wa version watch: staleness', () => {
  it('alerts when upstream has moved past the pin', async () => {
    const h = harness();
    h.watch.onEvent({ kind: 'stale', pinned: PINNED, upstream: NEWER });
    await settle();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain('2.3000.1050000000');
    expect(h.alerts[0]).toContain('2.3000.1043857760');
  });

  it('does not re-alert for the same upstream version (edge-triggered)', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.watch.onEvent({ kind: 'stale', pinned: PINNED, upstream: NEWER });
    }
    await settle();
    expect(h.alerts).toHaveLength(1);
  });

  it('alerts again when upstream moves to a different version', async () => {
    const h = harness();
    h.watch.onEvent({ kind: 'stale', pinned: PINNED, upstream: NEWER });
    h.watch.onEvent({ kind: 'stale', pinned: PINNED, upstream: [2, 3000, 1060000000] });
    await settle();
    expect(h.alerts).toHaveLength(2);
  });

  it('stays quiet — and re-arms — when the pin is current again', async () => {
    const h = harness();
    h.watch.onEvent({ kind: 'stale', pinned: PINNED, upstream: NEWER });
    h.watch.onEvent({ kind: 'current', version: NEWER });
    h.watch.onEvent({ kind: 'stale', pinned: NEWER, upstream: [2, 3000, 1070000000] });
    await settle();
    expect(h.alerts).toHaveLength(2); // the 'current' itself never alerts
    expect(h.logs.some((l) => l.includes('current'))).toBe(true);
  });
});

describe('wa version watch: fall-forward', () => {
  it('always alerts on an adoption — the pin in git is now wrong', async () => {
    const h = harness();
    h.watch.onEvent({ kind: 'adopted', from: PINNED, to: NEWER });
    h.watch.onEvent({ kind: 'adopted', from: NEWER, to: [2, 3000, 1060000000] });
    await settle();
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[0]).toContain('2.3000.1050000000');
    expect(h.alerts[0]?.toLowerCase()).toContain('pin');
  });

  it('alerts once when WhatsApp rejects us and there is nothing newer to try', async () => {
    const h = harness();
    h.watch.onEvent({ kind: 'no-upgrade', version: PINNED });
    h.watch.onEvent({ kind: 'no-upgrade', version: PINNED });
    await settle();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain('2.3000.1043857760');
  });
});

describe('wa version watch: probe failures', () => {
  it('logs a single probe failure without alerting (a blip is not an incident)', async () => {
    const h = harness();
    h.watch.onEvent({ kind: 'probe-failed' });
    await settle();
    expect(h.alerts).toEqual([]);
    expect(h.logs.some((l) => l.includes('probe'))).toBe(true);
  });

  it('alerts once the staleness check has been blind for too long', async () => {
    // The 2026-07-28 outage was a probe that failed silently for a month. The
    // pin means that is no longer fatal, but a permanently blind check must
    // still surface — it is the thing that would otherwise hide the next one.
    const h = harness();
    for (let i = 0; i < 10; i++) h.watch.onEvent({ kind: 'probe-failed' });
    await settle();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.toLowerCase()).toContain('probe');
  });

  it('re-arms the blindness alert after a successful probe', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.watch.onEvent({ kind: 'probe-failed' });
    h.watch.onEvent({ kind: 'current', version: PINNED });
    for (let i = 0; i < 10; i++) h.watch.onEvent({ kind: 'probe-failed' });
    await settle();
    expect(h.alerts).toHaveLength(2);
  });
});

describe('wa version watch: robustness', () => {
  it('never lets a failing alert channel escape into the transport', async () => {
    const watch = createWaVersionWatch({
      alert: async () => {
        throw new Error('telegram down');
      },
      log: () => {},
    });
    expect(() => watch.onEvent({ kind: 'adopted', from: PINNED, to: NEWER })).not.toThrow();
    await settle();
  });

  it('polls on an interval and stops cleanly', () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(async () => {});
      const watch = createWaVersionWatch({
        alert: async () => {},
        log: () => {},
        intervalMs: 1_000,
      });
      watch.startPolling(check);
      expect(check).toHaveBeenCalledTimes(1); // probes once at startup
      vi.advanceTimersByTime(3_000);
      expect(check).toHaveBeenCalledTimes(4);
      watch.stop();
      vi.advanceTimersByTime(5_000);
      expect(check).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a check that rejects', () => {
    vi.useFakeTimers();
    try {
      const watch = createWaVersionWatch({ alert: async () => {}, log: () => {}, intervalMs: 10 });
      expect(() =>
        watch.startPolling(async () => {
          throw new Error('nope');
        }),
      ).not.toThrow();
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
