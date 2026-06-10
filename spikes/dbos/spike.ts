import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { Client } from 'pg';

// M1 spike (T8): prove the DBOS semantics the whole design leans on, against
// the single dev Postgres. Spike code — module-level env read and singletons
// are acceptable here and banned in src/.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the DBOS spike');
}
export const spikeConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('spike-db', { connectionString });

export async function setupSpikeTables(): Promise<void> {
  // Installs the datasource's checkpoint table (dbos.transaction_completion)
  // — the mechanism that makes a transactional step's state write atomic
  // with its step record.
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS spike_effects (
         seq bigserial PRIMARY KEY,
         key text NOT NULL
       )`,
    );
  } finally {
    await client.end();
  }
}

// Transactional step: app-state write + step checkpoint commit in ONE
// Postgres transaction (architecture decision 3).
const insertEffect = dataSource.registerTransaction(
  async (key: string): Promise<void> => {
    await dataSource.client.query('INSERT INTO spike_effects (key) VALUES ($1)', [key]);
  },
  { name: 'insertEffect' },
);

async function txnWorkflowFn(key: string): Promise<string> {
  await insertEffect(key);
  return `done-${key}`;
}
export const txnWorkflow = DBOS.registerWorkflow(txnWorkflowFn);

// Kill target: effect A, a durable sleep wide enough to SIGKILL into, effect B.
async function killableWorkflowFn(key: string): Promise<string> {
  await insertEffect(`${key}-A`);
  await DBOS.sleep(3000);
  await insertEffect(`${key}-B`);
  return `completed-${key}`;
}
export const killableWorkflow = DBOS.registerWorkflow(killableWorkflowFn);

async function queueOrderFn(idx: number, runId: string): Promise<number> {
  await insertEffect(`${runId}-order-${idx}`);
  return idx;
}
export const queueOrderWorkflow = DBOS.registerWorkflow(queueOrderFn);

export const spikeQueueName = 'spike-queue';

async function scheduledFn(_schedTime: Date, _startTime: Date): Promise<void> {
  await insertEffect('scheduled-tick');
}
const scheduledWorkflow = DBOS.registerWorkflow(scheduledFn);
DBOS.registerScheduled(scheduledWorkflow, { crontab: '* * * * * *' });

export async function launchSpikeRuntime(): Promise<void> {
  // NOTE: recovery only claims pending workflows of the same application
  // version; the test pins DBOS__APPVERSION (vitest config) for both sides
  // of the kill/recover scenario. DBOS reads it at SDK import time.
  // System DB (journal) deliberately points at the SAME database as app
  // state + pgvector: co-location is what makes transactional steps atomic.
  DBOS.setConfig({ name: 'hh-spike', systemDatabaseUrl: connectionString });
  await DBOS.launch();
  // In DBOS 4.19.x queues are registered at runtime, after launch.
  DBOS.registerQueue(spikeQueueName, { concurrency: 1 });
}
