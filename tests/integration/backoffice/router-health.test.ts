// Router panel SQL against real Postgres (the `_test` sibling, issue #5): the
// turn_route_log read parses through Zod, pulls the latest message text out of
// the stored request, and counts today's handleTurn workflows from the DBOS
// journal. Rows are seeded 100 days in the FUTURE and read with `now` there,
// so other suites' route rows (handle-turn.test.ts writes them) can't be the
// newest — the assertions see exactly this file's rows on top.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../../src/memory/migrate.ts';
import { getRouterHealth } from '../../../src/backoffice/router-health.ts';

const databaseUrl = process.env.DATABASE_URL!;
const runId = `rh-${Date.now()}`;
const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1_000);
let db: Client;

const answers = {
  asksAnything: 0.96,
  intent: 'planning_or_advice',
  severalRequests: 0.04,
  refersBack: 0.1,
  weighsOptions: 0.93,
  scheduleReasoning: 0.4,
  correctsPrevious: 0.02,
};

beforeAll(async () => {
  await runMigrations({ databaseUrl });
  db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const insert = (wf: string, minutesBefore: number, source: string, request: unknown) =>
    db.query(
      `INSERT INTO turn_route_log
         (workflow_id, conversation_id, mode, tier, proposed, source, questions_version,
          latency_ms, answers, request, created_at)
       VALUES ($1, $2, 'shadow', 'standard', $3, $4, 'v-test', 140, $5::jsonb, $6::jsonb, $7)`,
      [
        wf,
        `conv-${runId}`,
        source === 'jev' ? 'deep' : 'standard',
        source,
        source === 'jev' ? JSON.stringify(answers) : null,
        request === null ? null : JSON.stringify(request),
        new Date(future.getTime() - minutesBefore * 60_000).toISOString(),
      ],
    );
  await insert(`${runId}-a`, 10, 'pre-rule:pending-actions', null);
  await insert(`${runId}-b`, 5, 'jev', {
    state: { latest_messages: [{ from: 'wife', text: 'נלך לסבתא בשישי או בשבת?' }] },
    questions: {},
  });
});

afterAll(async () => {
  await db.query('DELETE FROM turn_route_log WHERE workflow_id LIKE $1', [`${runId}-%`]);
  await db.end();
});

describe('getRouterHealth (real Postgres)', () => {
  it('reads, parses, and orders the route rows newest first', async () => {
    const health = await getRouterHealth(db, future);

    expect(health.mode).toBe('shadow');
    expect(health.recent.slice(0, 2).map((r) => r.workflowId)).toEqual([`${runId}-b`, `${runId}-a`]);
    const [newest, older] = health.recent;
    expect(newest).toMatchObject({
      source: 'jev',
      proposed: 'deep',
      latencyMs: 140,
      latestText: 'נלך לסבתא בשישי או בשבת?',
    });
    expect(newest!.answers?.weighsOptions).toBe(0.93);
    expect(newest!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(older).toMatchObject({ answers: null, latestText: null });
  });

  it('returns every panel row, with a turn count from the DBOS journal', async () => {
    const health = await getRouterHealth(db, future);
    expect(health.rows.map((r) => r.name)).toEqual([
      'Last routed turn',
      'Fallback rate',
      'Jev latency p95',
      'Tier mix (24h)',
      'Corrections per tier (7d)',
    ]);
    // No handleTurn workflow started in the future 24h window.
    expect(health.rows[0]!.detail).toContain('of 0 turn(s) in 24h');
  });
});
