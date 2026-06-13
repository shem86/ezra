// T42 launch-recovery pass (ledger #1). Production scopes each process
// generation to its own executor id (DBOS__VMID, set by src/start.ts) so
// DBOS.launch() never auto-recovers into the 4.19.x datasource-init race —
// which means crash-stranded workflows from dead generations must be found
// and resumed EXPLICITLY post-launch. That pass is what this file proves:
// it finds the stranded, completes them exactly-once, and leaves both the
// current generation's in-flight work and other app versions alone.
// The fixture import MUST stay first: it pins this file's DBOS__APPVERSION
// before the SDK loads.
// Importing the fixture also registers strandedWriteWorkflow in THIS
// process — required: the resumed workflow replays here, under this name.
import { launchLaunchRecoveryRuntime, slowNoopWorkflow } from './helpers/launch-recovery-fixture.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import { resumeStrandedWorkflows } from '../../src/orchestration/recovery.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL required');

const runId = `launch-${Date.now()}`;
let db: Client;

/** Spawn the child, wait for its first journaled write, SIGKILL mid-sleep. */
async function strandChildWorkflow(workflowId: string, list: string): Promise<void> {
  const child = spawn(
    'node',
    ['tests/integration/helpers/launch-recovery-child.ts', workflowId, list],
    { env: { ...process.env }, stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i += 1) {
    const res = await db.query('SELECT 1 FROM lists WHERE list = $1 AND item = $2', [
      list,
      'before-kill',
    ]);
    if (res.rowCount === 1) break;
    await delay(100);
  }
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function itemCount(list: string, item: string): Promise<number> {
  const res = await db.query(
    'SELECT count(*)::int AS n FROM lists WHERE list = $1 AND item = $2',
    [list, item],
  );
  return (res.rows[0] as { n: number }).n;
}

async function systemStatus(workflowId: string): Promise<string> {
  const res = await db.query('SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1', [
    workflowId,
  ]);
  return (res.rows[0] as { status: string }).status;
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: connectionString });
  db = new Client({ connectionString });
  await db.connect();
  await launchLaunchRecoveryRuntime();
}, 30_000);

afterAll(async () => {
  await db.end();
  // Grace period before shutdown (dbos.md teardown race).
  await delay(1500);
  await DBOS.shutdown();
});

describe('resumeStrandedWorkflows (T42, ledger #1)', () => {
  it(
    'finds a PENDING workflow stranded by a dead generation, resumes it, completes exactly once',
    { timeout: 40_000 },
    async () => {
      const workflowId = `stranded-${runId}`;
      const list = `list-${runId}-stranded`;
      await strandChildWorkflow(workflowId, list);
      expect(await systemStatus(workflowId)).toBe('PENDING'); // genuinely stranded

      const resumed = await resumeStrandedWorkflows();

      expect(resumed).toContain(workflowId);
      const result = await DBOS.retrieveWorkflow(workflowId).getResult();
      expect(result).toBe(`completed-${list}`);
      // The replay skipped the journaled first write — exactly-once held.
      expect(await itemCount(list, 'before-kill')).toBe(1);
      expect(await itemCount(list, 'after-kill')).toBe(1);
    },
  );

  it(
    "leaves the CURRENT generation's in-flight workflows alone",
    { timeout: 20_000 },
    async () => {
      const workflowId = `slow-${runId}`;
      const handle = await DBOS.startWorkflow(slowNoopWorkflow, { workflowID: workflowId })(
        runId,
      );

      const resumed = await resumeStrandedWorkflows();

      expect(resumed).not.toContain(workflowId);
      expect(await handle.getResult()).toBe(`slow-${runId}`); // unharmed
    },
  );

  it(
    'skips a stranded workflow from a different application version (it could never run here)',
    { timeout: 40_000 },
    async () => {
      const workflowId = `foreign-${runId}`;
      const list = `list-${runId}-foreign`;
      await strandChildWorkflow(workflowId, list);
      await db.query(
        'UPDATE dbos.workflow_status SET application_version = $2 WHERE workflow_uuid = $1',
        [workflowId, 'hh-some-other-version'],
      );

      const resumed = await resumeStrandedWorkflows();

      expect(resumed).not.toContain(workflowId);
      expect(await systemStatus(workflowId)).toBe('PENDING'); // untouched, not re-enqueued
      // Park the foreign row terminally so later suite runs don't re-scan it.
      await db.query('UPDATE dbos.workflow_status SET status = $2 WHERE workflow_uuid = $1', [
        workflowId,
        'CANCELLED',
      ]);
    },
  );
});
