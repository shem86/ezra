// T38: the five decision-9 scenarios + execute-once-double-approval + the
// T27 sender-attribution deferral, driven through the REAL composition
// (Sonnet turns, Haiku classification, Postgres, the full T34–T37 approval
// machinery). Every assertion is on STATE — row status, effect counts, the
// new context message, exactly one tool_result per tool_use — never on
// reply wording: model output is nondeterministic, state is the contract.
// The M5 gate is this file passing. Costs money — `pnpm eval`, never CI.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evalScenarios, type EvalScenario } from './fixtures/decision9.ts';
import { createCalendarEventTool } from '../src/tools/calendar.ts';
import { deriveCalendarEventId, type CalendarWindow } from '../src/tools/calendar-client.ts';
import { wallTimeToInstant } from '../src/orchestration/tz.ts';
import { composeEvalHarness, type EvalActionRow, type EvalHarness } from './harness/runner.ts';
import type { TurnMessage } from '../src/agent/context.ts';

let h: EvalHarness;
const startedAt = new Date();

beforeAll(async () => {
  h = await composeEvalHarness();
}, 120_000);

afterAll(async () => {
  await h.shutdown();
});

function scenario(name: string): EvalScenario {
  const found = evalScenarios.find((s) => s.name === name);
  if (found === undefined) throw new Error(`unknown scenario ${name}`);
  return found;
}

interface EventArgs {
  readonly title: string;
  readonly date: string;
  readonly time: string;
  readonly durationMin: number;
  readonly owner: 'husband' | 'wife';
}

function eventArgs(action: EvalActionRow): EventArgs {
  return createCalendarEventTool.schema.parse(action.toolCall.args);
}

/** The window the tool derives from the args — for the manufactured conflict. */
function windowFor(args: EventArgs): CalendarWindow {
  const [year, month, day] = args.date.split('-').map(Number);
  const [hour, minute] = args.time.split(':').map(Number);
  const start = wallTimeToInstant({ year: year!, month: month!, day: day!, hour: hour!, minute: minute! });
  return { start, end: new Date(start.getTime() + args.durationMin * 60_000) };
}

function entriesFor(action: EvalActionRow): number {
  const eventId = deriveCalendarEventId(action.actionId);
  return h.calendar.entries.filter((e) => e.eventId === eventId).length;
}

function hitlUpdates(transcript: TurnMessage[], actionId: string): string[] {
  return transcript
    .filter((m) => m.role === 'user' && m.senderId === 'system:hitl')
    .map((m) => m.content)
    .filter((content) => content.includes(actionId));
}

function toolResultsFor(transcript: TurnMessage[], action: EvalActionRow): TurnMessage[] {
  return transcript.filter((m) => m.role === 'tool' && m.toolUseId === action.toolCall.id);
}

/** Run the scenario's opening message and assert it parked one pending action. */
async function park(s: EvalScenario): Promise<{ conv: string; action: EvalActionRow }> {
  const conv = h.conversationIdFor(s);
  const result = await h.runTurn(conv, s.messages[0]!);
  expect(result.status, 'the proposal turn must park').toBe('parked');
  const actions = await h.actionsFor(conv);
  expect(actions).toHaveLength(1);
  const action = actions[0]!;
  expect(action.status).toBe('pending');
  expect(action.toolCall.name).toBe('create_calendar_event');
  // Nothing executes at propose time, and the prompt got stamped.
  expect(entriesFor(action)).toBe(0);
  expect(action.promptMessageId).not.toBeNull();
  return { conv, action };
}

describe('decision-9 scenarios (M5 gate)', () => {
  it('approve-after-delay: quoted yes executes exactly once, outcome enters as a new context message', async () => {
    const s = scenario('approve-after-delay');
    const { conv, action } = await park(s);

    const result = await h.runTurn(conv, s.messages[1]!);
    expect(result.status).toBe('completed');

    const [after] = await h.actionsFor(conv);
    expect(after!.status).toBe('executed');
    expect(entriesFor(after!)).toBe(1);

    const transcript = await h.transcript(conv);
    // The real outcome is a NEW context message — the parked tool_use was
    // answered once at park time and stays answered (decision 10).
    const updates = hitlUpdates(transcript, action.actionId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`approved by ${s.messages[1]!.senderId}`);
    expect(toolResultsFor(transcript, action)).toHaveLength(1);
  }, 300_000);

  it('deny: a non-quoted Hebrew no settles the action as denied with zero effects', async () => {
    const s = scenario('deny');
    const { conv, action } = await park(s);

    const result = await h.runTurn(conv, s.messages[1]!);
    expect(result.status).toBe('completed');

    const [after] = await h.actionsFor(conv);
    expect(after!.status).toBe('denied');
    expect(entriesFor(after!)).toBe(0);

    const transcript = await h.transcript(conv);
    const updates = hitlUpdates(transcript, action.actionId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`declined by ${s.messages[1]!.senderId}`);
    expect(toolResultsFor(transcript, action)).toHaveLength(1);
  }, 300_000);

  it('abandon-by-unrelated-message: the action stays pending, untouched — never silently auto-denied', async () => {
    const s = scenario('abandon-by-unrelated-message');
    const { conv, action } = await park(s);

    const result = await h.runTurn(conv, s.messages[1]!);
    expect(result.status).toBe('completed'); // the unrelated question got a normal turn

    const [after] = await h.actionsFor(conv);
    expect(after!.status).toBe('pending');
    expect(after!.toolCall).toEqual(action.toolCall);
    expect(entriesFor(after!)).toBe(0);
    // No settle/refine outcome may have entered the transcript for it.
    expect(hitlUpdates(await h.transcript(conv), action.actionId)).toHaveLength(0);
  }, 300_000);

  it('refine-the-pending-action: args swap in place, the re-stamped prompt approves the NEW args', async () => {
    const s = scenario('refine-the-pending-action');
    const { conv, action } = await park(s);
    expect(eventArgs(action).time).toBe('15:00');
    const originalStamp = action.promptMessageId;

    // "actually תזיז את זה ל-16:00" → Haiku refine with just the changed field,
    // merged over the stored args (owner/date kept) by refineAction.
    const refineResult = await h.runTurn(conv, s.messages[1]!);
    expect(refineResult.status, 'a refine closes the turn like a park').toBe('parked');

    const [refined] = await h.actionsFor(conv);
    expect(refined!.status).toBe('pending'); // pre-execution, identity kept
    expect(refined!.actionId).toBe(action.actionId);
    expect(refined!.toolCall.id).toBe(action.toolCall.id);
    expect(eventArgs(refined!).time).toBe('16:00');
    // The driver re-sent the updated proposal through the stamping path.
    expect(refined!.promptMessageId).not.toBeNull();
    expect(refined!.promptMessageId).not.toBe(originalStamp);
    expect(entriesFor(refined!)).toBe(0);

    // Quoted כן against the NEW stamp executes the refined action.
    const approveResult = await h.runTurn(conv, s.messages[2]!);
    expect(approveResult.status).toBe('completed');
    const [after] = await h.actionsFor(conv);
    expect(after!.status).toBe('executed');
    expect(entriesFor(after!)).toBe(1);
    const entry = h.calendar.entries.find((e) => e.eventId === deriveCalendarEventId(after!.actionId));
    // June 22 2026 16:00 Eastern (EDT, UTC-4) → 20:00Z: the refined time
    // anchored correctly through the model's own args.
    expect(entry?.start.toISOString()).toBe('2026-06-22T20:00:00.000Z');
  }, 300_000);

  it('stale-action-at-execution: approval of a conflicted slot revalidates, refuses, and tells the user', async () => {
    const s = scenario('stale-action-at-execution');
    const { conv, action } = await park(s);

    // Manufactured conflict: the slot fills between propose and approve.
    const args = eventArgs(action);
    h.calendar.setBusy(args.owner, windowFor(args));

    const result = await h.runTurn(conv, s.messages[1]!);
    expect(result.status).toBe('completed');

    const [after] = await h.actionsFor(conv);
    expect(after!.status).toBe('stale');
    expect(entriesFor(after!)).toBe(0);

    const updates = hitlUpdates(await h.transcript(conv), action.actionId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('failed its revalidation check');
  }, 300_000);

  it('execute-once under double approval: both spouses answer, exactly one execution', async () => {
    const s = scenario('execute-once-double-approval');
    const { conv, action } = await park(s);

    await h.runTurn(conv, s.messages[1]!);
    await h.runTurn(conv, s.messages[2]!);

    const [after] = await h.actionsFor(conv);
    expect(after!.status).toBe('executed');
    expect(entriesFor(after!)).toBe(1);
    expect(toolResultsFor(await h.transcript(conv), action)).toHaveLength(1);
  }, 300_000);

  it('sender-attribution (T27): the model passes the asking spouse as addedBy/createdBy', async () => {
    const s = scenario('sender-attribution');
    const conv = h.conversationIdFor(s);

    const listTurn = await h.runTurn(conv, s.messages[0]!);
    expect(listTurn.status).toBe('completed');
    const itemRow = await h.db.query(
      `SELECT added_by FROM lists WHERE item ILIKE '%pomegranate%' AND created_at >= $1
       ORDER BY created_at DESC LIMIT 1`,
      [startedAt],
    );
    expect(itemRow.rows, 'the list item must exist').toHaveLength(1);
    expect((itemRow.rows[0] as { added_by: string }).added_by).toBe(s.messages[0]!.senderId);

    const reminderTurn = await h.runTurn(conv, s.messages[1]!);
    expect(reminderTurn.status).toBe('completed');
    const reminderRow = await h.db.query(
      'SELECT created_by, due_at FROM reminders WHERE conversation_id = $1',
      [conv],
    );
    expect(reminderRow.rows, 'the reminder must exist').toHaveLength(1);
    const reminder = reminderRow.rows[0] as { created_by: string; due_at: Date };
    expect(reminder.created_by).toBe(s.messages[1]!.senderId);
    // Eastern wall time, June (EDT, UTC-4): 8am → 12:00Z — tz anchoring at
    // eval level, through the model's own create_reminder args.
    expect(reminder.due_at.toISOString()).toBe('2026-06-25T12:00:00.000Z');
  }, 300_000);
});
