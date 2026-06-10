// T21 gate: conversation queue + consumer-side debounce against real DBOS +
// Postgres. The fixture import MUST stay first: it pins this file's
// DBOS__APPVERSION before the SDK loads (every DBOS-launching test file
// needs its own — see T19's note in TASKS.md).
import {
  batchLog,
  enqueueWorkflow,
  launchQueueRuntime,
  queueConnectionString,
} from './helpers/queue-fixture.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import { getPendingInbox, type InboxItem } from '../../src/memory/store.ts';
import type { ConversationEnqueue } from '../../src/orchestration/queue.ts';

const runId = `run-${Date.now()}`;
let db: Client;

function bubble(conversationId: string, messageId: string, senderId: string, text: string): ConversationEnqueue {
  return {
    conversationId,
    kind: 'human',
    senderId,
    messageId,
    payload: { text },
  };
}

async function enqueue(item: ConversationEnqueue): Promise<void> {
  const handle = await DBOS.startWorkflow(enqueueWorkflow, {
    workflowID: `enq-${item.messageId}`,
  })(item);
  await handle.getResult();
}

function batchesFor(conversationId: string): InboxItem[][] {
  return batchLog.filter((batch) => batch[0]?.conversationId === conversationId);
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
  await runMigrations({ databaseUrl: queueConnectionString });
  db = new Client({ connectionString: queueConnectionString });
  await db.connect();
  await launchQueueRuntime();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

describe('conversation queue + consumer-side debounce (T21)', () => {
  it('groups a rapid burst of same-sender bubbles into one batch', async () => {
    const conversationId = `conv-${runId}-burst`;
    await Promise.all([
      enqueue(bubble(conversationId, `m-${runId}-b1`, 'wife', 'תוסיף חלב')),
      enqueue(bubble(conversationId, `m-${runId}-b2`, 'wife', 'and eggs')),
      enqueue(bubble(conversationId, `m-${runId}-b3`, 'wife', 'actually no eggs')),
    ]);

    await waitFor(() => batchesFor(conversationId).length > 0, 20_000);
    // The whole burst must land as ONE turn — and once the inbox is drained,
    // the leftover no-op drains must not have invented extra batches.
    await waitFor(async () => (await getPendingInbox(db, conversationId)).length === 0, 20_000);
    const batches = batchesFor(conversationId);
    expect(batches).toHaveLength(1);
    // Concurrent enqueues land in nondeterministic seq order — the contract
    // is "all three in ONE batch, ordered by enqueue (seq)", not by call
    // order (decision 2 ordering note).
    expect(batches[0]!.map((i) => i.messageId).sort()).toEqual(
      [`m-${runId}-b1`, `m-${runId}-b2`, `m-${runId}-b3`].sort(),
    );
    const seqs = batches[0]!.map((i) => i.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  }, 30_000);

  it('never holds a message pre-enqueue: the row is durable the moment the enqueue resolves', async () => {
    const conversationId = `conv-${runId}-hold`;
    const messageId = `m-${runId}-hold`;
    await enqueue(bubble(conversationId, messageId, 'shem', 'add olive oil'));

    // Timing-free durability check: the enqueue workflow resolving means the
    // insert committed — the message now survives any crash, whether or not
    // the drain's silence window has elapsed. (Racing "drain hasn't run yet"
    // here was flaky under parallel-suite load; durability-at-resolve is the
    // real no-pre-enqueue-holding invariant.)
    const committed = await db.query(
      'SELECT processed_at FROM conversation_inbox WHERE message_id = $1',
      [messageId],
    );
    expect(committed.rows).toHaveLength(1);

    // The consumer then picks it up from the durable inbox. processBatch and
    // markProcessed are separate journaled steps, so the batch is observable
    // a beat before the row flips to processed — wait for both.
    await waitFor(() => batchesFor(conversationId).length === 1, 20_000);
    expect(batchesFor(conversationId)[0]!.map((i) => i.messageId)).toEqual([messageId]);
    await waitFor(async () => (await getPendingInbox(db, conversationId)).length === 0, 20_000);
  }, 30_000);

  it('keeps FIFO across human and proactive items; a proactive item is its own batch', async () => {
    const conversationId = `conv-${runId}-fifo`;
    // Sequential awaits force the seq order: human, proactive, human.
    await enqueue(bubble(conversationId, `m-${runId}-f1`, 'wife', 'remind me about trash'));
    await enqueue({
      conversationId,
      kind: 'proactive',
      senderId: 'system',
      messageId: `m-${runId}-fp`,
      payload: { reminder: 'trash night' },
    });
    await enqueue(bubble(conversationId, `m-${runId}-f2`, 'wife', 'also buy bags'));

    await waitFor(async () => (await getPendingInbox(db, conversationId)).length === 0, 20_000);
    const batches = batchesFor(conversationId);
    expect(batches.map((batch) => batch.map((i) => i.messageId))).toEqual([
      [`m-${runId}-f1`],
      [`m-${runId}-fp`],
      [`m-${runId}-f2`],
    ]);
    expect(batches[1]![0]!.kind).toBe('proactive');
  }, 30_000);
});
