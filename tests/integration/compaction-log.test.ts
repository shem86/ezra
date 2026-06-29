// Task 1 gate (docs/compaction-eval-spec.md): the compaction capture substrate
// against real Postgres — write idempotency (the crash-replay-no-duplicate
// guarantee that lets compaction log exactly once per turn) and a faithful
// round-trip of the head transcript, including code-switched Hebrew/English,
// through jsonb. The exactly-once-under-replay path through the real workflow
// is Task 2; this proves the accessor primitive it relies on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/memory/migrate.ts';
import {
  readRecentCompactions,
  writeCompactionLog,
  type CompactionLogInput,
} from '../../src/memory/compaction-log.ts';
import type { TurnMessage } from '../../src/agent/context.ts';

const connectionString = process.env.DATABASE_URL ?? '';
const runId = `run-${Date.now()}`;
const conv = `compactlog-${runId}`;
let db: Client;

// A code-switched head with every TurnMessage variant — the thing being
// summarized. The Hebrew must survive jsonb byte-for-byte.
const head: TurnMessage[] = [
  { role: 'user', senderId: 'reut', content: 'מי אוסף את הילדים מהצהרון מחר?' },
  { role: 'assistant', content: 'Let me check the calendar.', toolCalls: [] },
  { role: 'tool', toolUseId: 'tu-1', content: 'no events found for tomorrow afternoon' },
  { role: 'user', senderId: 'shem', content: "I'll do pickup, אתה מאשר?" },
];
const summary = 'Shem committed to picking up the kids from הצהרון tomorrow; Reut to confirm.';

function input(overrides: Partial<CompactionLogInput> = {}): CompactionLogInput {
  return {
    workflowId: `wf-${runId}`,
    conversationId: conv,
    sourceKey: `compact-wf-${runId}`,
    head,
    summary,
    cutIndex: 4,
    tailCount: 20,
    summarizerModel: 'claude-haiku-4-5-20251001',
    ...overrides,
  };
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: connectionString });
  db = new Client({ connectionString });
  await db.connect();
  // Other suites share this dev DB in parallel — clear only our namespace.
  await db.query("DELETE FROM compaction_log WHERE conversation_id LIKE 'compactlog-run-%'");
}, 30_000);

afterAll(async () => {
  await db.end();
});

describe('compaction_log accessors', () => {
  it('write is idempotent on source_key: a replay is a no-op, not a duplicate', async () => {
    const row = input({ sourceKey: `compact-wf-${runId}-replay` });

    expect(await writeCompactionLog(db, row)).toBe(true);
    expect(await writeCompactionLog(db, row)).toBe(false);

    const rows = await db.query('SELECT id FROM compaction_log WHERE source_key = $1', [
      row.sourceKey,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it('persists the head, summary, cut geometry, and summarizer model; derives char counts', async () => {
    const sourceKey = `compact-wf-${runId}-full`;
    await writeCompactionLog(db, input({ sourceKey }));

    const [rec] = await readRecentCompactions(db, { limit: 1, conversationId: conv });

    expect(rec?.sourceKey).toBe(sourceKey);
    expect(rec?.summary).toBe(summary);
    expect(rec?.cutIndex).toBe(4);
    expect(rec?.headCount).toBe(head.length);
    expect(rec?.tailCount).toBe(20);
    expect(rec?.summarizerModel).toBe('claude-haiku-4-5-20251001');
    // Char counts are derived from the input, not supplied by the caller.
    expect(rec?.summaryChars).toBe(summary.length);
    expect(rec?.headChars).toBe(head.reduce((n, m) => n + m.content.length, 0));
  });

  it('round-trips the code-switched head through jsonb byte-for-byte', async () => {
    const sourceKey = `compact-wf-${runId}-roundtrip`;
    await writeCompactionLog(db, input({ sourceKey }));

    const rows = await readRecentCompactions(db, { limit: 5, conversationId: conv });
    const rec = rows.find((r) => r.sourceKey === sourceKey);

    expect(rec?.head).toEqual(head);
    // The Hebrew survived intact — not mojibake, not escaped.
    expect(rec?.head[0]?.content).toContain('הצהרון');
  });

  it('readRecentCompactions returns newest first and respects the limit', async () => {
    const conv2 = `compactlog-${runId}-ordered`;
    for (let i = 0; i < 3; i++) {
      await writeCompactionLog(
        db,
        input({ conversationId: conv2, sourceKey: `compact-wf-${runId}-ord-${i}`, summary: `s${i}` }),
      );
    }

    const rows = await readRecentCompactions(db, { limit: 2, conversationId: conv2 });

    expect(rows).toHaveLength(2);
    // created_at DESC: the last-written summary comes first.
    expect(rows[0]?.summary).toBe('s2');
  });
});
