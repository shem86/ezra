// External dead-man's switch (T12): an in-process monitor cannot report
// that its own process or host died. The box pings a healthchecks.io-style
// URL on a schedule; the alerting happens from OUTSIDE when pings stop.

export interface DeadmanPingerDeps {
  pingUrl: string;
  /** Must be ≤ half the check service's alert window (T14 drill: 2× interval). */
  intervalMs?: number;
  /** Test seam; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Ping failures are reported here, never thrown — a missed ping is the
   * signal the external service exists to catch, not a local crash.
   */
  onPingError?: (error: unknown) => void;
}

export interface DeadmanPinger {
  start(): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createDeadmanPinger(deps: DeadmanPingerDeps): DeadmanPinger {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchFn = deps.fetchFn ?? fetch;
  const onPingError = deps.onPingError ?? (() => {});

  let timer: ReturnType<typeof setInterval> | null = null;

  async function ping(): Promise<void> {
    try {
      const response = await fetchFn(deps.pingUrl, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`dead-man ping rejected: HTTP ${String(response.status)}`);
      }
    } catch (error) {
      onPingError(error);
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      void ping();
      timer = setInterval(() => {
        void ping();
      }, intervalMs);
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
