import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeadmanPinger } from '../../src/ops/deadman.js';

const PING_URL = 'https://hc-ping.com/some-uuid';
const INTERVAL_MS = 60_000;

describe('createDeadmanPinger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings immediately on start, then once per interval', async () => {
    const fetchFn = vi.fn(async () => new Response('OK', { status: 200 }));
    const pinger = createDeadmanPinger({ pingUrl: PING_URL, intervalMs: INTERVAL_MS, fetchFn });

    pinger.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(PING_URL, expect.objectContaining({ method: 'GET' }));

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('keeps pinging after a failed ping, reporting via onPingError', async () => {
    const failures: unknown[] = [];
    const fetchFn = vi
      .fn(async () => new Response('OK', { status: 200 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    const pinger = createDeadmanPinger({
      pingUrl: PING_URL,
      intervalMs: INTERVAL_MS,
      fetchFn,
      onPingError: (error) => failures.push(error),
    });

    pinger.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(failures).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2); // failed first ping did not stop the loop
  });

  it('reports a non-2xx response as a ping error (misconfigured check URL)', async () => {
    const failures: unknown[] = [];
    const fetchFn = vi.fn(async () => new Response('not found', { status: 404 }));
    const pinger = createDeadmanPinger({
      pingUrl: PING_URL,
      intervalMs: INTERVAL_MS,
      fetchFn,
      onPingError: (error) => failures.push(error),
    });

    pinger.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/404/);
  });

  it('stop() halts the schedule', async () => {
    const fetchFn = vi.fn(async () => new Response('OK', { status: 200 }));
    const pinger = createDeadmanPinger({ pingUrl: PING_URL, intervalMs: INTERVAL_MS, fetchFn });

    pinger.start();
    await vi.advanceTimersByTimeAsync(0);
    pinger.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent — calling it twice does not double the pings', async () => {
    const fetchFn = vi.fn(async () => new Response('OK', { status: 200 }));
    const pinger = createDeadmanPinger({ pingUrl: PING_URL, intervalMs: INTERVAL_MS, fetchFn });

    pinger.start();
    pinger.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(fetchFn).toHaveBeenCalledTimes(2); // immediate + one interval
  });
});
