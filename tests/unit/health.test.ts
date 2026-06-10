import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertChannel } from '../../src/ops/alerts.js';
import { createHealthMonitor } from '../../src/ops/health.js';

const GRACE_MS = 60_000;

function makeAlertChannel(): AlertChannel & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sendAlert: vi.fn(async (text: string) => {
      sent.push(text);
    }),
  };
}

describe('createHealthMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('alerts when the socket stays closed past the grace period', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('closed');
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toMatch(/down/i);
  });

  it('suppresses the alert when the socket reopens within the grace period (flap)', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('closed');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    monitor.onStateChange('open');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(alerts.sent).toHaveLength(0);
  });

  it('alerts immediately on logged-out — re-pair needs a human, grace would only delay', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('logged-out');
    await vi.advanceTimersByTimeAsync(0);

    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toMatch(/logged.?out|re-?pair/i);
  });

  it('sends a recovery alert when the socket reopens after a down alert', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('closed');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    monitor.onStateChange('open');
    await vi.advanceTimersByTimeAsync(0);

    expect(alerts.sent).toHaveLength(2);
    expect(alerts.sent[1]).toMatch(/reconnect|recover/i);
  });

  it('does not send a recovery alert on the initial connect', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('connecting');
    monitor.onStateChange('open');
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(alerts.sent).toHaveLength(0);
  });

  it('sends one down alert per outage even as states churn', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('closed');
    monitor.onStateChange('connecting');
    monitor.onStateChange('closed');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    monitor.onStateChange('connecting');
    monitor.onStateChange('closed');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(alerts.sent).toHaveLength(1);
  });

  // T14 drill 2 regression: a network outage keeps the Baileys adapter in
  // 'connecting' (retry loop) for up to ~4.3 min without ever reporting
  // 'closed' — the monitor must treat sustained not-open as down.
  it('alerts when the socket churns in connecting without reaching open (outage during retries)', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('open');
    monitor.onStateChange('connecting'); // adapter retrying — never says 'closed'
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toMatch(/down/i);

    monitor.onStateChange('open'); // network back, retry succeeded
    await vi.advanceTimersByTimeAsync(0);
    expect(alerts.sent).toHaveLength(2);
    expect(alerts.sent[1]).toMatch(/reconnect|recover/i);
  });

  it('treats connecting during an outage as still down, not as recovery', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('closed');
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    monitor.onStateChange('connecting');
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);

    expect(alerts.sent).toHaveLength(1);
  });

  it('keeps monitoring when the alert channel itself fails, reporting via onAlertError', async () => {
    const failures: unknown[] = [];
    const alertChannel: AlertChannel = {
      sendAlert: vi.fn(async () => {
        throw new Error('telegram alert failed: HTTP 500');
      }),
    };
    const monitor = createHealthMonitor({
      alertChannel,
      downGraceMs: GRACE_MS,
      onAlertError: (error) => failures.push(error),
    });

    monitor.onStateChange('closed');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    monitor.onStateChange('open');
    await vi.advanceTimersByTimeAsync(0);

    expect(failures).toHaveLength(2); // down alert + recovery alert both failed
    expect(alertChannel.sendAlert).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels a pending grace timer and ignores later state changes', async () => {
    const alerts = makeAlertChannel();
    const monitor = createHealthMonitor({ alertChannel: alerts, downGraceMs: GRACE_MS });

    monitor.onStateChange('closed');
    monitor.stop();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    monitor.onStateChange('logged-out');
    await vi.advanceTimersByTimeAsync(0);

    expect(alerts.sent).toHaveLength(0);
  });
});
