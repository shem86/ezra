// T24, the M3 reliability gate suite. `pnpm test:recovery` runs the named
// gates together:
//   - recovery replay (kill mid-flight, diff vs uninterrupted, no double
//     effect)            → tests/integration/handle-turn.test.ts + steps.test.ts
//   - exactly-once state write                → tests/integration/steps.test.ts
//   - debounce grouping + FIFO ordering       → tests/integration/queue.test.ts
//     (incl. proactive FIFO)                  → tests/integration/scheduled.test.ts
//   - execute-once pending-action guard under duplicate approvals → THIS FILE
//     (the pending_actions table + guard land in M3 even though full HITL
//     binding/revalidation/TTL is M5).
// The fixture import MUST stay first: it pins this file's DBOS__APPVERSION
// before the SDK loads (see T19's note in TASKS.md).
import {
  approvalWorkflow,
  launchRecoveryRuntime,
  recoveryConnectionString,
} from './helpers/recovery-fixture.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import { createPendingAction } from '../../src/memory/store.ts';
import {
  claimForExecution,
  markApproved,
  markDenied,
  markStale,
} from '../../src/hitl/pending-actions.ts';

const runId = `run-${Date.now()}`;
let db: Client;

async function park(actionId: string): Promise<void> {
  await createPendingAction(db, {
    actionId,
    conversationId: `conv-${runId}`,
    toolCall: { name: 'create_calendar_event', args: { title: 'תור לרופא' } },
    expiresAt: new Date(Date.now() + 12 * 3_600_000),
  });
}

async function actionStatus(actionId: string): Promise<string> {
  const res = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
  return (res.rows[0] as { status: string }).status;
}

async function executionCount(list: string): Promise<number> {
  const res = await db.query(
    "SELECT count(*)::int AS n FROM lists WHERE list = $1 AND item = 'executed'",
    [list],
  );
  return (res.rows[0] as { n: number }).n;
}

async function approve(actionId: string, list: string, eventId: string): Promise<boolean> {
  const handle = await DBOS.startWorkflow(approvalWorkflow, {
    workflowID: `approval-${eventId}`,
  })(actionId, list);
  return handle.getResult();
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: recoveryConnectionString });
  db = new Client({ connectionString: recoveryConnectionString });
  await db.connect();
  await launchRecoveryRuntime();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

describe('pending-action execute-once guard (T24)', () => {
  it('duplicate sequential approvals execute the action exactly once', async () => {
    const actionId = `act-${runId}-seq`;
    const list = `hitl-${runId}-seq`;
    await park(actionId);

    const first = await approve(actionId, list, `${runId}-seq-1`);
    const second = await approve(actionId, list, `${runId}-seq-2`); // duplicate event, new workflow

    expect(first).toBe(true);
    expect(second).toBe(false); // lost the claim, wrote nothing
    expect(await executionCount(list)).toBe(1);
    expect(await actionStatus(actionId)).toBe('executed');
  }, 30_000);

  it('concurrent duplicate approvals: exactly one wins the claim', async () => {
    const actionId = `act-${runId}-race`;
    const list = `hitl-${runId}-race`;
    await park(actionId);

    const results = await Promise.all([
      approve(actionId, list, `${runId}-race-1`),
      approve(actionId, list, `${runId}-race-2`),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1); // single winner
    expect(await executionCount(list)).toBe(1);
    expect(await actionStatus(actionId)).toBe('executed');
  }, 30_000);

  it('a denied action can never be executed', async () => {
    const actionId = `act-${runId}-denied`;
    const list = `hitl-${runId}-denied`;
    await park(actionId);

    expect(await markDenied(db, actionId)).toBe(true);
    const result = await approve(actionId, list, `${runId}-denied-1`);

    expect(result).toBe(false);
    expect(await executionCount(list)).toBe(0);
    expect(await actionStatus(actionId)).toBe('denied'); // approval could not overwrite
  }, 30_000);

  it('transition guards refuse out-of-order and unknown transitions', async () => {
    const actionId = `act-${runId}-guards`;
    await park(actionId);

    expect(await markApproved(db, `act-${runId}-missing`)).toBe(false);
    expect(await markApproved(db, actionId)).toBe(true);
    expect(await markApproved(db, actionId)).toBe(false); // already approved
    expect(await markDenied(db, actionId)).toBe(false); // deny only from pending

    const claimed = await claimForExecution(db, actionId);
    expect(claimed?.actionId).toBe(actionId);
    expect(claimed?.toolCall).toEqual({ name: 'create_calendar_event', args: { title: 'תור לרופא' } });
    expect(await claimForExecution(db, actionId)).toBeNull(); // claim is once
  }, 30_000);

  it('stale is terminal and reachable only from approved (T35 revalidation failure)', async () => {
    const actionId = `act-${runId}-stale`;
    await park(actionId);

    expect(await markStale(db, actionId)).toBe(false); // never from pending — that is expiry's job (T37)
    expect(await markApproved(db, actionId)).toBe(true);
    expect(await markStale(db, actionId)).toBe(true);
    expect(await markStale(db, actionId)).toBe(false); // already stale
    expect(await claimForExecution(db, actionId)).toBeNull(); // a stale action can never execute
    expect(await actionStatus(actionId)).toBe('stale');
  }, 30_000);
});
