// Router panel derivations (docs/specs/jev-turn-routing-plan.md §5b): pure
// over raw turn_route_log rows — every amber rule is pinned here; the SQL is
// covered by tests/integration/backoffice/router-health.test.ts.

import { describe, expect, it } from 'vitest';
import {
  deriveRouterHealth,
  type RouteLogRow,
  type RouterHealthInput,
} from '../../../src/backoffice/router-health.js';

const NOW = new Date('2026-10-29T12:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

const settled = {
  asksAnything: 0.95,
  intent: 'reminder',
  severalRequests: 0.05,
  refersBack: 0.05,
  weighsOptions: 0.05,
  scheduleReasoning: 0.05,
  correctsPrevious: 0.05,
};

function row(overrides: Partial<RouteLogRow> = {}): RouteLogRow {
  return {
    workflowId: 'wf',
    conversationId: 'conv-a',
    createdAt: minutesAgo(10),
    mode: 'shadow',
    tier: 'standard',
    proposed: 'standard',
    source: 'jev',
    latencyMs: 120,
    answers: settled,
    latestText: 'hi',
    ...overrides,
  };
}

function input(rows: RouteLogRow[], turns24h = rows.length): RouterHealthInput {
  return { now: NOW, turns24h, rows };
}

function statusOf(health: ReturnType<typeof deriveRouterHealth>, name: string) {
  const r = health.rows.find((x) => x.name === name);
  expect(r, `row ${name}`).toBeDefined();
  return r!;
}

describe('deriveRouterHealth', () => {
  it('reports the current mode from the newest row, and all-ok on healthy traffic', () => {
    const health = deriveRouterHealth(input([row(), row({ mode: 'on', createdAt: minutesAgo(1) })]));
    expect(health.mode).toBe('on');
    expect(health.rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('flags a silent router: turns ran in 24h but no route rows did', () => {
    const health = deriveRouterHealth(input([row({ createdAt: minutesAgo(60 * 30) })], 7));
    expect(statusOf(health, 'Last routed turn').status).toBe('amber');
  });

  it('is calm, not amber, when nothing has happened at all', () => {
    const health = deriveRouterHealth(input([], 0));
    expect(health.mode).toBeNull();
    expect(health.rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('flags a fallback streak of 3, ignoring pre-ruled turns', () => {
    const rows = [
      row({ source: 'fallback-error:timeout', createdAt: minutesAgo(1) }),
      row({ source: 'pre-rule:pending-actions', createdAt: minutesAgo(2) }),
      row({ source: 'fallback-error:timeout', createdAt: minutesAgo(3) }),
      row({ source: 'fallback-error:network', createdAt: minutesAgo(4) }),
      row({ source: 'jev', createdAt: minutesAgo(5) }),
    ];
    const r = statusOf(deriveRouterHealth(input(rows)), 'Fallback rate');
    expect(r.status).toBe('amber');
    expect(r.value).toContain('3 in a row');
  });

  it('flags a fallback rate above 20% of the last 20 routed turns', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ source: i % 4 === 1 ? 'fallback-error:http' : 'jev', createdAt: minutesAgo(i + 1) }),
    );
    expect(statusOf(deriveRouterHealth(input(rows)), 'Fallback rate').status).toBe('amber');
  });

  it('flags p95 Jev latency above 1s over the last 20', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ latencyMs: i < 2 ? 1400 : 100, createdAt: minutesAgo(i + 1) }),
    );
    expect(statusOf(deriveRouterHealth(input(rows)), 'Jev latency p95').status).toBe('amber');
  });

  it('flags a day where deep is over 40% of proposals (cost / injection)', () => {
    const rows = [
      row({ proposed: 'deep' }),
      row({ proposed: 'deep' }),
      row({ proposed: 'standard' }),
    ];
    expect(statusOf(deriveRouterHealth(input(rows)), 'Tier mix (24h)').status).toBe('amber');
  });

  it('flags a day where over half the Jev answers were unsettled', () => {
    const unsettled = { ...settled, refersBack: 0.5 };
    const rows = [row({ answers: unsettled }), row({ answers: unsettled }), row()];
    expect(statusOf(deriveRouterHealth(input(rows)), 'Tier mix (24h)').status).toBe('amber');
  });

  it('attributes a correction to the tier that produced the reply BEFORE it', () => {
    // conv-a: a deep turn, then a turn whose message corrects it.
    const rows = [
      row({ conversationId: 'conv-a', tier: 'deep', createdAt: minutesAgo(30) }),
      row({
        conversationId: 'conv-a',
        tier: 'standard',
        createdAt: minutesAgo(29),
        answers: { ...settled, correctsPrevious: 0.9 },
      }),
      row({ conversationId: 'conv-b', tier: 'standard', createdAt: minutesAgo(20) }),
      row({ conversationId: 'conv-b', tier: 'standard', createdAt: minutesAgo(19) }),
    ];
    const r = statusOf(deriveRouterHealth(input(rows)), 'Corrections per tier (7d)');
    expect(r.status).toBe('amber'); // deep 1/1 > standard 0/3
    expect(r.value).toContain('deep 1/1');
  });

  it('lists the most recent rows newest first for the turn view', () => {
    const health = deriveRouterHealth(
      input([row({ workflowId: 'old', createdAt: minutesAgo(9) }), row({ workflowId: 'new', createdAt: minutesAgo(1) })]),
    );
    expect(health.recent.map((r) => r.workflowId)).toEqual(['new', 'old']);
  });

  it('hands the turn view up to 100 recent rows — the panel pages through them', () => {
    const rows = Array.from({ length: 120 }, (_, i) => row({ workflowId: `wf-${i}`, createdAt: minutesAgo(i + 1) }));
    const health = deriveRouterHealth(input(rows));
    expect(health.recent).toHaveLength(100);
    expect(health.recent[0]!.workflowId).toBe('wf-0');
  });
});
