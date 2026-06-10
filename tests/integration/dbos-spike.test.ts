import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  launchSpikeRuntime,
  queueOrderWorkflow,
  setupSpikeTables,
  spikeConnectionString,
  spikeQueueName,
  txnWorkflow,
} from '../../spikes/dbos/spike.ts';

const childEntry = fileURLToPath(new URL('../../spikes/dbos/child.ts', import.meta.url));
const runId = `run${Date.now()}`;
let db: Client;

async function effectCount(key: string): Promise<number> {
  const res = await db.query('SELECT count(*)::int AS n FROM spike_effects WHERE key = $1', [key]);
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
  db = new Client({ connectionString: spikeConnectionString });
  await db.connect();
  await setupSpikeTables();
}, 30_000);

afterAll(async () => {
  // Grace period: runtime queue registration in 4.19.x can race shutdown's
  // pool teardown ("Cannot use a pool after calling end").
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

// Tests run sequentially in declaration order; the kill test comes first
// because it must observe the child's pending workflow BEFORE this process
// launches DBOS (launch is what triggers recovery).
describe('DBOS semantics spike (T8)', () => {
  it('kill mid-flight: recovery replays to identical output with no double effect', async () => {
    const wfid = `kill-${runId}`;
    const child = spawn(process.execPath, [childEntry, wfid], {
      env: process.env,
      stdio: 'ignore',
    });

    await waitFor(async () => (await effectCount(`${wfid}-A`)) >= 1, 30_000);
    child.kill('SIGKILL');
    await waitForExit(child);
    expect(await effectCount(`${wfid}-A`)).toBe(1);
    expect(await effectCount(`${wfid}-B`)).toBe(0); // killed mid-sleep

    await launchSpikeRuntime(); // recovery picks up the pending workflow
    const result = await DBOS.retrieveWorkflow(wfid).getResult();

    expect(result).toBe(`completed-${wfid}`); // identical to uninterrupted output
    expect(await effectCount(`${wfid}-A`)).toBe(1); // replayed, not re-executed
    expect(await effectCount(`${wfid}-B`)).toBe(1); // completed exactly once
  }, 90_000);

  it('transactional step: same workflowID never re-applies the state write', async () => {
    const wfid = `txn-${runId}`;
    const first = await (await DBOS.startWorkflow(txnWorkflow, { workflowID: wfid })(wfid)).getResult();
    const second = await (await DBOS.startWorkflow(txnWorkflow, { workflowID: wfid })(wfid)).getResult();

    expect(first).toBe(`done-${wfid}`);
    expect(second).toBe(first);
    expect(await effectCount(wfid)).toBe(1);
  }, 30_000);

  it('queue with concurrency 1 executes FIFO in enqueue order', async () => {
    const handles = [];
    for (let i = 0; i < 5; i++) {
      handles.push(
        await DBOS.startWorkflow(queueOrderWorkflow, {
          workflowID: `q-${runId}-${i}`,
          queueName: spikeQueueName,
        })(i, runId),
      );
    }
    await Promise.all(handles.map((h) => h.getResult()));

    const res = await db.query(
      'SELECT key FROM spike_effects WHERE key LIKE $1 ORDER BY seq',
      [`${runId}-order-%`],
    );
    expect(res.rows.map((r: { key: string }) => r.key)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `${runId}-order-${i}`),
    );
  }, 60_000);

  it('scheduled workflow fires', async () => {
    const before = await effectCount('scheduled-tick');
    await waitFor(async () => (await effectCount('scheduled-tick')) > before, 15_000);
  }, 20_000);

  it('journal, app state, and pgvector co-reside in one Postgres', async () => {
    const journal = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'dbos' LIMIT 1",
    );
    expect(journal.rows).toHaveLength(1);

    const state = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'spike_effects' LIMIT 1",
    );
    expect(state.rows).toHaveLength(1);

    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    const vector = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(vector.rows).toHaveLength(1);
  });
});
