// Router health signals (docs/specs/jev-turn-routing-plan.md §5b): pulled, not
// paged — a [route] log line at boot and on every fallback-streak edge, never
// a Telegram alert (a dead router degrades to today's behavior, not an outage).

import { describe, expect, it } from 'vitest';
import { createRouteStreakLog, probeJev } from '../../src/ops/route-health.js';
import { JevError, type JevClient } from '../../src/agent/jev-client.js';
import type { RouteDecision } from '../../src/agent/route-turn.js';

function decision(source: RouteDecision['source']): RouteDecision {
  return { tier: 'standard', proposed: 'standard', source, mode: 'shadow', questionsVersion: 'v' };
}

describe('probeJev', () => {
  it('logs ok with the answering model when Jev answers', async () => {
    const lines: string[] = [];
    const jev: JevClient = {
      ask: async () => ({ model: 'jev-1.14.0', answers: { ok: { type: 'noul', noul: 0.9 } }, inputTokens: 40 }),
    };

    const ok = await probeJev(jev, (l) => lines.push(l));

    expect(ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[route\] jev ok: jev-1\.14\.0 in \d+ms$/);
  });

  it('logs unreachable with the failure kind — and never throws', async () => {
    const lines: string[] = [];
    const jev: JevClient = {
      ask: async () => {
        throw new JevError('timeout', 'no response within the deadline');
      },
    };

    const ok = await probeJev(jev, (l) => lines.push(l));

    expect(ok).toBe(false);
    expect(lines[0]).toBe(
      '[route] jev unreachable: timeout — routed turns will fall back to standard',
    );
  });
});

describe('createRouteStreakLog', () => {
  it('logs only the edges of a fallback streak', () => {
    const lines: string[] = [];
    const streak = createRouteStreakLog((l) => lines.push(l));

    streak.observe(decision('jev'));
    streak.observe(decision('fallback-error:timeout'));
    streak.observe(decision('fallback-error:network'));
    streak.observe(decision('fallback-error:timeout'));
    streak.observe(decision('jev'));
    streak.observe(decision('jev'));

    expect(lines).toEqual([
      '[route] fallback streak started: fallback-error:timeout',
      '[route] fallback streak ended after 3 turn(s)',
    ]);
  });

  it('ignores pre-ruled turns — they never asked Jev, so they neither start nor end a streak', () => {
    const lines: string[] = [];
    const streak = createRouteStreakLog((l) => lines.push(l));

    streak.observe(decision('fallback-error:http'));
    streak.observe(decision('pre-rule:pending-actions'));
    streak.observe(decision('fallback-error:http'));
    streak.observe(decision('jev'));

    expect(lines).toEqual([
      '[route] fallback streak started: fallback-error:http',
      '[route] fallback streak ended after 2 turn(s)',
    ]);
  });
});
