// Compaction capture accessors (docs/compaction-eval-spec.md). Two primitives
// mirroring memory/semantic.ts: an idempotent write the compaction block calls
// once per turn, and a recent-rows read the eval's prod spot-check mode uses.
// The write deliberately carries the HEAD (the summarized input) — discarded
// everywhere else in the system — so a summary can be scored against it.

import type { Queryable } from './store.js';
import type { TurnMessage } from '../agent/context.js';

export interface CompactionLogInput {
  readonly workflowId: string;
  readonly conversationId: string;
  /** Idempotency handle — `compact-<workflowID>`, shared with the semantic row. */
  readonly sourceKey: string;
  /** The messages being summarized: msgs[0..cut). */
  readonly head: readonly TurnMessage[];
  readonly summary: string;
  /** Split index — head is msgs[0..cutIndex), tail is msgs[cutIndex..]. */
  readonly cutIndex: number;
  readonly tailCount: number;
  /** Model id that produced the summary (config.cheapModelId in production). */
  readonly summarizerModel: string;
}

export interface CompactionRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly conversationId: string;
  readonly sourceKey: string;
  readonly head: TurnMessage[];
  readonly summary: string;
  readonly cutIndex: number;
  readonly headCount: number;
  readonly tailCount: number;
  readonly summarizerModel: string;
  readonly headChars: number;
  readonly summaryChars: number;
  readonly createdAt: Date;
}

/** Total content chars across the head — the conciseness baseline a summary is
 *  measured against. Every TurnMessage variant carries `content`. */
function headChars(head: readonly TurnMessage[]): number {
  return head.reduce((n, m) => n + m.content.length, 0);
}

/**
 * Idempotent insert: a replayed write with the same sourceKey is a no-op,
 * never a duplicate row (same discipline as writeSemanticMemory — compaction
 * "carries the same idempotency discipline as a tool"). Returns false on the
 * replay path.
 */
export async function writeCompactionLog(
  db: Queryable,
  input: CompactionLogInput,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO compaction_log
       (workflow_id, conversation_id, source_key, head, summary,
        cut_index, head_count, tail_count, summarizer_model, head_chars, summary_chars)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (source_key) DO NOTHING
     RETURNING id`,
    [
      input.workflowId,
      input.conversationId,
      input.sourceKey,
      JSON.stringify(input.head),
      input.summary,
      input.cutIndex,
      input.head.length,
      input.tailCount,
      input.summarizerModel,
      headChars(input.head),
      input.summary.length,
    ],
  );
  return res.rows.length === 1;
}

/** Most-recent compactions, newest first — the eval's prod spot-check source. */
export async function readRecentCompactions(
  db: Queryable,
  opts: { readonly limit: number; readonly conversationId?: string },
): Promise<CompactionRecord[]> {
  const where = opts.conversationId === undefined ? '' : 'WHERE conversation_id = $2';
  const params: unknown[] =
    opts.conversationId === undefined ? [opts.limit] : [opts.limit, opts.conversationId];
  const res = await db.query(
    `SELECT id, workflow_id, conversation_id, source_key, head, summary,
            cut_index, head_count, tail_count, summarizer_model,
            head_chars, summary_chars, created_at
     FROM compaction_log
     ${where}
     ORDER BY created_at DESC, id
     LIMIT $1`,
    params,
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    workflowId: row.workflow_id as string,
    conversationId: row.conversation_id as string,
    sourceKey: row.source_key as string,
    // jsonb comes back from node-pg already parsed.
    head: row.head as TurnMessage[],
    summary: row.summary as string,
    cutIndex: row.cut_index as number,
    headCount: row.head_count as number,
    tailCount: row.tail_count as number,
    summarizerModel: row.summarizer_model as string,
    headChars: row.head_chars as number,
    summaryChars: row.summary_chars as number,
    createdAt: row.created_at as Date,
  }));
}
