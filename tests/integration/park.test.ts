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
import { getPendingAction } from '../../src/memory/store.ts';
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

  it('schema-invalid args return an error result and park nothing', async () => {
    const badCall = call({ title: 42 });
    const result = await runTool(db, badCall, conv);

    expect(result.parked).toBe(false);
    expect(result.content).toMatch(/invalid arguments/);
    expect(await getPendingAction(db, deriveActionId(conv, badCall.id))).toBeNull();
  });
});
