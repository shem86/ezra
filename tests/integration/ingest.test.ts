// T20 gate: durable-enqueue-before-ack against real DBOS + Postgres,
// including both halves of the crash window. The fixture import MUST stay
// first: it pins this file's DBOS__APPVERSION before the SDK loads (every
// DBOS-launching test file needs its own — see T19's note in TASKS.md).
import {
  launchIngestRuntime,
  makeDurableEnqueue,
  ingestConnectionString,
} from './helpers/ingest-fixture.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import {
  createIngestion,
  ingestWorkflowId,
  type IngestOutcome,
} from '../../src/orchestration/ingest.ts';
import { createStubTransport } from '../../src/transport/stub.ts';
import type { InboundMessage, MessageAck } from '../../src/transport/types.ts';

const runId = `run-${Date.now()}`;
let db: Client;

function makeMessage(id: string): InboundMessage {
  return {
    id,
    conversationId: `group-${runId}@g.us`,
    senderId: 'wife@s.whatsapp.net',
    senderName: 'Wife',
    fromMe: false,
    text: 'add milk · תוסיף חלב',
    quotedMessageId: null,
    timestamp: 1_765_000_000,
  };
}

async function processedCount(list: string, messageId: string): Promise<number> {
  const res = await db.query('SELECT count(*)::int AS n FROM lists WHERE list = $1 AND item = $2', [
    list,
    messageId,
  ]);
  return (res.rows[0] as { n: number }).n;
}

async function waitFor(probe: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: ingestConnectionString });
  db = new Client({ connectionString: ingestConnectionString });
  await db.connect();
  await launchIngestRuntime();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

describe('ingestion seam (T20)', () => {
  it('happy path: enqueues durably, acks, and the message is processed exactly once', async () => {
    const list = `ingest-happy-${runId}`;
    const messageId = `msg-${runId}-happy`;
    const transport = createStubTransport();
    const ingest = createIngestion({
      enqueueDurably: makeDurableEnqueue(list),
      wasSentByBot: () => false,
    });
    const outcomes: IngestOutcome[] = [];
    transport.onMessage((message, ack) => {
      void ingest(message, ack).then((o) => outcomes.push(o));
    });
    await transport.connect();

    transport.deliver(makeMessage(messageId));

    await waitFor(() => outcomes.length === 1, 10_000);
    expect(outcomes[0]?.outcome).toBe('enqueued');
    expect(transport.unackedIds()).toEqual([]); // acked only after the durable enqueue

    const result = await DBOS.retrieveWorkflow(ingestWorkflowId(messageId)).getResult();
    expect(result).toBe(messageId);
    expect(await processedCount(list, messageId)).toBe(1);
  }, 30_000);

  it('crash BEFORE enqueue: message stays un-acked and redelivery recovers it', async () => {
    const list = `ingest-pre-${runId}`;
    const messageId = `msg-${runId}-pre`;
    const transport = createStubTransport();
    const enqueue = makeDurableEnqueue(list);
    let failuresRemaining = 1;
    const ingest = createIngestion({
      // First attempt dies before anything is persisted — the crash window
      // the ack point exists to cover.
      enqueueDurably: async (message) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('simulated crash before durable enqueue');
        }
        await enqueue(message);
      },
      wasSentByBot: () => false,
    });
    const outcomes: IngestOutcome[] = [];
    transport.onMessage((message, ack) => {
      void ingest(message, ack).then((o) => outcomes.push(o));
    });
    await transport.connect();

    transport.deliver(makeMessage(messageId));
    await waitFor(() => outcomes.length === 1, 10_000);
    expect(outcomes[0]?.outcome).toBe('enqueue-failed');
    expect(transport.unackedIds()).toEqual([messageId]); // NOT acked — not lost
    expect(await processedCount(list, messageId)).toBe(0);

    await transport.forceReconnect(); // the server's redelivery of un-acked messages

    await waitFor(() => outcomes.length === 2, 10_000);
    expect(outcomes[1]?.outcome).toBe('enqueued');
    await DBOS.retrieveWorkflow(ingestWorkflowId(messageId)).getResult();
    expect(await processedCount(list, messageId)).toBe(1);
    expect(transport.unackedIds()).toEqual([]);
  }, 30_000);

  it('crash AFTER enqueue, before ack: redelivery dedupes on the message-id workflow', async () => {
    const list = `ingest-post-${runId}`;
    const messageId = `msg-${runId}-post`;
    const transport = createStubTransport();
    const ingest = createIngestion({
      enqueueDurably: makeDurableEnqueue(list),
      wasSentByBot: () => false,
    });
    const outcomes: IngestOutcome[] = [];
    let dropNextAck = true;
    transport.onMessage((message, ack) => {
      // Model the crash landing between the durable enqueue and the ack:
      // the enqueue happened, but the ack never reached the server.
      const maybeDroppedAck: MessageAck = async () => {
        if (dropNextAck) {
          dropNextAck = false;
          return;
        }
        await ack();
      };
      void ingest(message, maybeDroppedAck).then((o) => outcomes.push(o));
    });
    await transport.connect();

    transport.deliver(makeMessage(messageId));
    await waitFor(() => outcomes.length === 1, 10_000);
    expect(outcomes[0]?.outcome).toBe('enqueued');
    expect(transport.unackedIds()).toEqual([messageId]); // server never saw the ack

    await transport.forceReconnect(); // duplicate delivery of an already-enqueued message

    await waitFor(() => outcomes.length === 2, 10_000);
    expect(outcomes[1]?.outcome).toBe('enqueued');
    expect(transport.unackedIds()).toEqual([]);
    await DBOS.retrieveWorkflow(ingestWorkflowId(messageId)).getResult();
    expect(await processedCount(list, messageId)).toBe(1); // deduped, not double-processed
  }, 30_000);
});
