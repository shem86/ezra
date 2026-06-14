// T34: the production park behind makeRunTool's confirm-before seam, against
// real Postgres. A fake confirm-before tool stands in for the real one (T40);
// what this suite proves is the row write, the TTL, and the synthetic
// pending tool_result — the transactional-step boundary stays the composer's
// job (same shape as tools.test.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { z } from 'zod';
import { runMigrations } from '../../src/memory/migrate.ts';
import { defineTool } from '../../src/tools/define-tool.ts';
import { deriveActionId, makeRunTool, makeToolRegistry } from '../../src/tools/registry.ts';
import { makePark } from '../../src/hitl/park.ts';
import { sendApprovalPrompts } from '../../src/hitl/approval-prompt.ts';
import { getPendingAction, getSentEntry } from '../../src/memory/store.ts';
import { createStubTransport } from '../../src/transport/stub.ts';
import { approvalSendId } from '../../src/transport/send-class.ts';
import type { ToolCall } from '../../src/agent/context.ts';

const connectionString = process.env.DATABASE_URL ?? '';
const runId = `run-${Date.now()}`;
const conv = `park-${runId}`;
let db: Client;

const fakeConfirmBefore = defineTool<Record<string, never>, z.ZodType<{ title: string }>>({
  name: 'fake_confirm_before',
  description: 'test stand-in for a confirm-before tool (the real one is T40)',
  schema: z.object({ title: z.string() }),
  riskTier: 'confirm-before',
  revalidate: async () => true,
  execute: async () => {
    throw new Error('confirm-before tools must never execute at propose time');
  },
});

const runTool = makeRunTool(makeToolRegistry([fakeConfirmBefore]), {
  toolDeps: {},
  park: makePark({ ttlHours: 12 }),
});

let nextId = 0;
function call(args: unknown): ToolCall {
  nextId += 1;
  return { id: `tu-${runId}-${nextId}`, name: 'fake_confirm_before', args };
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: connectionString });
  db = new Client({ connectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  await db.end();
});

describe('production park (T34)', () => {
  it('writes the pending row and answers the tool_use with a synthetic pending result', async () => {
    const before = Date.now();
    const parkCall = call({ title: 'dentist Tuesday 15:00' });
    const result = await runTool(db, parkCall, conv);

    const actionId = deriveActionId(conv, parkCall.id);
    expect(result.parked).toBe(true);
    expect(result.toolUseId).toBe(parkCall.id);
    expect(result.content).toContain(actionId);
    expect(result.content).toMatch(/pending approval/);

    const row = await getPendingAction(db, actionId);
    expect(row?.status).toBe('pending');
    expect(row?.conversationId).toBe(conv);
    expect(row?.toolCall).toEqual(parkCall);
    expect(row?.promptMessageId).toBeNull();

    // expires_at = park time + 12h (Open Q1 resolved here); generous skew
    // bounds keep this assertion honest without being flaky.
    const ttlMs = 12 * 3_600_000;
    expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 60_000);
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ttlMs + 60_000);
  });

  it('sends one approval prompt per unstamped action and persists each message id', async () => {
    const conv2 = `park-send-${runId}`;
    const callA = call({ title: 'first' });
    const callB = call({ title: 'second' });
    await runTool(db, callA, conv2);
    await runTool(db, callB, conv2);

    const transport = createStubTransport();
    await transport.connect();
    const sent = await sendApprovalPrompts(db, transport, conv2);

    expect(sent).toEqual([deriveActionId(conv2, callA.id), deriveActionId(conv2, callB.id)]);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]?.conversationId).toBe(conv2);
    expect(transport.sent[0]?.text).toContain(deriveActionId(conv2, callA.id));
    expect(transport.sent[0]?.text).toContain('first');
    expect(transport.sent[1]?.text).toContain(deriveActionId(conv2, callB.id));

    const rowA = await getPendingAction(db, deriveActionId(conv2, callA.id));
    const rowB = await getPendingAction(db, deriveActionId(conv2, callB.id));
    expect(rowA?.promptMessageId).toBe('stub-sent-1');
    expect(rowB?.promptMessageId).toBe('stub-sent-2');

    // Already-stamped actions are never re-prompted.
    expect(await sendApprovalPrompts(db, transport, conv2)).toEqual([]);
    expect(transport.sent).toHaveLength(2);
  });

  it('co-commits the sent_log row with the prompt_message_id stamp (T43, at-least-once)', async () => {
    const conv4 = `park-log-${runId}`;
    const callA = call({ title: 'co-commit me' });
    await runTool(db, callA, conv4);
    const actionId = deriveActionId(conv4, callA.id);

    const transport = createStubTransport();
    await transport.connect();
    await sendApprovalPrompts(db, transport, conv4);

    // Both halves of the co-commit landed: the at-least-once sent_log row (the
    // runbook's "what did we send" view) and the quoted-reply anchor stamp.
    const entry = await getSentEntry(db, approvalSendId(actionId));
    expect(entry?.deliveryClass).toBe('at-least-once');
    expect(entry?.conversationId).toBe(conv4);
    const row = await getPendingAction(db, actionId);
    expect(row?.promptMessageId).toBe('stub-sent-1'); // fresh stub, first send
  });

  it('schema-invalid args return an error result and park nothing', async () => {
    const badCall = call({ title: 42 });
    const result = await runTool(db, badCall, conv);

    expect(result.parked).toBe(false);
    expect(result.content).toMatch(/invalid arguments/);
    expect(await getPendingAction(db, deriveActionId(conv, badCall.id))).toBeNull();
  });
});

// T40: prompts sent with a registry render the tool's summarize() one-liner
// (the human proposal line), not the raw-args JSON.
describe('sendApprovalPrompts with a registry', () => {
  it('renders the per-tool summary in the sent prompt text', async () => {
    const summarized = defineTool<Record<string, never>, z.ZodType<{ title: string }>>({
      name: 'fake_confirm_before',
      description: 'summarizing confirm-before tool',
      schema: z.object({ title: z.string() }),
      riskTier: 'confirm-before',
      revalidate: async () => true,
      summarize: (args) => `human summary: ${args.title}`,
      execute: async () => {
        throw new Error('never at propose time');
      },
    });
    const registry = makeToolRegistry<Record<string, never>>([summarized]);
    const summarizedRunTool = makeRunTool(registry, {
      toolDeps: {},
      park: makePark({ ttlHours: 12 }),
    });

    const conv3 = `park-summarize-${runId}`;
    const parkedCall: ToolCall = {
      id: `tu-sum-${runId}`,
      name: 'fake_confirm_before',
      args: { title: 'תור לרופא' },
    };
    await summarizedRunTool(db, parkedCall, conv3);

    const transport = createStubTransport();
    await transport.connect();
    await sendApprovalPrompts(db, transport, conv3, registry);

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain('human summary: תור לרופא');
    expect(transport.sent[0]?.text).not.toContain('{');
  });
});
