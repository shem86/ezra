// Conversation lane (T21, architecture decision 2): a partitioned
// concurrency-1 DBOS queue serializes per-conversation drain workflows; the
// drain pulls already-durable inbox rows, waits out the silence window, and
// hands debounced batches to the turn handler. Debounce is consumer-side by
// construction — the only waiting happens AFTER the row is committed.

import { DBOS } from '@dbos-inc/dbos-sdk';
import { groupIntoBatches } from './debounce.js';
import type { InboxItem, InboxKind } from '../memory/store.js';

/**
 * One queue for every conversation: partitioned, so the concurrency-1 limit
 * applies per partition key (= per conversation) — exactly one item runs to
 * completion at a time within a conversation, while conversations stay
 * independent of each other.
 */
export const conversationQueueName = 'conversation';

/** Must be called AFTER `DBOS.launch()` — 4.19.x throws before it. */
export async function registerConversationQueue(): Promise<void> {
  await DBOS.registerQueue(conversationQueueName, { concurrency: 1, partitionQueue: true });
}

/**
 * Drain workflow id, deterministic from the triggering message: every inbox
 * insert enqueues exactly one drain, and a replayed enqueue maps to the same
 * drain instead of spawning another.
 */
export function drainWorkflowId(messageId: string): string {
  if (messageId.length === 0) {
    throw new Error('drainWorkflowId: message id must be non-empty');
  }
  return `drain-${messageId}`;
}

export interface DrainDeps {
  /**
   * Every function dep must already be a registered DBOS step or datasource
   * transaction — the workflow body calls them directly and relies on their
   * journaling for replay determinism.
   */
  readonly readPending: (conversationId: string) => Promise<InboxItem[]>;
  readonly processBatch: (batch: InboxItem[]) => Promise<void>;
  readonly markProcessed: (seqs: number[]) => Promise<void>;
  /** Silence window (architecture: 1.5–3s band). Default 2000ms. */
  readonly silenceWindowMs?: number;
  /** Cap on quiet-waiting so a chatty burst cannot starve the lane. Default 15000ms. */
  readonly maxQuietWaitMs?: number;
}

/**
 * The single consumer for one conversation. One drain is enqueued per inbox
 * insert; the partition's concurrency-1 limit serializes them, so the first
 * to run absorbs the whole burst and the stragglers wake to an empty inbox
 * and exit — no cross-drain coordination, hence no coordination races.
 *
 * Returns the number of batches this drain processed (0 = no-op straggler).
 */
export function makeDrainWorkflow(deps: DrainDeps): (conversationId: string) => Promise<number> {
  const silenceWindowMs = deps.silenceWindowMs ?? 2000;
  const maxQuietWaitMs = deps.maxQuietWaitMs ?? 15_000;

  return async function drainConversation(conversationId: string): Promise<number> {
    let batchesProcessed = 0;
    for (;;) {
      let pending = await deps.readPending(conversationId);
      if (pending.length === 0) return batchesProcessed;

      // Silence window: keep waiting while bubbles are still arriving, so
      // the turn sees one thought, not five. Durable sleep + journaled reads
      // keep the loop deterministic on replay.
      let waitedMs = 0;
      for (;;) {
        await DBOS.sleep(silenceWindowMs);
        waitedMs += silenceWindowMs;
        const next = await deps.readPending(conversationId);
        const stillArriving = next.length > pending.length;
        pending = next;
        if (!stillArriving || waitedMs >= maxQuietWaitMs) break;
      }

      for (const batch of groupIntoBatches(pending)) {
        await deps.processBatch(batch);
        await deps.markProcessed(batch.map((item) => item.seq));
        batchesProcessed += 1;
      }
      // Loop: items that arrived while batches were processing are still
      // pending and belong to this drain (their own drains queue behind us).
    }
  };
}

/** What ingestion (or a proactive producer) hands the conversation lane. */
export interface ConversationEnqueue {
  readonly conversationId: string;
  readonly kind: InboxKind;
  readonly senderId: string;
  readonly messageId: string;
  readonly payload: unknown;
}

export interface ConversationEnqueueDeps {
  /** Registered datasource transaction wrapping `insertInboxItem`. */
  readonly insertItem: (item: ConversationEnqueue) => Promise<boolean>;
  /** The registered drain workflow this enqueue triggers. */
  readonly drainWorkflow: (conversationId: string) => Promise<number>;
}

/**
 * Workflow body for the durable enqueue (the T20 `enqueueDurably` contract):
 * commit the inbox row exactly-once, then enqueue this message's drain on
 * the conversation partition. A crash between the two replays into the same
 * drain id, and a duplicate insert (redelivery) lands on the message-id
 * constraint — both halves stay idempotent.
 */
export function makeConversationEnqueueWorkflow(
  deps: ConversationEnqueueDeps,
): (item: ConversationEnqueue) => Promise<void> {
  return async function enqueueConversationItem(item: ConversationEnqueue): Promise<void> {
    await deps.insertItem(item);
    await DBOS.startWorkflow(deps.drainWorkflow, {
      workflowID: drainWorkflowId(item.messageId),
      queueName: conversationQueueName,
      enqueueOptions: { queuePartitionKey: item.conversationId },
    })(item.conversationId);
  };
}
