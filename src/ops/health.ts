import type { TransportState } from '../transport/types.js';
import type { AlertChannel } from './alerts.js';

// Socket-health monitor (T12): turns Transport state changes into alerts on
// the independent channel. A dropped socket is an incident, not a silent
// state (architecture decision: silent edge failures are the ones that
// matter here).

export interface HealthMonitorDeps {
  alertChannel: AlertChannel;
  /**
   * How long the socket may sit in 'closed' before the down alert fires.
   * Baileys' own retry/backoff heals most flaps in seconds; alerting only
   * after the grace keeps the channel high-signal. SPEC bound: 5 minutes.
   */
  downGraceMs?: number;
  /** Alerting is best-effort — failures land here instead of throwing. */
  onAlertError?: (error: unknown) => void;
}

export interface HealthMonitor {
  /** Wire to Transport.onStateChange. */
  onStateChange(state: TransportState): void;
  stop(): void;
}

const DEFAULT_DOWN_GRACE_MS = 60_000;

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const downGraceMs = deps.downGraceMs ?? DEFAULT_DOWN_GRACE_MS;
  const onAlertError = deps.onAlertError ?? (() => {});

  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let downAlertSent = false;
  let stopped = false;

  function send(text: string): void {
    deps.alertChannel.sendAlert(text).catch(onAlertError);
  }

  function clearGraceTimer(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  return {
    onStateChange(state: TransportState): void {
      if (stopped) return;
      switch (state) {
        case 'open':
          clearGraceTimer();
          if (downAlertSent) {
            downAlertSent = false;
            send('✅ hh-assistant: WhatsApp socket reconnected');
          }
          return;
        case 'closed':
          // One alert per outage: if the grace timer is running or the
          // alert already went out, this is the same incident.
          if (graceTimer !== null || downAlertSent) return;
          graceTimer = setTimeout(() => {
            graceTimer = null;
            downAlertSent = true;
            send(
              `⚠️ hh-assistant: WhatsApp socket down — no reconnect for ${String(Math.round(downGraceMs / 1000))}s`,
            );
          }, downGraceMs);
          return;
        case 'logged-out':
          // Unrecoverable without a human: no grace period, and it counts
          // as a sent down-alert so the eventual re-pair triggers recovery.
          clearGraceTimer();
          if (!downAlertSent) {
            downAlertSent = true;
            send('🚨 hh-assistant: WhatsApp LOGGED OUT — re-pair required (pnpm pair, docs/pairing.md)');
          }
          return;
        case 'connecting':
          // Neither up nor down: an in-flight reconnect during an outage
          // must not cancel the grace timer or count as recovery.
          return;
      }
    },

    stop(): void {
      stopped = true;
      clearGraceTimer();
    },
  };
}
