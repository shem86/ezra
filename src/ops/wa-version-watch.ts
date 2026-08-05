import { formatWaVersion, type WaVersionEvent } from '../transport/wa-version.js';

// ADR-0006: the operator-facing half of the WhatsApp client-version policy.
// The version source decides what to *run*; this decides what the builder
// hears about it.
//
// Edge-triggered, deliberately — the same discipline as the health monitor
// (architecture decision 7): a standing condition alerts once and re-arms when
// it clears. The stated tolerance is one alert every month or two, and the
// measured upstream churn is roughly that (4–8 version bumps a year), so a
// per-check alert would be pure noise and would train the channel to be
// ignored.

/** Consecutive failed probes before the blindness itself becomes an alert. */
const BLIND_PROBE_ALERT_THRESHOLD = 7;

const DAILY_MS = 24 * 60 * 60 * 1_000;

export interface WaVersionWatchDeps {
  /** Independent alert channel (Telegram). Failures are swallowed. */
  alert: (text: string) => Promise<void>;
  log: (line: string) => void;
  /** How often to run the staleness check; defaults to daily. */
  intervalMs?: number;
}

export interface WaVersionWatch {
  /** Wire to `createWaVersionSource({ onEvent })`. Bound — safe to pass by reference. */
  onEvent: (event: WaVersionEvent) => void;
  /** Runs `check` now and then on the interval. */
  startPolling: (check: () => Promise<void>) => void;
  stop: () => void;
}

export function createWaVersionWatch(deps: WaVersionWatchDeps): WaVersionWatch {
  const intervalMs = deps.intervalMs ?? DAILY_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Upstream version we have already alerted about; null once cleared. */
  let notifiedStale: string | null = null;
  /** Rejected version we have already alerted about, for the same reason. */
  let notifiedNoUpgrade: string | null = null;
  let consecutiveProbeFailures = 0;
  let notifiedBlind = false;

  // An alert must never take the socket down with it: onEvent is called from
  // inside the transport's disconnect handling.
  function fireAlert(text: string): void {
    void deps.alert(text).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      deps.log(`[wa-version] alert failed: ${reason}`);
    });
  }

  function onProbeSucceeded(): void {
    consecutiveProbeFailures = 0;
    notifiedBlind = false;
  }

  function onEvent(event: WaVersionEvent): void {
    switch (event.kind) {
      case 'probe-failed': {
        consecutiveProbeFailures += 1;
        deps.log(
          `[wa-version] upstream probe failed (${String(consecutiveProbeFailures)} in a row)`,
        );
        // A single blip is not an incident — the pin still works without the
        // probe. A permanently blind check is, because it is what hid the
        // 2026-07-28 freeze for a month.
        if (consecutiveProbeFailures >= BLIND_PROBE_ALERT_THRESHOLD && !notifiedBlind) {
          notifiedBlind = true;
          fireAlert(
            `⚠️ ezra: the WhatsApp version probe has failed ${String(consecutiveProbeFailures)} times in a row.\n` +
              'The pinned version still works, but staleness checking is blind — ' +
              'check raw.githubusercontent.com egress on the host.',
          );
        }
        return;
      }

      case 'current': {
        onProbeSucceeded();
        // Clearing this re-arms the staleness alert for the next bump.
        notifiedStale = null;
        deps.log(`[wa-version] pin is current (${formatWaVersion(event.version)})`);
        return;
      }

      case 'stale': {
        onProbeSucceeded();
        const upstream = formatWaVersion(event.upstream);
        deps.log(`[wa-version] pin ${formatWaVersion(event.pinned)} is behind ${upstream}`);
        if (notifiedStale === upstream) return;
        notifiedStale = upstream;
        fireAlert(
          `📌 ezra: a newer WhatsApp client version is available.\n` +
            `pinned:   ${formatWaVersion(event.pinned)}\n` +
            `upstream: ${upstream}\n` +
            'Nothing is broken — ezra keeps running the pin. Update WA_CLIENT_VERSION ' +
            'in src/ops/config.ts when convenient (ADR-0006).',
        );
        return;
      }

      case 'adopted': {
        onProbeSucceeded();
        const to = formatWaVersion(event.to);
        deps.log(`[wa-version] fell forward ${formatWaVersion(event.from)} → ${to}`);
        // Always alerts: the running version no longer matches the pin in git,
        // and that divergence should never be discovered by archaeology.
        fireAlert(
          `🔄 ezra: WhatsApp rejected the pinned client version — fell forward automatically.\n` +
            `was: ${formatWaVersion(event.from)}\n` +
            `now: ${to}\n` +
            `Service is recovering on its own. Update the WA_CLIENT_VERSION pin to ${to} ` +
            'so a restart does not go back to the rejected one (ADR-0006).',
        );
        return;
      }

      case 'no-upgrade': {
        onProbeSucceeded();
        const version = formatWaVersion(event.version);
        deps.log(`[wa-version] rejected ${version} with nothing newer upstream`);
        if (notifiedNoUpgrade === version) return;
        notifiedNoUpgrade = version;
        fireAlert(
          `🚨 ezra: WhatsApp rejected client version ${version} and upstream has nothing newer.\n` +
            'Falling forward cannot fix this — the socket is retrying on a budget and will ' +
            'stop. This one needs a human (ADR-0006).',
        );
        return;
      }
    }
  }

  return {
    onEvent,

    startPolling(check: () => Promise<void>): void {
      const run = (): void => {
        void check().catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          deps.log(`[wa-version] staleness check failed: ${reason}`);
        });
      };
      run(); // answer "is the pin current?" at startup, not a day later
      timer = setInterval(run, intervalMs);
      // Never hold the process open just to check a version.
      timer.unref?.();
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
