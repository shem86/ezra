// T22 gate: the handleTurn skeleton's loop invariants + recovery replay,
// against real DBOS + Postgres with a scripted model. The fixture import
// MUST stay first: it pins this file's DBOS__APPVERSION before the SDK
// loads (see T19's note in TASKS.md).
import {
  cappedTurnWorkflow,
  classifyLog,
  handleTurnWorkflow,
  launchTurnRuntime,
  toolListFor,
  turnConnectionString,
} from './helpers/turn-fixture.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import { createPendingAction, loadContext, setPromptMessageId } from '../../src/memory/store.ts';
import { parseTurnMessages, type TurnMessage } from '../../src/agent/context.ts';
import type { BatchItem } from '../../src/agent/context.ts';

const childEntry = fileURLToPath(new URL('./helpers/turn-child.ts', import.meta.url));
// Unique per run so stale rows/workflows from aborted runs can't collide.
const runId = `run-${Date.now()}`;
let db: Client;

function humanBatch(text: string, senderId = 'wife'): BatchItem[] {
  return [{ senderId, payload: { text } }];
}

async function runTurn(conversationId: string, batch: BatchItem[]) {
  const handle = await DBOS.startWorkflow(handleTurnWorkflow, {
    workflowID: `turn-${conversationId}-${Date.now()}`,
  })(conversationId, batch);
  return handle.getResult();
}

async function transcript(conversationId: string): Promise<TurnMessage[]> {
  return parseTurnMessages(await loadContext(db, conversationId));
}

async function itemCount(list: string, item: string): Promise<number> {
  const res = await db.query('SELECT count(*)::int AS n FROM lists WHERE list = $1 AND item = $2', [
    list,
    item,
  ]);
  return (res.rows[0] as { n: number }).n;
}

/** Every tool_use id in the transcript has exactly one tool_result answer. */
function assertEveryToolUseAnswered(messages: TurnMessage[]): void {
  const useIds = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (m.role === 'assistant' ? m.toolCalls.map((c) => c.id) : []));
  const resultIds = messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.toolUseId : ''));
  expect(resultIds.sort()).toEqual([...useIds].sort());
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
  await runMigrations({ databaseUrl: turnConnectionString });
  db = new Client({ connectionString: turnConnectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

// Tests run sequentially in declaration order; the kill test comes first
// because it must observe the child's pending workflow BEFORE this process
// launches DBOS (launch is what triggers recovery).
describe('handleTurn skeleton (T22)', () => {
  it('recovery replay: kill mid-tool, replay completes the turn with no double effect', async () => {
    const conversationId = `conv-${runId}-kill`;
    const wfid = `turnkill-${runId}`;
    const list = toolListFor(conversationId);
    const child = spawn(process.execPath, [childEntry, wfid, conversationId], {
      env: process.env,
      stdio: 'ignore',
    });

    await waitFor(async () => (await itemCount(list, 'before-kill')) >= 1, 30_000);
    child.kill('SIGKILL'); // lands inside slow_add's pre-commit sleep
    await waitForExit(child);
    expect(await itemCount(list, 'before-kill')).toBe(1); // not lost
    expect(await itemCount(list, 'after-kill')).toBe(0); // killed mid-transaction

    await launchTurnRuntime();
    // Resume explicitly AFTER launch (datasources ready): the child ran
    // under its own executor ID precisely so launch-time recovery — which
    // races datasource init on 4.19.8 (see dbos.md) — leaves it alone.
    const resumed = await DBOS.resumeWorkflow(wfid);
    const result = await resumed.getResult();

    // Identical to an uninterrupted run: same status, same transcript shape,
    // each tool effect exactly once.
    expect(result).toEqual({ status: 'completed', rounds: 3 });
    expect(await itemCount(list, 'before-kill')).toBe(1);
    expect(await itemCount(list, 'after-kill')).toBe(1);

    const messages = await transcript(conversationId);
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(messages[5]).toEqual({ role: 'assistant', content: 'drill done.', toolCalls: [] });
    assertEveryToolUseAnswered(messages);
  }, 90_000);

  it('happy path: tool round then final message, transcript persisted in loop order', async () => {
    const conversationId = `conv-${runId}-happy`;
    const result = await runTurn(conversationId, humanBatch('script:add-then-done'));

    expect(result).toEqual({ status: 'completed', rounds: 2 });
    expect(await itemCount(toolListFor(conversationId), 'milk')).toBe(1);

    const messages = await transcript(conversationId);
    expect(messages).toEqual([
      { role: 'user', senderId: 'wife', content: 'script:add-then-done' },
      {
        role: 'assistant',
        content: 'adding milk',
        toolCalls: [{ id: 'tu-add-1', name: 'add_item', args: { item: 'milk' } }],
      },
      { role: 'tool', toolUseId: 'tu-add-1', content: 'added milk' },
      { role: 'assistant', content: 'added milk.', toolCalls: [] },
    ]);
    assertEveryToolUseAnswered(messages);
  }, 30_000);

  it('persists context across turns: a second turn loads the first transcript', async () => {
    const conversationId = `conv-${runId}-happy`; // same conversation as above
    const before = await transcript(conversationId);

    const result = await runTurn(conversationId, humanBatch('next thing', 'shem'));

    expect(result.status).toBe('completed');
    const after = await transcript(conversationId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length]).toEqual({ role: 'user', senderId: 'shem', content: 'next thing' });
    expect(after[after.length - 1]?.role).toBe('assistant');
  }, 30_000);

  it('deny path: synthetic declined result answers the tool_use and the loop continues', async () => {
    const conversationId = `conv-${runId}-deny`;
    const result = await runTurn(conversationId, humanBatch('script:deny'));

    expect(result).toEqual({ status: 'completed', rounds: 2 });
    const messages = await transcript(conversationId);
    expect(messages[2]).toEqual({ role: 'tool', toolUseId: 'tu-deny-1', content: 'user declined' });
    expect(messages[3]).toEqual({
      role: 'assistant',
      content: 'understood, not doing that.',
      toolCalls: [],
    });
    assertEveryToolUseAnswered(messages);
  }, 30_000);

  it('park path: synthetic pending result, pending_actions row, approval prompt closes the turn', async () => {
    const conversationId = `conv-${runId}-park`;
    const result = await runTurn(conversationId, humanBatch('script:park'));

    expect(result).toEqual({ status: 'parked', rounds: 1 });
    const actionId = `act-tu-park-1-${conversationId}`;
    const messages = await transcript(conversationId);
    expect(messages[messages.length - 2]).toEqual({
      role: 'tool',
      toolUseId: 'tu-park-1',
      content: `pending approval, action_id=${actionId}`,
    });
    // The closing message is the approval prompt (T34) — deterministic, so
    // replay regenerates identical bytes; its send receipt is what gets
    // stamped as prompt_message_id.
    const closing = messages[messages.length - 1];
    expect(closing?.role).toBe('assistant');
    expect(closing && 'content' in closing ? closing.content : '').toContain(actionId);
    expect(closing && 'content' in closing ? closing.content : '').toMatch(/reply to this message/i);
    assertEveryToolUseAnswered(messages);

    const parked = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
    expect(parked.rows).toEqual([{ status: 'pending' }]);
  }, 30_000);

  it('mixed round: autonomous effect commits, every tool_use answered, turn parks after the round folds', async () => {
    const conversationId = `conv-${runId}-mixed`;
    const result = await runTurn(conversationId, humanBatch('script:mixed-park'));

    expect(result).toEqual({ status: 'parked', rounds: 1 });
    expect(await itemCount(toolListFor(conversationId), 'mixed-milk')).toBe(1);

    const actionId = `act-tu-mixed-2-${conversationId}`;
    const messages = await transcript(conversationId);
    assertEveryToolUseAnswered(messages);
    const closing = messages[messages.length - 1];
    expect(closing?.role).toBe('assistant');
    expect(closing && 'content' in closing ? closing.content : '').toContain(actionId);

    const parked = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
    expect(parked.rows).toEqual([{ status: 'pending' }]);
  }, 30_000);

  it('digest slot live (T34): a pending action reaches the model call, rendered post-prefix', async () => {
    const conversationId = `conv-${runId}-digest`;
    await createPendingAction(db, {
      actionId: `act-digest-${runId}`,
      conversationId,
      toolCall: { id: 'tu_x', name: 'fake_confirm_before', args: { title: 'dentist' } },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });

    const result = await runTurn(conversationId, humanBatch('script:digest-echo'));

    expect(result.status).toBe('completed');
    const messages = await transcript(conversationId);
    const reply = messages.at(-1);
    expect(reply?.role).toBe('assistant');
    expect(reply && 'content' in reply ? reply.content : '').toContain(`act-digest-${runId}`);
  }, 30_000);

  it('digest slot stays empty with no pending actions — the model call carries none', async () => {
    const conversationId = `conv-${runId}-nodigest`;
    const result = await runTurn(conversationId, humanBatch('script:digest-echo'));

    expect(result.status).toBe('completed');
    const messages = await transcript(conversationId);
    const reply = messages.at(-1);
    expect(reply && 'content' in reply ? reply.content : '').toBe('(no digest)');
  }, 30_000);

  it('quoted approval (T35): the parked action executes in a fresh turn, outcome as NEW context message', async () => {
    const conversationId = `conv-${runId}-approve`;
    await runTurn(conversationId, humanBatch('script:park'));
    const actionId = `act-tu-park-1-${conversationId}`;
    // Stamping is the composer's post-send job (T34) — done directly here.
    await setPromptMessageId(db, actionId, `wa-prompt-${runId}-approve`);

    const result = await runTurn(conversationId, [
      { senderId: 'wife', payload: { text: 'yes', quotedMessageId: `wa-prompt-${runId}-approve` } },
    ]);

    expect(result.status).toBe('completed');
    const status = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
    expect(status.rows).toEqual([{ status: 'executed' }]);
    expect(await itemCount(toolListFor(conversationId), 'approved-item')).toBe(1);

    const messages = await transcript(conversationId);
    // The original tu-park-1 keeps its single synthetic answer — the real
    // outcome must never become a second tool_result (decision 10).
    assertEveryToolUseAnswered(messages);
    const updates = messages.filter((m) => m.role === 'user' && m.senderId === 'system:hitl');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.content).toContain(actionId);
    expect(updates[0]?.content).toContain('approved by wife');
    const replyIdx = messages.findIndex((m) => m.role === 'user' && m.content === 'yes');
    expect(messages.indexOf(updates[0]!)).toBeGreaterThan(replyIdx);
  }, 30_000);

  it('quoted deny (T35): action flips to denied, nothing executes, the model is told', async () => {
    const conversationId = `conv-${runId}-qdeny`;
    await runTurn(conversationId, humanBatch('script:park'));
    const actionId = `act-tu-park-1-${conversationId}`;
    await setPromptMessageId(db, actionId, `wa-prompt-${runId}-qdeny`);

    const result = await runTurn(conversationId, [
      { senderId: 'wife', payload: { text: 'לא', quotedMessageId: `wa-prompt-${runId}-qdeny` } },
    ]);

    expect(result.status).toBe('completed');
    const status = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
    expect(status.rows).toEqual([{ status: 'denied' }]);
    expect(await itemCount(toolListFor(conversationId), 'approved-item')).toBe(0);

    const messages = await transcript(conversationId);
    const updates = messages.filter((m) => m.role === 'user' && m.senderId === 'system:hitl');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.content).toContain('declined by wife');
  }, 30_000);

  it('unclear quoted reply (T35): degrades to a normal turn, action untouched', async () => {
    const conversationId = `conv-${runId}-qunclear`;
    await runTurn(conversationId, humanBatch('script:park'));
    const actionId = `act-tu-park-1-${conversationId}`;
    await setPromptMessageId(db, actionId, `wa-prompt-${runId}-qunclear`);

    const result = await runTurn(conversationId, [
      { senderId: 'wife', payload: { text: 'make it 4pm', quotedMessageId: `wa-prompt-${runId}-qunclear` } },
    ]);

    expect(result.status).toBe('completed');
    const status = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
    expect(status.rows).toEqual([{ status: 'pending' }]);
    const messages = await transcript(conversationId);
    expect(messages.filter((m) => m.role === 'user' && m.senderId === 'system:hitl')).toHaveLength(0);
  }, 30_000);

  it('MAX_ROUNDS cap: forced no-tools final message instead of a silent stall', async () => {
    const conversationId = `conv-${runId}-cap`;
    const handle = await DBOS.startWorkflow(cappedTurnWorkflow, {
      workflowID: `turncap-${runId}`,
    })(conversationId, humanBatch('script:loop-forever'));
    const result = await handle.getResult();

    expect(result).toEqual({ status: 'cap-hit', rounds: 3 });
    const messages = await transcript(conversationId);
    // user + 3 × (assistant + tool result) + forced final
    expect(messages).toHaveLength(8);
    expect(messages[7]).toEqual({
      role: 'assistant',
      content: 'forced final: I got stuck, want me to keep going?',
      toolCalls: [],
    });
    assertEveryToolUseAnswered(messages);
    for (const round of [0, 1, 2]) {
      expect(await itemCount(toolListFor(conversationId), `round-${round}`)).toBe(1);
    }
  }, 30_000);

  it('never journals the transcript whole: no step output holds the full conversation', async () => {
    // The invariant: per-round steps (callModel, runTool, persistContext)
    // record only deltas, so no journal row may contain the user text and
    // the final text together. loadTurnContext is excluded — the load step
    // legitimately journals the turn's STARTING transcript (the pseudocode
    // runs it as a step), which on a later turn contains both markers.
    const rows = await db.query(
      `SELECT output FROM dbos.operation_outputs
       WHERE workflow_uuid IN (SELECT workflow_uuid FROM dbos.workflow_status WHERE name = 'handleTurn')
         AND function_name <> 'loadTurnContext'`,
    );
    expect(rows.rows.length).toBeGreaterThan(0); // the steps ARE journaled
    for (const row of rows.rows as Array<{ output: string | null }>) {
      const output = row.output ?? '';
      const holdsWholeTranscript =
        output.includes('script:add-then-done') && output.includes('added milk.');
      expect(holdsWholeTranscript).toBe(false);
    }
  }, 30_000);
});

describe('relatedness routing (T36)', () => {
  async function parkDirect(
    key: string,
    item = 'milk',
  ): Promise<{ conversationId: string; actionId: string }> {
    const conversationId = `conv-${runId}-${key}`;
    const actionId = `act-${runId}-${key}`;
    await createPendingAction(db, {
      actionId,
      conversationId,
      toolCall: { id: `tu-${key}`, name: 'park_me', args: { item } },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });
    return { conversationId, actionId };
  }

  async function actionRow(actionId: string) {
    const res = await db.query('SELECT * FROM pending_actions WHERE action_id = $1', [actionId]);
    return res.rows[0] as { status: string; prompt_message_id: string | null; tool_call: unknown };
  }

  function hitlMessages(messages: TurnMessage[]): TurnMessage[] {
    return messages.filter((m) => m.role === 'user' && m.senderId === 'system:hitl');
  }

  it('non-quoted approve with exactly one pending: settles through the full T35 path', async () => {
    const { conversationId, actionId } = await parkDirect('t36-approve');

    const result = await runTurn(conversationId, humanBatch('classify:approve — yes do it'));

    expect(result.status).toBe('completed');
    expect((await actionRow(actionId)).status).toBe('executed');
    expect(await itemCount(toolListFor(conversationId), 'approved-milk')).toBe(1);
    const messages = await transcript(conversationId);
    const updates = hitlMessages(messages);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.content).toContain(actionId);
    expect(updates[0]?.content).toContain('approved by wife');
    assertEveryToolUseAnswered(messages);
  });

  it('non-quoted deny: flips to denied, nothing executes, the model is told', async () => {
    const { conversationId, actionId } = await parkDirect('t36-deny');

    const result = await runTurn(conversationId, humanBatch('classify:deny — no, cancel'));

    expect(result.status).toBe('completed');
    expect((await actionRow(actionId)).status).toBe('denied');
    expect(await itemCount(toolListFor(conversationId), 'approved-milk')).toBe(0);
    const updates = hitlMessages(await transcript(conversationId));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.content).toContain('declined by wife');
  });

  it('refine: args swap while pending, prompt stamp cleared, turn closes with the re-prompt and no model call', async () => {
    const { conversationId, actionId } = await parkDirect('t36-refine');
    await setPromptMessageId(db, actionId, `wa-prompt-${runId}-t36-refine`);

    const result = await runTurn(conversationId, humanBatch('classify:refine make it later'));

    expect(result).toEqual({ status: 'parked', rounds: 0 });
    const row = await actionRow(actionId);
    expect(row.status).toBe('pending');
    expect(row.prompt_message_id).toBeNull();
    expect(row.tool_call).toMatchObject({ name: 'park_me', args: { item: 'refined-item' } });
    const messages = await transcript(conversationId);
    const closing = messages.at(-1);
    expect(closing?.role).toBe('assistant');
    expect(closing && 'content' in closing ? closing.content : '').toContain('Approval needed');
    expect(closing && 'content' in closing ? closing.content : '').toContain(actionId);
    expect(closing && 'content' in closing ? closing.content : '').toContain('refined-item');
  });

  it('refine with schema-invalid args: action untouched, normal turn — never auto-deny', async () => {
    const { conversationId, actionId } = await parkDirect('t36-badrefine');
    await setPromptMessageId(db, actionId, `wa-prompt-${runId}-t36-badrefine`);

    const result = await runTurn(conversationId, humanBatch('classify:badrefine make it 42'));

    expect(result.status).toBe('completed');
    const row = await actionRow(actionId);
    expect(row.status).toBe('pending');
    expect(row.prompt_message_id).toBe(`wa-prompt-${runId}-t36-badrefine`);
    expect(row.tool_call).toMatchObject({ args: { item: 'milk' } });
    expect(hitlMessages(await transcript(conversationId))).toHaveLength(0);
  });

  it('unrelated message: action untouched, normal turn', async () => {
    const { conversationId, actionId } = await parkDirect('t36-unrelated');

    const result = await runTurn(conversationId, humanBatch('מה קורה עם ארוחת ערב?'));

    expect(result.status).toBe('completed');
    expect((await actionRow(actionId)).status).toBe('pending');
    expect(hitlMessages(await transcript(conversationId))).toHaveLength(0);
  });

  it('no pending actions: the classifier is never invoked — no cost', async () => {
    const conversationId = `conv-${runId}-t36-nopending`;
    const before = classifyLog.length;

    const result = await runTurn(conversationId, humanBatch('classify:approve — yes'));

    expect(result.status).toBe('completed');
    expect(classifyLog.length).toBe(before);
  });

  it('two pending and no quote: never guess — classifier skipped, both stay pending', async () => {
    const { conversationId, actionId } = await parkDirect('t36-multi');
    const secondId = `act-${runId}-t36-multi-b`;
    await createPendingAction(db, {
      actionId: secondId,
      conversationId,
      toolCall: { id: 'tu-t36-multi-b', name: 'park_me', args: { item: 'bread' } },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });
    const before = classifyLog.length;

    const result = await runTurn(conversationId, humanBatch('classify:approve — yes'));

    expect(result.status).toBe('completed');
    expect(classifyLog.length).toBe(before);
    expect((await actionRow(actionId)).status).toBe('pending');
    expect((await actionRow(secondId)).status).toBe('pending');
  });

  it('a bound quoted approve takes precedence — the classifier is never consulted', async () => {
    const { conversationId, actionId } = await parkDirect('t36-quoted');
    const promptMessageId = `wa-prompt-${runId}-t36-quoted`;
    await setPromptMessageId(db, actionId, promptMessageId);
    const before = classifyLog.length;

    const result = await runTurn(conversationId, [
      { senderId: 'wife', payload: { text: 'yes', quotedMessageId: promptMessageId } },
    ]);

    expect(result.status).toBe('completed');
    expect(classifyLog.length).toBe(before);
    expect((await actionRow(actionId)).status).toBe('executed');
  });

  it('a quoted-but-unclear reply classifies against its BOUND action, even with several pending', async () => {
    const { conversationId, actionId } = await parkDirect('t36-quoted-refine');
    const secondId = `act-${runId}-t36-quoted-refine-b`;
    await createPendingAction(db, {
      actionId: secondId,
      conversationId,
      toolCall: { id: 'tu-t36-qr-b', name: 'park_me', args: { item: 'bread' } },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });
    const promptMessageId = `wa-prompt-${runId}-t36-quoted-refine`;
    await setPromptMessageId(db, actionId, promptMessageId);

    const result = await runTurn(conversationId, [
      { senderId: 'wife', payload: { text: 'classify:refine תזיז את זה', quotedMessageId: promptMessageId } },
    ]);

    expect(result).toEqual({ status: 'parked', rounds: 0 });
    const refined = await actionRow(actionId);
    expect(refined.status).toBe('pending');
    expect(refined.prompt_message_id).toBeNull();
    expect(refined.tool_call).toMatchObject({ args: { item: 'refined-item' } });
    expect((await actionRow(secondId)).status).toBe('pending');
    expect((await actionRow(secondId)).tool_call).toMatchObject({ args: { item: 'bread' } });
  });
});
