// Semantic store accessors (T28). Deliberately two primitives, not one
// embed-and-write helper: embedding is external I/O and must happen in its
// own step BEFORE the transactional insert — combining them would hold a
// Postgres transaction open across a network call. The composer (T29
// compaction) sequences embedDocuments → writeSemanticMemory.

import type { Queryable } from './store.js';

export interface SemanticMemoryInput {
  readonly conversationId: string;
  readonly content: string;
  readonly embedding: readonly number[];
  /** Idempotency handle — derive from journaled values (workflowID/step). */
  readonly sourceKey: string;
}

export interface RecalledMemory {
  readonly id: string;
  readonly conversationId: string;
  readonly content: string;
  readonly createdAt: Date;
  /** Cosine distance — 0 identical, 2 opposite; smaller is closer. */
  readonly distance: number;
}

// pgvector has no node-pg type adapter; its text literal is '[1,0.5,…]',
// which JSON.stringify of a number[] produces exactly.
function toVectorLiteral(embedding: readonly number[]): string {
  return JSON.stringify(embedding);
}

/**
 * Idempotent insert: a replayed write with the same sourceKey is a no-op,
 * never a duplicate row (architecture: compaction "carries the same
 * idempotency discipline as a tool"). Returns false on the replay path.
 */
export async function writeSemanticMemory(
  db: Queryable,
  input: SemanticMemoryInput,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO semantic_memories (conversation_id, content, embedding, source_key)
     VALUES ($1, $2, $3::vector, $4)
     ON CONFLICT (source_key) DO NOTHING
     RETURNING id`,
    [input.conversationId, input.content, toVectorLiteral(input.embedding), input.sourceKey],
  );
  return res.rows.length === 1;
}

export async function searchSemanticMemories(
  db: Queryable,
  opts: { readonly embedding: readonly number[]; readonly limit: number },
): Promise<RecalledMemory[]> {
  const res = await db.query(
    `SELECT id, conversation_id, content, created_at,
            embedding <=> $1::vector AS distance
     FROM semantic_memories
     ORDER BY embedding <=> $1::vector, id
     LIMIT $2`,
    [toVectorLiteral(opts.embedding), opts.limit],
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    conversationId: row.conversation_id as string,
    content: row.content as string,
    createdAt: row.created_at as Date,
    distance: Number(row.distance),
  }));
}
