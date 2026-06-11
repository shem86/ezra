// T28 gate: the semantic store and the pull-only recall tool against real
// pgvector — write idempotency (the compaction-replay guarantee), cosine
// ordering, Hebrew/English round-trips, and recall_history through the same
// makeRunTool path the workflow uses. Embeddings are a deterministic fake;
// the real Voyage wire is spikes/voyage-embed.ts (manual).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/memory/migrate.ts';
import { searchSemanticMemories, writeSemanticMemory } from '../../src/memory/semantic.ts';
import { makeRunTool } from '../../src/tools/registry.ts';
import { makeHouseholdToolRegistry } from '../../src/tools/index.ts';
import type { ToolCall } from '../../src/agent/context.ts';
import { makeFakeEmbedder, vec } from './helpers/fake-embedder.ts';

const connectionString = process.env.DATABASE_URL ?? '';
const runId = `run-${Date.now()}`;
const conv = `semantic-${runId}`;
let db: Client;

// Hand-crafted geometry: the afterschool memories sit near the afterschool
// query, the plumber memory near the plumber query, and nothing near "rugby".
const afterschoolSummary = `סיכמנו שהצהרון מסתיים ב-16:30 בימי שלישי (${runId})`;
const afterschoolFollowup = `Reut asked to switch הצהרון pickup to 17:00 next week (${runId})`;
const plumberSummary = `the plumber quoted 1200 for the boiler fix (${runId})`;
const fixtures = new Map<string, number[]>([
  [afterschoolSummary, vec(1, 0, 0)],
  [afterschoolFollowup, vec(0.9, 0.1, 0)],
  [plumberSummary, vec(0, 1, 0)],
  [`מה קורה עם הצהרון`, vec(1, 0.05, 0)],
  ['boiler plumber', vec(0.05, 1, 0)],
  ['rugby fixtures', vec(0, 0, 1)],
]);
const embedder = makeFakeEmbedder(fixtures);

const runTool = makeRunTool(makeHouseholdToolRegistry(), {
  toolDeps: { embedder },
  park: async () => {
    throw new Error('no household tool is confirm-before; park must be unreachable');
  },
});

let nextId = 0;
function call(name: string, args: unknown): ToolCall {
  nextId += 1;
  return { id: `tu-${runId}-${nextId}`, name, args };
}

async function seedMemories(): Promise<void> {
  for (const [i, content] of [afterschoolSummary, afterschoolFollowup, plumberSummary].entries()) {
    const [embedding] = await embedder.embedDocuments([content]);
    await writeSemanticMemory(db, {
      conversationId: conv,
      content,
      embedding: embedding!,
      sourceKey: `${conv}-seed-${i}`,
    });
  }
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: connectionString });
  db = new Client({ connectionString });
  await db.connect();
  // Stale rows from earlier runs of THIS suite carry the same crafted
  // vectors at identical distance and win ties arbitrarily — clear only our
  // namespace (other suites run in parallel against the same dev DB).
  await db.query("DELETE FROM semantic_memories WHERE conversation_id LIKE 'semantic-run-%'");
  await seedMemories();
}, 30_000);

afterAll(async () => {
  await db.end();
});

describe('semantic store accessors', () => {
  it('write is idempotent on source_key: a replay is a no-op, not a duplicate', async () => {
    const input = {
      conversationId: conv,
      content: `compaction summary (${runId})`,
      embedding: vec(0.5, 0.5, 0),
      sourceKey: `${conv}-replayed-step`,
    };

    expect(await writeSemanticMemory(db, input)).toBe(true);
    expect(await writeSemanticMemory(db, input)).toBe(false);

    const rows = await db.query('SELECT id FROM semantic_memories WHERE source_key = $1', [
      input.sourceKey,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it('search returns nearest-first by cosine distance', async () => {
    const query = await embedder.embedQuery(`מה קורה עם הצהרון`);

    const memories = await searchSemanticMemories(db, { embedding: query, limit: 3 });

    expect(memories[0]?.content).toBe(afterschoolSummary);
    expect(memories[1]?.content).toBe(afterschoolFollowup);
    expect(memories[0]!.distance).toBeLessThan(memories[1]!.distance);
  });

  it('round-trips code-switched Hebrew/English content intact', async () => {
    const memories = await searchSemanticMemories(db, {
      embedding: await embedder.embedQuery(`מה קורה עם הצהרון`),
      limit: 1,
    });

    expect(memories[0]?.content).toBe(afterschoolSummary);
  });
});

describe('recall_history tool', () => {
  it('answers a code-switched query with nearest memories, dated, nearest first', async () => {
    const result = await runTool(
      db,
      call('recall_history', { query: `מה קורה עם הצהרון`, limit: 2 }),
      conv,
    );

    expect(result.parked).toBe(false);
    const lines = result.content.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(afterschoolSummary);
    expect(lines[1]).toContain(afterschoolFollowup);
    // Dated in household-local days — the model needs "when" to judge staleness.
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}\]/);
  });

  it('scopes by relevance: a different query surfaces different memories first', async () => {
    const result = await runTool(db, call('recall_history', { query: 'boiler plumber', limit: 1 }), conv);

    expect(result.content).toContain(plumberSummary);
    expect(result.content).not.toContain(afterschoolSummary);
  });

  it('defaults the limit when the model omits it', async () => {
    const result = await runTool(db, call('recall_history', { query: 'rugby fixtures' }), conv);

    // Lossy by design: far-away memories still return (top-k, no threshold);
    // the model judges relevance from content + date.
    expect(result.content.split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('says so when the store is empty for the query path', async () => {
    await db.query('BEGIN');
    await db.query('DELETE FROM semantic_memories');
    const result = await runTool(db, call('recall_history', { query: 'rugby fixtures' }), conv);
    await db.query('ROLLBACK');

    expect(result.content).toBe('no stored memories match that query');
  });

  it('folds an invalid limit into an invalid-args tool_result, not a throw', async () => {
    const result = await runTool(db, call('recall_history', { query: 'x', limit: 99 }), conv);

    expect(result.content).toContain('invalid arguments');
  });
});
