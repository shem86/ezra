// T35: the approval resolver — the one transactional body a quoted reply
// runs through. Tested against real Postgres with fake confirm-before tools
// (the real one is T40); the composer wraps this body in
// registerTransactionalStep, so everything it does co-commits with the step
// checkpoint. The concurrency tests run it inside explicit BEGIN/COMMIT on
// separate connections to prove the row guards alone (not the conversation
// queue) make execution single-winner.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { z } from 'zod';
import { runMigrations } from '../../src/memory/migrate.ts';
import { createPendingAction, setPromptMessageId } from '../../src/memory/store.ts';
import { markDenied } from '../../src/hitl/pending-actions.ts';
import { defineTool } from '../../src/tools/define-tool.ts';
import { makeToolRegistry } from '../../src/tools/registry.ts';
import {
  makeResolveApprovalReply,
  makeResolveClassifiedDecision,
} from '../../src/hitl/resolve-approval.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL required');

const runId = `run-${Date.now()}`;
let db: Client;

interface EventToolDeps {
  readonly revalidateOk: boolean;
}

const proposeEvent = defineTool<EventToolDeps, z.ZodType<{ title: string }>>({
  name: 'propose_event',
  description: 'fake confirm-before tool (the real one is T40)',
  schema: z.object({ title: z.string() }),
  riskTier: 'confirm-before',
  revalidate: async (_args, deps) => deps.revalidateOk,
  execute: async (args, _deps, ctx) => {
    await ctx.db.query('INSERT INTO lists (list, item, added_by) VALUES ($1, $2, $3)', [
      `approvals-${ctx.conversationId}`,
      args.title,
      ctx.actionId,
    ]);
    return `event created: ${args.title}`;
  },
});

const registry = makeToolRegistry<EventToolDeps>([proposeEvent]);

function makeResolver(revalidateOk: boolean) {
  return makeResolveApprovalReply(registry, { toolDeps: { revalidateOk } });
}

async function parkAndStamp(
  key: string,
  toolCall: unknown = { id: `tu-${key}`, name: 'propose_event', args: { title: 'תור לרופא' } },
): Promise<{ conversationId: string; actionId: string; promptMessageId: string }> {
  const conversationId = `conv-${runId}-${key}`;
  const actionId = `act-${runId}-${key}`;
  const promptMessageId = `wa-prompt-${runId}-${key}`;
  await createPendingAction(db, {
    actionId,
    conversationId,
    toolCall,
    expiresAt: new Date(Date.now() + 12 * 3_600_000),
  });
  await setPromptMessageId(db, actionId, promptMessageId);
  return { conversationId, actionId, promptMessageId };
}

async function effectCount(conversationId: string): Promise<number> {
  const res = await db.query('SELECT count(*)::int AS n FROM lists WHERE list = $1', [
    `approvals-${conversationId}`,
  ]);
  return (res.rows[0] as { n: number }).n;
}

async function actionStatus(actionId: string): Promise<string> {
  const res = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
  return (res.rows[0] as { status: string }).status;
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: connectionString });
  db = new Client({ connectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  await db.end();
});

describe('resolveApprovalReply (T35)', () => {
  it('approve: revalidates, claims, executes — effect committed, status executed', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('approve');
    const resolve = makeResolver(true);

    const outcome = await resolve(db, { conversationId, quotedMessageId: promptMessageId, text: 'כן' });

    expect(outcome).toMatchObject({
      kind: 'executed',
      actionId,
      toolName: 'propose_event',
      result: 'event created: תור לרופא',
    });
    expect(await actionStatus(actionId)).toBe('executed');
    expect(await effectCount(conversationId)).toBe(1);
  });

  it('deny: flips to denied, never executes', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('deny');
    const resolve = makeResolver(true);

    const outcome = await resolve(db, { conversationId, quotedMessageId: promptMessageId, text: 'no' });

    expect(outcome).toMatchObject({ kind: 'denied', actionId, toolName: 'propose_event' });
    expect(await actionStatus(actionId)).toBe('denied');
    expect(await effectCount(conversationId)).toBe(0);
  });

  it('unclear reply: action untouched, normal turn takes over', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('unclear');
    const resolve = makeResolver(true);

    const outcome = await resolve(db, {
      conversationId,
      quotedMessageId: promptMessageId,
      text: 'make it 4pm',
    });

    expect(outcome).toMatchObject({ kind: 'unclear', actionId });
    expect(await actionStatus(actionId)).toBe('pending');
    expect(await effectCount(conversationId)).toBe(0);
  });

  it('a quote of a non-prompt message is unbound — degrades to a normal turn', async () => {
    const { conversationId } = await parkAndStamp('unbound');
    const resolve = makeResolver(true);

    const outcome = await resolve(db, {
      conversationId,
      quotedMessageId: `wa-some-other-message-${runId}`,
      text: 'yes',
    });

    expect(outcome).toEqual({ kind: 'unbound' });
  });

  it('revalidation failure: action goes stale, tool never executes, user gets told', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('stale');
    const resolve = makeResolver(false);

    const outcome = await resolve(db, { conversationId, quotedMessageId: promptMessageId, text: 'yes' });

    expect(outcome).toMatchObject({ kind: 'stale', actionId, toolName: 'propose_event' });
    expect(await actionStatus(actionId)).toBe('stale');
    expect(await effectCount(conversationId)).toBe(0);
  });

  it('a tool_call that no longer parses goes stale instead of throwing', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('corrupt', {
      id: 'tu-corrupt',
      name: 'tool_that_no_longer_exists',
      args: {},
    });
    const resolve = makeResolver(true);

    const outcome = await resolve(db, { conversationId, quotedMessageId: promptMessageId, text: 'yes' });

    expect(outcome).toMatchObject({ kind: 'stale', actionId });
    expect(await actionStatus(actionId)).toBe('stale');
  });

  it('sequential double approval: the second reports already-resolved, effect stays single', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('seq');
    const resolve = makeResolver(true);

    const first = await resolve(db, { conversationId, quotedMessageId: promptMessageId, text: 'yes' });
    const second = await resolve(db, { conversationId, quotedMessageId: promptMessageId, text: 'כן' });

    expect(first).toMatchObject({ kind: 'executed' });
    expect(second).toMatchObject({ kind: 'already-resolved', actionId, status: 'executed' });
    expect(await effectCount(conversationId)).toBe(1);
  });

  it('approving an already-denied action reports already-resolved', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('postdeny');
    await markDenied(db, actionId);
    const resolve = makeResolver(true);

    const outcome = await resolve(db, { conversationId, quotedMessageId: promptMessageId, text: 'yes' });

    expect(outcome).toMatchObject({ kind: 'already-resolved', actionId, status: 'denied' });
    expect(await effectCount(conversationId)).toBe(0);
  });

  it('classified approve (T36): same full path — revalidate, claim, execute', async () => {
    const { conversationId, actionId } = await parkAndStamp('cls-approve');
    const resolve = makeResolveClassifiedDecision(registry, { toolDeps: { revalidateOk: true } });

    const outcome = await resolve(db, { conversationId, actionId, decision: 'approve' });

    expect(outcome).toMatchObject({
      kind: 'executed',
      actionId,
      toolName: 'propose_event',
      result: 'event created: תור לרופא',
    });
    expect(await actionStatus(actionId)).toBe('executed');
    expect(await effectCount(conversationId)).toBe(1);
  });

  it('classified deny (T36): flips to denied, never executes', async () => {
    const { conversationId, actionId } = await parkAndStamp('cls-deny');
    const resolve = makeResolveClassifiedDecision(registry, { toolDeps: { revalidateOk: true } });

    const outcome = await resolve(db, { conversationId, actionId, decision: 'deny' });

    expect(outcome).toMatchObject({ kind: 'denied', actionId, toolName: 'propose_event' });
    expect(await actionStatus(actionId)).toBe('denied');
    expect(await effectCount(conversationId)).toBe(0);
  });

  it('classified approve on a settled action reports already-resolved, effect stays single', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('cls-settled');
    const quoted = makeResolver(true);
    await quoted(db, { conversationId, quotedMessageId: promptMessageId, text: 'yes' });
    const resolve = makeResolveClassifiedDecision(registry, { toolDeps: { revalidateOk: true } });

    const outcome = await resolve(db, { conversationId, actionId, decision: 'approve' });

    expect(outcome).toMatchObject({ kind: 'already-resolved', actionId, status: 'executed' });
    expect(await effectCount(conversationId)).toBe(1);
  });

  it('classified decision for an unknown action id is unbound — degrades, never throws', async () => {
    const resolve = makeResolveClassifiedDecision(registry, { toolDeps: { revalidateOk: true } });

    const outcome = await resolve(db, {
      conversationId: `conv-${runId}-cls-missing`,
      actionId: `act-${runId}-no-such-action`,
      decision: 'approve',
    });

    expect(outcome).toEqual({ kind: 'unbound' });
  });

  it("classified decision scoped to the conversation — another conversation's action id is unbound", async () => {
    const { actionId, conversationId } = await parkAndStamp('cls-crossconv');
    const resolve = makeResolveClassifiedDecision(registry, { toolDeps: { revalidateOk: true } });

    const outcome = await resolve(db, {
      conversationId: `conv-${runId}-cls-other`,
      actionId,
      decision: 'approve',
    });

    expect(outcome).toEqual({ kind: 'unbound' });
    expect(await actionStatus(actionId)).toBe('pending');
    expect(await effectCount(conversationId)).toBe(0);
  });

  it('classified approve that fails revalidation goes stale, never executes', async () => {
    const { conversationId, actionId } = await parkAndStamp('cls-stale');
    const resolve = makeResolveClassifiedDecision(registry, { toolDeps: { revalidateOk: false } });

    const outcome = await resolve(db, { conversationId, actionId, decision: 'approve' });

    expect(outcome).toMatchObject({ kind: 'stale', actionId, toolName: 'propose_event' });
    expect(await actionStatus(actionId)).toBe('stale');
    expect(await effectCount(conversationId)).toBe(0);
  });

  it('concurrent double approval: row guards alone make execution single-winner', async () => {
    const { conversationId, actionId, promptMessageId } = await parkAndStamp('race');
    const resolve = makeResolver(true);

    const clientA = new Client({ connectionString });
    const clientB = new Client({ connectionString });
    await clientA.connect();
    await clientB.connect();
    try {
      const inTransaction = async (client: Client) => {
        await client.query('BEGIN');
        try {
          const outcome = await resolve(client, {
            conversationId,
            quotedMessageId: promptMessageId,
            text: 'yes',
          });
          await client.query('COMMIT');
          return outcome;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      };
      const [a, b] = await Promise.all([inTransaction(clientA), inTransaction(clientB)]);

      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['already-resolved', 'executed']);
      expect(await effectCount(conversationId)).toBe(1);
      expect(await actionStatus(actionId)).toBe('executed');
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });
});
