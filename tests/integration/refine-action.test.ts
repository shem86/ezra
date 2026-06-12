// T36: refine updates the pending row's serialized tool_call while status
// stays 'pending' (pre-execution, so no idempotency hazard) and clears
// prompt_message_id — the T34 unstamped-row marker — so the composer re-sends
// and re-stamps the updated proposal. Tested against real Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { z } from 'zod';
import { runMigrations } from '../../src/memory/migrate.ts';
import { createPendingAction, getPendingAction, setPromptMessageId } from '../../src/memory/store.ts';
import { markDenied } from '../../src/hitl/pending-actions.ts';
import { defineTool } from '../../src/tools/define-tool.ts';
import { makeToolRegistry } from '../../src/tools/registry.ts';
import { makeRefineAction } from '../../src/hitl/refine-action.ts';
import { makeResolveClassifiedDecision } from '../../src/hitl/resolve-approval.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL required');

const runId = `run-${Date.now()}`;
let db: Client;

const proposeEvent = defineTool<Record<string, never>, z.ZodType<{ title: string; time: string }>>({
  name: 'propose_event',
  description: 'fake confirm-before tool (the real one is T40)',
  schema: z.object({ title: z.string(), time: z.string() }),
  riskTier: 'confirm-before',
  revalidate: async () => true,
  execute: async (args, _deps, ctx) => {
    await ctx.db.query('INSERT INTO lists (list, item, added_by) VALUES ($1, $2, $3)', [
      `refine-${ctx.conversationId}`,
      `${args.title}@${args.time}`,
      ctx.actionId,
    ]);
    return `event created: ${args.title} at ${args.time}`;
  },
});

const registry = makeToolRegistry<Record<string, never>>([proposeEvent]);
const refine = makeRefineAction(registry);

async function park(
  key: string,
  args: unknown = { title: 'dentist', time: '15:00' },
): Promise<{ conversationId: string; actionId: string }> {
  const conversationId = `conv-${runId}-${key}`;
  const actionId = `act-${runId}-${key}`;
  await createPendingAction(db, {
    actionId,
    conversationId,
    toolCall: { id: `tu-${key}`, name: 'propose_event', args },
    expiresAt: new Date(Date.now() + 12 * 3_600_000),
  });
  await setPromptMessageId(db, actionId, `wa-prompt-${runId}-${key}`);
  return { conversationId, actionId };
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: connectionString });
  db = new Client({ connectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  await db.end();
});

describe('refineAction (T36)', () => {
  it('updates the stored args while status stays pending, and clears the prompt stamp for re-send', async () => {
    const { conversationId, actionId } = await park('happy');

    const outcome = await refine(db, {
      conversationId,
      actionId,
      updatedArgs: { title: 'dentist', time: '16:00' },
    });

    expect(outcome).toMatchObject({
      kind: 'refined',
      actionId,
      toolName: 'propose_event',
      summary: JSON.stringify({ title: 'dentist', time: '16:00' }),
    });
    const row = await getPendingAction(db, actionId);
    expect(row).toMatchObject({
      status: 'pending',
      promptMessageId: null,
      toolCall: { id: 'tu-happy', name: 'propose_event', args: { title: 'dentist', time: '16:00' } },
    });
  });

  it('a refined action approves and executes with the NEW args', async () => {
    const { conversationId, actionId } = await park('roundtrip');
    await refine(db, { conversationId, actionId, updatedArgs: { title: 'dentist', time: '16:00' } });
    const resolve = makeResolveClassifiedDecision(registry, { toolDeps: {} });

    const outcome = await resolve(db, { conversationId, actionId, decision: 'approve' });

    expect(outcome).toMatchObject({ kind: 'executed', result: 'event created: dentist at 16:00' });
    const effects = await db.query('SELECT item FROM lists WHERE list = $1', [
      `refine-${conversationId}`,
    ]);
    expect(effects.rows).toEqual([{ item: 'dentist@16:00' }]);
  });

  it('updated args that fail the tool schema leave the action untouched — never auto-deny', async () => {
    const { conversationId, actionId } = await park('badargs');

    const outcome = await refine(db, {
      conversationId,
      actionId,
      updatedArgs: { title: 'dentist' }, // missing required `time`
    });

    expect(outcome).toMatchObject({ kind: 'invalid', actionId, toolName: 'propose_event' });
    const row = await getPendingAction(db, actionId);
    expect(row).toMatchObject({
      status: 'pending',
      promptMessageId: `wa-prompt-${runId}-badargs`,
      toolCall: { id: 'tu-badargs', name: 'propose_event', args: { title: 'dentist', time: '15:00' } },
    });
  });

  it('refining a settled action reports already-resolved and changes nothing', async () => {
    const { conversationId, actionId } = await park('settled');
    await markDenied(db, actionId);

    const outcome = await refine(db, {
      conversationId,
      actionId,
      updatedArgs: { title: 'dentist', time: '16:00' },
    });

    expect(outcome).toMatchObject({ kind: 'already-resolved', actionId, status: 'denied' });
    const row = await getPendingAction(db, actionId);
    expect(row).toMatchObject({
      status: 'denied',
      toolCall: { id: 'tu-settled', name: 'propose_event', args: { title: 'dentist', time: '15:00' } },
    });
  });

  it('an unknown or cross-conversation action id is unbound — degrades, never throws', async () => {
    const { actionId } = await park('crossconv');

    const missing = await refine(db, {
      conversationId: `conv-${runId}-crossconv`,
      actionId: `act-${runId}-no-such-action`,
      updatedArgs: { title: 'x', time: 'y' },
    });
    const crossConv = await refine(db, {
      conversationId: `conv-${runId}-other`,
      actionId,
      updatedArgs: { title: 'x', time: 'y' },
    });

    expect(missing).toEqual({ kind: 'unbound' });
    expect(crossConv).toEqual({ kind: 'unbound' });
    const row = await getPendingAction(db, actionId);
    expect(row).toMatchObject({ status: 'pending' });
  });

  it('a stored call whose tool no longer exists is invalid — untouched, never throws', async () => {
    const conversationId = `conv-${runId}-goneTool`;
    const actionId = `act-${runId}-goneTool`;
    await createPendingAction(db, {
      actionId,
      conversationId,
      toolCall: { id: 'tu-gone', name: 'tool_that_no_longer_exists', args: {} },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });

    const outcome = await refine(db, {
      conversationId,
      actionId,
      updatedArgs: { title: 'x', time: 'y' },
    });

    expect(outcome).toMatchObject({ kind: 'invalid', actionId });
    const row = await getPendingAction(db, actionId);
    expect(row).toMatchObject({ status: 'pending' });
  });
});
