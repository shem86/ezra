// Pull-only semantic recall (T28, SPEC locked): the model invokes this when
// it judges it needs history — nothing is auto-attached per turn. The query
// embed is a network call inside the runTool transaction; tolerable because
// the tool is read-only (no locks held) and household-scale.

import { z } from 'zod';
import { defineTool } from './define-tool.js';
import type { HouseholdToolDeps } from './deps.js';
import { searchSemanticMemories } from '../memory/semantic.js';
import { householdTimeZone } from '../orchestration/tz.js';
import { fenceUntrusted } from '../agent/untrusted.js';

const recallSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('What to look for in past conversations, e.g. "מה סיכמנו על הצהרון" or "plumber visit"'),
  limit: z.number().int().min(1).max(10).default(5),
});

/** Memory dates render as household-local days (step context — Intl is fine here). */
function dayLabel(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: householdTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export const recallHistoryTool = defineTool<HouseholdToolDeps, typeof recallSchema>({
  name: 'recall_history',
  description:
    'Search summaries of past conversations. Use when the answer may live in history no longer visible in the current conversation. Results are fuzzy recollections — exact facts (lists, reminders, schedules) come from their own tools instead.',
  schema: recallSchema,
  riskTier: 'autonomous',
  execute: async (args, deps, ctx) => {
    const embedding = await deps.embedder.embedQuery(args.query);
    const memories = await searchSemanticMemories(ctx.db, { embedding, limit: args.limit });
    if (memories.length === 0) {
      return 'no stored memories match that query';
    }
    // Recalled summaries can echo forwarded/pasted untrusted text from past
    // turns — fence the content as data; the [day] label is our own framing.
    return memories
      .map((m) => `[${dayLabel(m.createdAt)}] ${fenceUntrusted('recalled', m.content)}`)
      .join('\n');
  },
});
