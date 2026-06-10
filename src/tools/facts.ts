// Household-fact tools (T27). Autonomous: upsert-able internal rows. The
// secret-class boundary (SPEC "Never") is enforced HERE, on the read/echo
// paths — a secret value must never enter the tool_result, because the
// tool_result becomes transcript, and transcript reaches prompts and traces.

import { z } from 'zod';
import { defineTool } from './define-tool.js';
import type { HouseholdToolDeps } from './deps.js';
import { getFact, upsertFact } from '../memory/store.js';

const setFactSchema = z.object({
  key: z.string().min(1).describe('Stable fact key, e.g. "wifi-password", "boiler-service-phone"'),
  value: z.string().min(1),
  isSecret: z
    .boolean()
    .default(false)
    .describe('Mark secret-class: stored, but never read back into the conversation'),
});

export const setFactTool = defineTool<HouseholdToolDeps, typeof setFactSchema>({
  name: 'set_fact',
  description: 'Record or update a household fact.',
  schema: setFactSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    await upsertFact(ctx.db, args);
    // No value echo for secrets: the confirmation itself becomes transcript.
    return args.isSecret
      ? `recorded secret-class fact ${args.key} (value withheld)`
      : `recorded fact ${args.key}: ${args.value}`;
  },
});

const getFactSchema = z.object({
  key: z.string().min(1),
});

export const getFactTool = defineTool<HouseholdToolDeps, typeof getFactSchema>({
  name: 'get_fact',
  description: 'Read a household fact by key.',
  schema: getFactSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    const fact = await getFact(ctx.db, args.key);
    if (fact === null) {
      return `no fact stored for ${args.key}`;
    }
    if (fact.isSecret) {
      return `fact ${args.key} exists but is secret-class — its value stays out of the conversation`;
    }
    return `${args.key}: ${fact.value}`;
  },
});
