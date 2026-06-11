// T29 gate: compaction end to end against real DBOS + Postgres + pgvector —
// trigger/truncation, durability ordering (full persist BEFORE compaction),
// the source_key idempotency under kill-mid-compaction, chained compaction,
// and graceful failure. The fixture import MUST stay first: it pins this
// file's DBOS__APPVERSION before the SDK loads.
import {
  compactingTurnWorkflow,
  compactionConnectionString,
  fixtureCompactionConfig,
  launchCompactionRuntime,
  scriptedSummarize,
} from './helpers/compaction-fixture.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import { loadContext, saveContext } from '../../src/memory/store.ts';
import { searchSemanticMemories } from '../../src/memory/semantic.ts';
import { parseTurnMessages, type TurnMessage } from '../../src/agent/context.ts';
import { compactionSenderId } from '../../src/agent/compaction.ts';
import type { BatchItem } from '../../src/agent/context.ts';
import { hashEmbed } from './helpers/fake-embedder.ts';

const childEntry = fileURLToPath(new URL('./helpers/compaction-child.ts', import.meta.url));
const runId = `run-${Date.now()}`;
let db: Client;

const { thresholdMessages } = fixtureCompactionConfig;

function humanBatch(text: string): BatchItem[] {
  return [{ senderId: 'wife', payload: { text } }];
}

/** user/assistant pairs, code-switched; user messages land at even indices. */
function seedMessages(n: number, mark: string): TurnMessage[] {
  const msgs: TurnMessage[] = [];
  for (let i = 0; msgs.length < n; i++) {
    msgs.push({
      role: 'user',
      senderId: i % 2 === 0 ? 'reut' : 'shem',
      content: `${mark} ${i}: צריך לקנות חלב and check the boiler`,
    });
    if (msgs.length < n) msgs.push({ role: 'assistant', content: `noted ${i}`, toolCalls: [] });
  }
  return msgs;
}

async function runTurn(conversationId: string, text: string) {
  const handle = await DBOS.startWorkflow(compactingTurnWorkflow, {
    workflowID: `compact-turn-${conversationId}-${Date.now()}`,
  })(conversationId, humanBatch(text));
  return handle.getResult();
}

async function transcript(conversationId: string): Promise<TurnMessage[]> {
  return parseTurnMessages(await loadContext(db, conversationId));
}

async function memoryRows(conversationId: string): Promise<Array<{ content: string; source_key: string }>> {
  const res = await db.query(
    'SELECT content, source_key FROM semantic_memories WHERE conversation_id = $1 ORDER BY created_at',
    [conversationId],
  );
  return res.rows as Array<{ content: string; source_key: string }>;
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
  await runMigrations({ databaseUrl: compactionConnectionString });
  db = new Client({ connectionString: compactionConnectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

// Sequential in declaration order; the kill test comes first because it must
// observe the child's pending workflow BEFORE this process launches DBOS.
describe('compaction (T29)', () => {
  it('kill between semantic write and truncation: replay yields one memory row and the compacted transcript', async () => {
    const conversationId = `conv-${runId}-compactkill`;
    const wfid = `compactkill-${runId}`;
    await saveContext(db, conversationId, seedMessages(thresholdMessages, 'kill'));

    const child = spawn(process.execPath, [childEntry, wfid, conversationId], {
      env: process.env,
      stdio: 'ignore',
    });
    const sourceKey = `compact-${wfid}`;
    await waitFor(async () => (await memoryRows(conversationId)).length >= 1, 30_000);
    child.kill('SIGKILL'); // lands inside the compacted-persist pre-write sleep
    await waitForExit(child);

    // The semantic write committed; the truncation did not — the transcript
    // is still the full post-turn document (durability ordering held).
    expect(await memoryRows(conversationId)).toMatchObject([{ source_key: sourceKey }]);
    expect(await transcript(conversationId)).toHaveLength(thresholdMessages + 2);

    await launchCompactionRuntime();
    // Resume explicitly AFTER launch (datasources ready) — the child ran
    // under its own executor ID so launch-time recovery leaves it alone.
    const resumed = await DBOS.resumeWorkflow(wfid);
    const result = await resumed.getResult();
    expect(result).toEqual({ status: 'completed', rounds: 1 });

    // Exactly one memory row — the replayed write was a no-op on source_key.
    const rows = await memoryRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_key).toBe(sourceKey);

    const messages = await transcript(conversationId);
    expect(messages[0]).toMatchObject({ role: 'user', senderId: compactionSenderId });
    expect(messages).toHaveLength(1 + (thresholdMessages + 2 - 8)); // summary + tail from cut at 8
    expect(messages[1]!.role).toBe('user');
  }, 90_000);

  it('over-threshold turn truncates to summary + tail and folds the summary into the semantic store', async () => {
    const conversationId = `conv-${runId}-happy`;
    await saveContext(db, conversationId, seedMessages(thresholdMessages, 'happy'));

    const result = await runTurn(conversationId, 'עוד הודעה one more');
    expect(result).toEqual({ status: 'completed', rounds: 1 });

    // 14 post-turn messages, cut at the user boundary 8: summary + 6 kept.
    const messages = await transcript(conversationId);
    expect(messages).toHaveLength(7);
    expect(messages[0]).toMatchObject({ role: 'user', senderId: compactionSenderId });
    expect(messages[0]!.content).toContain('OPEN: רעות תאשר עד חמישי re: plumber');
    expect(messages[1]!.role).toBe('user');
    expect(messages[messages.length - 1]).toMatchObject({ role: 'assistant', content: 'ok.' });

    // The memory row holds the raw summary (verbatim open commitment included)…
    const rows = await memoryRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('happy 0: צריך לקנות חלב');
    expect(rows[0]!.content).toContain('OPEN: רעות תאשר עד חמישי re: plumber');

    // …and is recallable through the same pgvector search the tool uses.
    const recalled = await searchSemanticMemories(db, {
      embedding: hashEmbed(rows[0]!.content),
      limit: 1,
    });
    expect(recalled[0]?.content).toBe(rows[0]!.content);
    expect(recalled[0]?.distance).toBeCloseTo(0, 5);
  }, 30_000);

  it('under threshold: transcript persists unchanged shape, no compaction artifacts', async () => {
    const conversationId = `conv-${runId}-small`;
    await saveContext(db, conversationId, seedMessages(4, 'small'));

    const result = await runTurn(conversationId, 'short one');
    expect(result).toEqual({ status: 'completed', rounds: 1 });

    const messages = await transcript(conversationId);
    expect(messages).toHaveLength(6);
    expect(messages.some((m) => m.role === 'user' && m.senderId === compactionSenderId)).toBe(false);
    expect(await memoryRows(conversationId)).toHaveLength(0);
  }, 30_000);

  it('chained compaction: a prior summary folds into the next one', async () => {
    const conversationId = `conv-${runId}-chained`;
    const priorSummary: TurnMessage = {
      role: 'user',
      senderId: compactionSenderId,
      content: 'Summary of the earlier conversation:\nsummary(8): kept from last time | OPEN: עדיין מחכים לאינסטלטור',
    };
    await saveContext(db, conversationId, [
      priorSummary,
      ...seedMessages(thresholdMessages - 1, 'chain'),
    ]);

    const result = await runTurn(conversationId, 'and another');
    expect(result).toEqual({ status: 'completed', rounds: 1 });

    // The head (cut at 8) starts with the prior summary; the scripted
    // summarizer echoes its first user line — the old summary text — into
    // the new one: nothing silently drops out of a chained compaction.
    const rows = await memoryRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('OPEN: עדיין מחכים לאינסטלטור');

    const messages = await transcript(conversationId);
    expect(messages[0]).toMatchObject({ role: 'user', senderId: compactionSenderId });
    expect(messages.filter((m) => m.role === 'user' && m.senderId === compactionSenderId)).toHaveLength(1);
  }, 30_000);

  it('summarize failure: the turn substance survives, the workflow errors loud, nothing half-written', async () => {
    const conversationId = `conv-${runId}-fail`;
    const seeded = seedMessages(thresholdMessages, 'fail');
    seeded[2] = { role: 'user', senderId: 'shem', content: 'script:fail-summary please' };
    await saveContext(db, conversationId, seeded);

    await expect(runTurn(conversationId, 'this turn still matters')).rejects.toThrowError(
      /summarize exploded/,
    );

    // Durability ordering: the FULL transcript (with this turn's reply)
    // persisted before compaction began; no memory row, no truncation.
    const messages = await transcript(conversationId);
    expect(messages).toHaveLength(thresholdMessages + 2);
    expect(messages[messages.length - 1]).toMatchObject({ role: 'assistant', content: 'ok.' });
    expect(messages.some((m) => m.role === 'user' && m.senderId === compactionSenderId)).toBe(false);
    expect(await memoryRows(conversationId)).toHaveLength(0);
  }, 30_000);

  it('the journaled summary step records the summary, never the whole head', async () => {
    // Cheap guard in the spirit of T22's "never journal the transcript
    // whole": summarizeContext's journaled output is the summary string.
    const rows = await db.query(
      `SELECT output FROM dbos.operation_outputs
       WHERE workflow_uuid IN (SELECT workflow_uuid FROM dbos.workflow_status WHERE name = 'handleTurnCompacting')
         AND function_name = 'summarizeContext'`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows as Array<{ output: string | null }>) {
      expect(row.output ?? '').not.toContain('happy 3:'); // head lines stay out
    }
  }, 30_000);

  it('sanity: the scripted summarizer is a pure function of the head', async () => {
    const head = seedMessages(8, 'pure');
    expect(await scriptedSummarize(head)).toBe(await scriptedSummarize(head));
  });
});
