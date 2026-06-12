// T38: the eval-only confirm-before tool. The v1 surface is all-autonomous
// (calendar lands at T40), but the decision-9 scenarios are about the
// approval path — so the eval registry carries SPEC's representative tool
// shape against the fake calendar. Schema formats are deliberately strict
// (YYYY-MM-DD, 24h HH:MM): a refine verdict's updated args must be exactly
// checkable, and a model that answers "4pm" fails Zod, not a string match.

import { z } from 'zod';
import { defineTool } from '../../src/tools/define-tool.ts';
import { makeToolRegistry, type ToolRegistry } from '../../src/tools/registry.ts';
import { makeHouseholdToolRegistry } from '../../src/tools/index.ts';
import type { HouseholdToolDeps } from '../../src/tools/deps.ts';
import type { FakeCalendar } from './fake-calendar.ts';

export interface EvalToolDeps extends HouseholdToolDeps {
  readonly calendar: FakeCalendar;
}

const proposeEventSchema = z.object({
  title: z.string().min(1).describe('Event title, in the language the user used'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Event date as YYYY-MM-DD'),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .describe('Event start time as 24-hour HH:MM, household (Eastern) wall time'),
});

export const proposeEventTool = defineTool<EvalToolDeps, typeof proposeEventSchema>({
  name: 'propose_event',
  description:
    'Propose a household calendar event. This only PROPOSES: a household member must approve ' +
    'before anything is created, so never report the event as booked after calling it.',
  schema: proposeEventSchema,
  riskTier: 'confirm-before',
  externalId: (ctx) => `evt-${ctx.actionId}`,
  revalidate: async (args, deps) => deps.calendar.isFree(args.date, args.time),
  execute: async (args, deps, ctx) => {
    const externalId = ctx.externalId ?? `evt-${ctx.actionId}`;
    deps.calendar.create({ externalId, title: args.title, date: args.date, time: args.time });
    return `event created: ${args.title} on ${args.date} at ${args.time} (id ${externalId})`;
  },
});

/** Household v1 surface + propose_event — what every eval scenario runs against. */
export function makeEvalToolRegistry(): ToolRegistry<EvalToolDeps> {
  return makeToolRegistry<EvalToolDeps>([
    ...makeHouseholdToolRegistry().values(),
    proposeEventTool,
  ]);
}
