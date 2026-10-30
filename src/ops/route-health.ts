// Router health, the log-line half (docs/specs/jev-turn-routing-plan.md §5b).
// Deliberately NOT the Telegram alert channel: a dead router degrades every
// turn to standard — exactly the pre-routing behavior — so it is a degraded
// optimization, not an outage, and Telegram stays reserved for up/down. These
// lines sit next to [socket]/[spine] in `docker logs`; the backoffice Router
// panel reads the same story from turn_route_log.

import { JevError, type JevClient } from '../agent/jev-client.js';
import type { RouteDecision } from '../agent/route-turn.js';

/**
 * One tiny request at boot. Catches what the per-turn fallback hides: a key
 * that never worked, or an egress drop that the client's deadline turns into
 * a quiet timeout long before the ~10.5s egress fingerprint would show.
 */
export async function probeJev(jev: JevClient, log: (line: string) => void): Promise<boolean> {
  const started = performance.now();
  try {
    const response = await jev.ask(
      { ping: 'ok' },
      { ok: { type: 'noul', instructions: 'Is `ping` the word "ok"?' } },
    );
    log(`[route] jev ok: ${response.model} in ${Math.round(performance.now() - started)}ms`);
    return true;
  } catch (error) {
    const kind = error instanceof JevError ? error.kind : 'internal';
    log(`[route] jev unreachable: ${kind} — routed turns will fall back to standard`);
    return false;
  }
}

export interface RouteStreakLog {
  observe(decision: RouteDecision): void;
}

/**
 * Edge-triggered: one line when Jev starts failing, one when it answers
 * again — never a line per turn. Pre-ruled turns didn't ask Jev and are
 * ignored. In-memory and per-process by design: it narrates, it does not
 * persist (turn_route_log is the durable record).
 */
export function createRouteStreakLog(log: (line: string) => void): RouteStreakLog {
  let streak = 0;
  return {
    observe(decision) {
      if (decision.source.startsWith('pre-rule:')) return;
      if (decision.source.startsWith('fallback-error:')) {
        if (streak === 0) log(`[route] fallback streak started: ${decision.source}`);
        streak += 1;
        return;
      }
      if (streak > 0) {
        log(`[route] fallback streak ended after ${streak} turn(s)`);
        streak = 0;
      }
    },
  };
}
