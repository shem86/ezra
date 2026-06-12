// Calendar tools (T40): schema strictness, Eastern wall-time anchoring,
// deterministic event id, revalidation that exempts our own id, the
// 409-as-success replay path, and read-error folding (ledger #5) — all
// against a fake CalendarClient. The real wire is T41's gate.

import { describe, expect, it } from 'vitest';
import {
  createCalendarEventTool,
  listCalendarEventsTool,
  type CalendarToolDeps,
} from '../../src/tools/calendar.ts';
import {
  CalendarRequestError,
  deriveCalendarEventId,
  type CalendarClient,
  type CalendarEventInput,
  type CalendarEventSummary,
  type CreateEventResult,
} from '../../src/tools/calendar-client.ts';
import type { ToolContext } from '../../src/tools/define-tool.ts';
import type { Embedder } from '../../src/memory/embedder.ts';

interface FakeCalls {
  created: CalendarEventInput[];
  isFreeArgs: Array<{ owner: string; start: Date; end: Date; ignoreEventId?: string }>;
  listArgs: Array<{ owner: string; start: Date; end: Date }>;
}

function makeFakeClient(
  behavior: {
    free?: boolean;
    createResult?: CreateEventResult;
    events?: CalendarEventSummary[];
    throwOn?: 'list' | 'create';
  } = {},
): { client: CalendarClient; calls: FakeCalls } {
  const calls: FakeCalls = { created: [], isFreeArgs: [], listArgs: [] };
  const client: CalendarClient = {
    async createEvent(input) {
      if (behavior.throwOn === 'create') throw new CalendarRequestError('calendar create: HTTP 503', 503);
      calls.created.push(input);
      return behavior.createResult ?? 'created';
    },
    async listEvents(owner, window) {
      if (behavior.throwOn === 'list') throw new CalendarRequestError('calendar list: HTTP 503', 503);
      calls.listArgs.push({ owner, start: window.start, end: window.end });
      return behavior.events ?? [];
    },
    async isFree(owner, window, options) {
      calls.isFreeArgs.push({
        owner,
        start: window.start,
        end: window.end,
        ...(options?.ignoreEventId === undefined ? {} : { ignoreEventId: options.ignoreEventId }),
      });
      return behavior.free ?? true;
    },
  };
  return { client, calls };
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

function depsWith(client: CalendarClient): CalendarToolDeps {
  return { embedder: neverEmbedder, calendarClient: client };
}

function ctx(actionId = 'act-conv-1-tu_1'): ToolContext {
  return {
    actionId,
    conversationId: 'conv-1',
    toolUseId: 'tu_1',
    db: { query: async () => ({ rows: [] }) } as never,
    externalId: deriveCalendarEventId(actionId),
  };
}

describe('create_calendar_event', () => {
  it('is confirm-before with a revalidation check and a deterministic external id', () => {
    expect(createCalendarEventTool.riskTier).toBe('confirm-before');
    expect(createCalendarEventTool.revalidate).toBeDefined();
    const idCtx = { actionId: 'act-x', conversationId: 'c', toolUseId: 't' };
    expect(createCalendarEventTool.externalId!(idCtx)).toBe(deriveCalendarEventId('act-x'));
    expect(createCalendarEventTool.externalId!(idCtx)).toBe(
      createCalendarEventTool.externalId!(idCtx),
    );
  });

  it('rejects loose date/time formats and unknown owners', () => {
    const base = { title: 'תור', date: '2026-06-25', time: '16:00', owner: 'husband' };
    expect(createCalendarEventTool.schema.safeParse(base).success).toBe(true);
    expect(createCalendarEventTool.schema.safeParse({ ...base, time: '4pm' }).success).toBe(false);
    expect(
      createCalendarEventTool.schema.safeParse({ ...base, date: '25/06/2026' }).success,
    ).toBe(false);
    expect(
      createCalendarEventTool.schema.safeParse({ ...base, owner: 'grandma' }).success,
    ).toBe(false);
  });

  it('defaults durationMin to 60', () => {
    const parsed = createCalendarEventTool.schema.parse({
      title: 'x',
      date: '2026-06-25',
      time: '16:00',
      owner: 'wife',
    });
    expect(parsed.durationMin).toBe(60);
  });

  it('anchors wall times to the household timezone for an EDT and an EST date', async () => {
    const { client, calls } = makeFakeClient();
    const edt = createCalendarEventTool.schema.parse({
      title: 'dentist',
      date: '2026-06-25',
      time: '16:00',
      owner: 'husband',
    });
    await createCalendarEventTool.execute(edt, depsWith(client), ctx());
    expect(calls.created[0]!.start.toISOString()).toBe('2026-06-25T20:00:00.000Z');
    expect(calls.created[0]!.end.toISOString()).toBe('2026-06-25T21:00:00.000Z');

    const est = createCalendarEventTool.schema.parse({
      title: 'parent meeting',
      date: '2026-01-15',
      time: '19:00',
      durationMin: 30,
      owner: 'wife',
    });
    await createCalendarEventTool.execute(est, depsWith(client), ctx('act-conv-1-tu_2'));
    expect(calls.created[1]!.start.toISOString()).toBe('2026-01-16T00:00:00.000Z');
    expect(calls.created[1]!.end.toISOString()).toBe('2026-01-16T00:30:00.000Z');
    expect(calls.created[1]!.owner).toBe('wife');
  });

  it('creates with the deterministic event id and reports the owner in the result', async () => {
    const { client, calls } = makeFakeClient();
    const args = createCalendarEventTool.schema.parse({
      title: 'תור לרופא',
      date: '2026-06-25',
      time: '16:00',
      owner: 'wife',
    });
    const result = await createCalendarEventTool.execute(args, depsWith(client), ctx());
    expect(calls.created[0]!.eventId).toBe(deriveCalendarEventId('act-conv-1-tu_1'));
    expect(result).toContain('תור לרופא');
    expect(result).toContain('wife');
  });

  it('treats already-exists as success — the recovery-replay no-op', async () => {
    const { client } = makeFakeClient({ createResult: 'already-exists' });
    const args = createCalendarEventTool.schema.parse({
      title: 'dentist',
      date: '2026-06-25',
      time: '16:00',
      owner: 'husband',
    });
    const result = await createCalendarEventTool.execute(args, depsWith(client), ctx());
    expect(result.toLowerCase()).toContain('already');
    expect(result.toLowerCase()).not.toContain('error');
  });

  it("revalidates the target owner's slot and exempts its own event id", async () => {
    const { client, calls } = makeFakeClient({ free: true });
    const args = createCalendarEventTool.schema.parse({
      title: 'dentist',
      date: '2026-06-25',
      time: '16:00',
      owner: 'wife',
    });
    const ok = await createCalendarEventTool.revalidate!(args, depsWith(client), {
      actionId: 'act-conv-1-tu_1',
      conversationId: 'conv-1',
      toolUseId: 'tu_1',
      externalId: deriveCalendarEventId('act-conv-1-tu_1'),
    });
    expect(ok).toBe(true);
    expect(calls.isFreeArgs[0]).toEqual({
      owner: 'wife',
      start: new Date('2026-06-25T20:00:00.000Z'),
      end: new Date('2026-06-25T21:00:00.000Z'),
      ignoreEventId: deriveCalendarEventId('act-conv-1-tu_1'),
    });
  });

  it('summarizes humanly for the approval prompt and digest', () => {
    const args = createCalendarEventTool.schema.parse({
      title: 'תור לרופא שיניים',
      date: '2026-06-25',
      time: '16:00',
      owner: 'husband',
    });
    const summary = createCalendarEventTool.summarize!(args);
    expect(summary).toContain('תור לרופא שיניים');
    expect(summary).toContain('2026-06-25');
    expect(summary).toContain('16:00');
    expect(summary).toContain('husband');
    expect(summary).not.toContain('{');
  });

  it('tells the model it only proposes — never to report the event as booked', () => {
    expect(createCalendarEventTool.description.toLowerCase()).toContain('approve');
  });
});

describe('list_calendar_events', () => {
  it('is an autonomous read', () => {
    expect(listCalendarEventsTool.riskTier).toBe('autonomous');
  });

  it('lists the inclusive Eastern date range and renders events in household time', async () => {
    const { client, calls } = makeFakeClient({
      events: [
        {
          eventId: 'evt1',
          title: 'חוג ג׳ודו',
          start: new Date('2026-06-25T20:00:00Z'),
          end: new Date('2026-06-25T21:00:00Z'),
          allDay: false,
        },
        {
          eventId: 'evt2',
          title: 'Birthday',
          start: new Date('2026-06-26T00:00:00Z'),
          end: new Date('2026-06-27T00:00:00Z'),
          allDay: true,
        },
      ],
    });
    const args = listCalendarEventsTool.schema.parse({
      owner: 'husband',
      fromDate: '2026-06-25',
      toDate: '2026-06-26',
    });
    const result = await listCalendarEventsTool.execute(args, depsWith(client), ctx());

    // Window: Eastern midnight June 25 (04:00Z, EDT) → Eastern midnight June 27.
    expect(calls.listArgs[0]!.start.toISOString()).toBe('2026-06-25T04:00:00.000Z');
    expect(calls.listArgs[0]!.end.toISOString()).toBe('2026-06-27T04:00:00.000Z');
    expect(result).toContain('חוג ג׳ודו');
    expect(result).toContain('2026-06-25 16:00'); // 20:00Z rendered as Eastern wall time
    expect(result).toContain('Birthday');
    expect(result).toContain('all day');
  });

  it('reports an empty range plainly', async () => {
    const { client } = makeFakeClient({ events: [] });
    const args = listCalendarEventsTool.schema.parse({
      owner: 'wife',
      fromDate: '2026-06-25',
      toDate: '2026-06-25',
    });
    const result = await listCalendarEventsTool.execute(args, depsWith(client), ctx());
    expect(result.toLowerCase()).toContain('no events');
  });

  it('rejects a reversed or oversized range at the schema', () => {
    const reversed = listCalendarEventsTool.schema.safeParse({
      owner: 'husband',
      fromDate: '2026-06-26',
      toDate: '2026-06-25',
    });
    expect(reversed.success).toBe(false);
    const oversized = listCalendarEventsTool.schema.safeParse({
      owner: 'husband',
      fromDate: '2026-01-01',
      toDate: '2026-03-15',
    });
    expect(oversized.success).toBe(false);
  });

  it('folds a calendar failure into an error tool_result instead of throwing (ledger #5)', async () => {
    const { client } = makeFakeClient({ throwOn: 'list' });
    const args = listCalendarEventsTool.schema.parse({
      owner: 'wife',
      fromDate: '2026-06-25',
      toDate: '2026-06-25',
    });
    const result = await listCalendarEventsTool.execute(args, depsWith(client), ctx());
    expect(result.toLowerCase()).toContain('calendar');
    expect(result.toLowerCase()).toContain('failed');
  });
});
