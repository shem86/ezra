// T38 eval substrate: the fake calendar and the eval-only propose_event
// confirm-before tool (the v1 surface is all-autonomous until T40 — the
// decision-9 scenarios need SOMETHING to park, and SPEC's representative
// tool snippet is exactly this shape). Deterministic, CI-safe; the
// model-in-the-loop behavior these enable is measured by `pnpm eval`.

import { describe, expect, it } from 'vitest';
import { makeFakeCalendar } from '../../evals/harness/fake-calendar.ts';
import {
  makeEvalToolRegistry,
  proposeEventTool,
  type EvalToolDeps,
} from '../../evals/harness/propose-event.ts';
import { makeHouseholdToolRegistry } from '../../src/tools/index.ts';
import type { Queryable } from '../../src/memory/store.ts';
import type { ToolContext } from '../../src/tools/define-tool.ts';

// propose_event never touches the db — a throwing stub proves it.
const noDb: Queryable = {
  query: async () => {
    throw new Error('propose_event must not touch the database');
  },
};

function ctxFor(actionId: string): ToolContext {
  return {
    actionId,
    conversationId: 'conv-eval-unit',
    toolUseId: 'tu-eval-unit',
    db: noDb,
    externalId: `evt-${actionId}`,
  };
}

function depsWith(calendar: ReturnType<typeof makeFakeCalendar>): EvalToolDeps {
  return {
    calendar,
    embedder: {
      dimension: 0,
      embedQuery: async () => [],
      embedDocuments: async () => [],
    },
  };
}

const validArgs = { title: 'dentist', date: '2026-06-19', time: '15:00' };

describe('fake calendar', () => {
  it('slots start free and setBusy occupies one', () => {
    const calendar = makeFakeCalendar();
    expect(calendar.isFree('2026-06-19', '15:00')).toBe(true);
    calendar.setBusy('2026-06-19', '15:00');
    expect(calendar.isFree('2026-06-19', '15:00')).toBe(false);
    expect(calendar.isFree('2026-06-19', '16:00')).toBe(true);
  });

  it('create is idempotent on externalId — the decision-10 no-op re-execute', () => {
    const calendar = makeFakeCalendar();
    const event = { externalId: 'evt-1', ...validArgs };
    expect(calendar.create(event)).toBe(true);
    expect(calendar.create(event)).toBe(false);
    expect(calendar.entries).toHaveLength(1);
  });

  it('a created event occupies its slot', () => {
    const calendar = makeFakeCalendar();
    calendar.create({ externalId: 'evt-1', ...validArgs });
    expect(calendar.isFree('2026-06-19', '15:00')).toBe(false);
  });
});

describe('propose_event tool', () => {
  it('is confirm-before with a revalidation check (SPEC boundary)', () => {
    expect(proposeEventTool.riskTier).toBe('confirm-before');
    expect(proposeEventTool.revalidate).toBeDefined();
  });

  it('schema pins date to YYYY-MM-DD and time to 24h HH:MM — refine args are checkable', () => {
    expect(proposeEventTool.schema.safeParse(validArgs).success).toBe(true);
    expect(proposeEventTool.schema.safeParse({ ...validArgs, time: '4pm' }).success).toBe(false);
    expect(proposeEventTool.schema.safeParse({ ...validArgs, date: '19/06/2026' }).success).toBe(
      false,
    );
    expect(proposeEventTool.schema.safeParse({ date: '2026-06-19', time: '15:00' }).success).toBe(
      false,
    );
  });

  it('derives a deterministic external id from the action id', () => {
    const ctx = { actionId: 'act-a', conversationId: 'c', toolUseId: 't' };
    expect(proposeEventTool.externalId?.(ctx)).toBe('evt-act-a');
    expect(proposeEventTool.externalId?.(ctx)).toBe('evt-act-a');
  });

  it('revalidate consults the calendar slot', async () => {
    const calendar = makeFakeCalendar();
    const deps = depsWith(calendar);
    expect(await proposeEventTool.revalidate?.(validArgs, deps)).toBe(true);
    calendar.setBusy('2026-06-19', '15:00');
    expect(await proposeEventTool.revalidate?.(validArgs, deps)).toBe(false);
  });

  it('execute creates exactly one event keyed by externalId; re-execute no-ops', async () => {
    const calendar = makeFakeCalendar();
    const deps = depsWith(calendar);
    await proposeEventTool.execute(validArgs, deps, ctxFor('act-a'));
    await proposeEventTool.execute(validArgs, deps, ctxFor('act-a'));
    expect(calendar.entries).toHaveLength(1);
    expect(calendar.entries[0]).toEqual({ externalId: 'evt-act-a', ...validArgs });
  });
});

describe('eval tool registry', () => {
  it('is the household surface plus propose_event — nothing else', () => {
    const evalNames = [...makeEvalToolRegistry().keys()].sort();
    const householdNames = [...makeHouseholdToolRegistry().keys()];
    expect(evalNames).toEqual([...householdNames, 'propose_event'].sort());
  });
});
