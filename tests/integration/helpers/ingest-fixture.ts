// Fixture for the T20 ingestion gate: a real DBOS-backed durable enqueue.
// Module-level singletons are banned in src/ but fine in test fixtures
// (same exemption as spikes).
import './pin-appversion-ingest.ts'; // must precede the SDK import
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { registerTransactionalStep } from '../../../src/orchestration/steps.ts';
import { ingestWorkflowId, type ParsedInboundMessage } from '../../../src/orchestration/ingest.ts';
import { addListItem } from '../../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the ingest integration fixture');
}
export const ingestConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('ingest-db', { connectionString });

const recordProcessed = registerTransactionalStep(dataSource, 'recordProcessedMessage', addListItem);

// Stand-in for the M3 turn pipeline: durably record that this message was
// processed. One row per processed message makes exactly-once assertable.
async function processInboundWorkflowFn(
  message: ParsedInboundMessage,
  list: string,
): Promise<string> {
  await recordProcessed({ list, item: message.id, addedBy: message.senderId });
  return message.id;
}
export const processInboundWorkflow = DBOS.registerWorkflow(processInboundWorkflowFn);

/**
 * The durable enqueue under test: `startWorkflow` persists the workflow
 * before resolving — that is the durability point the ack waits on. The
 * workflowID comes from the message id, so a redelivered duplicate maps to
 * the same workflow and dedupes instead of double-processing (T21 will
 * route this into the conversation queue).
 */
export function makeDurableEnqueue(list: string): (message: ParsedInboundMessage) => Promise<void> {
  return async (message) => {
    await DBOS.startWorkflow(processInboundWorkflow, {
      workflowID: ingestWorkflowId(message.id),
    })(message, list);
  };
}

export async function launchIngestRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-ingest-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
