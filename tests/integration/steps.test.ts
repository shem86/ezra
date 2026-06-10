// T19 gate: exactly-once structured-state writes through transactional
// steps, proven against real Postgres with a real kill (testing.md pattern).
// The fixture import MUST stay first: it pins this file's DBOS__APPVERSION
// before the SDK loads (see helpers/pin-appversion.ts).
// killableWriteWorkflow isn't named here, but importing the fixture
// registers it — recovery in this process needs that registration.
import {
  guardedSendWorkflow,
  launchStepsRuntime,
  singleWriteWorkflow,
  stepsConnectionString,
} from './helpers/steps-fixture.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';

const childEntry = fileURLToPath(new URL('./helpers/steps-child.ts', import.meta.url));
// Unique per run so stale rows/workflows from aborted runs can't collide.
const runId = `run-${Date.now()}`;
let db: Client;

async function itemCount(list: string, item: string): Promise<number> {
  const res = await db.query('SELECT count(*)::int AS n FROM lists WHERE list = $1 AND item = $2', [
    list,
    item,
  ]);
  return (res.rows[0] as { n: number }).n;
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: stepsConnectionString });
  db = new Client({ connectionString: stepsConnectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

// Tests run sequentially in declaration order; the kill test comes first
// because it must observe the child's pending workflow BEFORE this process
// launches DBOS (launch is what triggers recovery).
describe('transactional step helpers (T19)', () => {
  it('kill around the step: the state write is neither lost nor doubled', async () => {
    const wfid = `kill-${runId}`;
    const list = `steps-kill-${runId}`;
    const child = spawn(process.execPath, [childEntry, wfid, list], {
      env: process.env,
      stdio: 'ignore',
    });

    await waitFor(async () => (await itemCount(list, 'before-kill')) >= 1, 30_000);
    child.kill('SIGKILL');
    await waitForExit(child);
    expect(await itemCount(list, 'before-kill')).toBe(1); // not lost
    expect(await itemCount(list, 'after-kill')).toBe(0); // killed mid-sleep

    await launchStepsRuntime(); // recovery claims the pending workflow
    const result = await DBOS.retrieveWorkflow(wfid).getResult();

    expect(result).toBe(`completed-${list}`); // identical to an uninterrupted run
    expect(await itemCount(list, 'before-kill')).toBe(1); // replayed, not doubled
    expect(await itemCount(list, 'after-kill')).toBe(1); // completed exactly once
  }, 90_000);

  it('re-running the same workflowID never re-applies the write', async () => {
    const wfid = `once-${runId}`;
    const list = `steps-once-${runId}`;

    const first = await (
      await DBOS.startWorkflow(singleWriteWorkflow, { workflowID: wfid })(list)
    ).getResult();
    const second = await (
      await DBOS.startWorkflow(singleWriteWorkflow, { workflowID: wfid })(list)
    ).getResult();

    expect(first).toBe(`done-${list}`);
    expect(second).toBe(first);
    expect(await itemCount(list, 'once')).toBe(1);
  }, 30_000);

  it('derived idempotency key dedupes an external effect across re-runs', async () => {
    const wfid = `send-${runId}`;
    const conversationId = `conv-${runId}`;

    const first = await (
      await DBOS.startWorkflow(guardedSendWorkflow, { workflowID: wfid })(conversationId)
    ).getResult();
    const second = await (
      await DBOS.startWorkflow(guardedSendWorkflow, { workflowID: wfid })(conversationId)
    ).getResult();

    expect(first).toBe(true);
    expect(second).toBe(true); // journaled result replayed, effect not re-fired

    const logged = await db.query(
      'SELECT count(*)::int AS n FROM sent_log WHERE idempotency_key = $1',
      [`${wfid}:1`],
    );
    expect((logged.rows[0] as { n: number }).n).toBe(1);
  }, 30_000);
});
