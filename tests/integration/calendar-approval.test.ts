// T40 acceptance lock: the REAL create_calendar_event through the REAL
// park → approve → execute path against real Postgres, with a fake
// CalendarClient standing in for Google (never real calendar writes in CI —
// the real wire is T41's gate). What the fakes can't prove — the wire — the
// T39 spike already did; what the spike can't prove — the approval
// machinery around the tool — lands here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/memory/migrate.ts';
import { makeRunTool, makeToolRegistry, deriveActionId } from '../../src/tools/registry.ts';
import { makeV1ToolRegistry } from '../../src/tools/index.ts';
import {
  CalendarRequestError,
  deriveCalendarEventId,
  type CalendarClient,
  type CalendarEventInput,
} from '../../src/tools/calendar-client.ts';
import type { CalendarToolDeps } from '../../src/tools/calendar.ts';
import { makePark } from '../../src/hitl/park.ts';
import { sendApprovalPrompts } from '../../src/hitl/approval-prompt.ts';
import { makeResolveApprovalReply } from '../../src/hitl/resolve-approval.ts';
import { createStubTransport } from '../../src/transport/stub.ts';
import type { Embedder } from '../../src/memory/embedder.ts';
import type { ToolCall } from '../../src/agent/context.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL required');

const runId = `cal-${Date.now()}`;
let db: Client;

/** In-memory Google: idempotent on eventId, flippable busy flag, failure mode. */
function makeFakeCalendar(): {
  client: CalendarClient;
  events: Map<string, CalendarEventInput>;
  state: { busy: boolean; failWith?: number };
} {
  const events = new Map<string, CalendarEventInput>();
  const state: { busy: boolean; failWith?: number } = { busy: false };
  const client: CalendarClient = {
    async createEvent(input) {
      if (state.failWith !== undefined) {
        throw new CalendarRequestError(`calendar create: HTTP ${state.failWith}`, state.failWith);
      }
      if (events.has(input.eventId)) return 'already-exists';
      events.set(input.eventId, input);
      return 'created';
    },
    async listEvents() {
      return [...events.values()].map((e) => ({
        eventId: e.eventId,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: false,
      }));
    },
    async isFree(_owner, _window, options) {
      if (state.failWith !== undefined) {
        throw new CalendarRequestError(`calendar list: HTTP ${state.failWith}`, state.failWith);
      }
      if (state.busy) return false;
      return ![...events.keys()].some((id) => id !== options?.ignoreEventId);
    },
  };
  return { client, events, state };
}

const neverEmbedder: Embedder = {
  dimension: 1024,
  embedDocuments: async () => {
    throw new Error('unused');
  },
  embedQuery: async () => {
    throw new Error('unused');
  },
};

interface Fixture {
  conversationId: string;
  actionId: string;
  events: Map<string, CalendarEventInput>;
  state: { busy: boolean; failWith?: number };
  resolve: ReturnType<typeof makeResolveApprovalReply<CalendarToolDeps>>;
  promptText: string;
  promptMessageId: string;
}

/** Park a create_calendar_event through the real runTool + makePark, stamp it. */
async function parkCalendarEvent(key: string): Promise<Fixture> {
  const conversationId = `conv-${runId}-${key}`;
  const { client, events, state } = makeFakeCalendar();
  const registry = makeToolRegistry<CalendarToolDeps>([...makeV1ToolRegistry().values()]);
  const toolDeps: CalendarToolDeps = { embedder: neverEmbedder, calendarClient: client };
  const runTool = makeRunTool(registry, { toolDeps, park: makePark({ ttlHours: 12 }) });

  const call: ToolCall = {
    id: `tu-${key}`,
    name: 'create_calendar_event',
    args: { title: 'תור לרופא שיניים', date: '2026-06-25', time: '16:00', owner: 'wife' },
  };
  const result = await runTool(db, call, conversationId);
  expect(result.parked).toBe(true);
  expect(events.size).toBe(0); // confirm-before: nothing reaches the calendar at propose time

  const transport = createStubTransport();
  await transport.connect();
  await sendApprovalPrompts(db, transport, conversationId, registry);
  const promptMessageId = (
    await db.query(
      'SELECT prompt_message_id FROM pending_actions WHERE conversation_id = $1',
      [conversationId],
    )
  ).rows[0]!.prompt_message_id as string;

  return {
    conversationId,
    actionId: deriveActionId(conversationId, call.id),
    events,
    state,
    resolve: makeResolveApprovalReply(registry, { toolDeps }),
    promptText: transport.sent[0]!.text,
    promptMessageId,
  };
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

describe('create_calendar_event through the approval machinery (T40)', () => {
  it('parks with a human prompt, then a quoted approval creates exactly one event with the deterministic id', async () => {
    const fx = await parkCalendarEvent('roundtrip');

    // The prompt the spouse quotes reads humanly, not as raw JSON.
    expect(fx.promptText).toContain('תור לרופא שיניים');
    expect(fx.promptText).toContain('2026-06-25');
    expect(fx.promptText).toContain("wife's calendar");
    expect(fx.promptText).not.toContain('{');

    const outcome = await fx.resolve(db, {
      conversationId: fx.conversationId,
      quotedMessageId: fx.promptMessageId,
      text: 'כן',
    });

    expect(outcome.kind).toBe('executed');
    expect(await actionStatus(fx.actionId)).toBe('executed');
    expect(fx.events.size).toBe(1);
    const event = [...fx.events.values()][0]!;
    expect(event.eventId).toBe(deriveCalendarEventId(fx.actionId));
    expect(event.owner).toBe('wife');
    // Eastern anchoring end to end: June 25 16:00 EDT is 20:00Z.
    expect(event.start.toISOString()).toBe('2026-06-25T20:00:00.000Z');
    expect(event.end.toISOString()).toBe('2026-06-25T21:00:00.000Z');
  });

  it('a conflicted slot at approval time goes stale and never reaches the calendar', async () => {
    const fx = await parkCalendarEvent('conflict');
    fx.state.busy = true;

    const outcome = await fx.resolve(db, {
      conversationId: fx.conversationId,
      quotedMessageId: fx.promptMessageId,
      text: 'yes',
    });

    expect(outcome.kind).toBe('stale');
    expect(await actionStatus(fx.actionId)).toBe('stale');
    expect(fx.events.size).toBe(0);
  });

  it('a calendar outage folds to failed/pending; a later re-approval retries and creates once', async () => {
    const fx = await parkCalendarEvent('outage');
    fx.state.failWith = 503;

    const failed = await fx.resolve(db, {
      conversationId: fx.conversationId,
      quotedMessageId: fx.promptMessageId,
      text: 'yes',
    });
    expect(failed).toMatchObject({ kind: 'failed', toolName: 'create_calendar_event' });
    expect(await actionStatus(fx.actionId)).toBe('pending');
    expect(fx.events.size).toBe(0);

    delete fx.state.failWith;
    const retried = await fx.resolve(db, {
      conversationId: fx.conversationId,
      quotedMessageId: fx.promptMessageId,
      text: 'כן',
    });
    expect(retried.kind).toBe('executed');
    expect(fx.events.size).toBe(1);
  });

  it('a replayed execute is a no-op: same deterministic id, already-exists folds to success', async () => {
    const fx = await parkCalendarEvent('replay');
    const approved = await fx.resolve(db, {
      conversationId: fx.conversationId,
      quotedMessageId: fx.promptMessageId,
      text: 'yes',
    });
    expect(approved.kind).toBe('executed');
    expect(fx.events.size).toBe(1);

    // Recovery-style re-execution of the same action: the tool derives the
    // SAME event id, the calendar answers already-exists, the result reads
    // as success and nothing is duplicated.
    const registry = makeV1ToolRegistry();
    const def = registry.get('create_calendar_event')!;
    const args = def.schema.parse({
      title: 'תור לרופא שיניים',
      date: '2026-06-25',
      time: '16:00',
      owner: 'wife',
    });
    const replayResult = await def.execute(
      args,
      { embedder: neverEmbedder, calendarClient: makeReplayClient(fx.events) },
      {
        actionId: fx.actionId,
        conversationId: fx.conversationId,
        toolUseId: 'tu-replay',
        db: db as never,
        externalId: deriveCalendarEventId(fx.actionId),
      },
    );
    expect(replayResult.toLowerCase()).toContain('already');
    expect(fx.events.size).toBe(1);
  });
});

/** Replay client over the SAME event store — only the idempotency path matters. */
function makeReplayClient(events: Map<string, CalendarEventInput>): CalendarClient {
  return {
    async createEvent(input) {
      if (events.has(input.eventId)) return 'already-exists';
      events.set(input.eventId, input);
      return 'created';
    },
    async listEvents() {
      return [];
    },
    async isFree() {
      return true;
    },
  };
}
