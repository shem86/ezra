// Household-fact tools (T27). Autonomous: upsert-able internal rows. Facts
// are plain conversational data — credentials never flow through tools (the
// operational-secret boundary lives in src/ops/config.ts and deps wiring).

import { z } from 'zod';
import { defineTool } from './define-tool.js';
import type { HouseholdToolDeps } from './deps.js';
import { getFact, upsertFact } from '../memory/store.js';
import { fenceUntrusted } from '../agent/untrusted.js';

/**
 * One canonical spelling per key, so "WiFi Password" and "wifi_password" name
 * the same row — the model invents keys and must not be trusted to reproduce
 * its own spelling weeks later. Unicode-aware: Hebrew keys survive.
 */
export function normalizeFactKey(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : raw.trim().toLowerCase();
}

const setFactSchema = z.object({
  key: z.string().min(1).describe('Stable fact key, e.g. "wifi-network", "boiler-service-phone"'),
  value: z.string().min(1),
});

export const setFactTool = defineTool<HouseholdToolDeps, typeof setFactSchema>({
  name: 'set_fact',
  description: 'Record or update a household fact.',
  schema: setFactSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    const key = normalizeFactKey(args.key);
    await upsertFact(ctx.db, { key, value: args.value });
    return `recorded fact ${key}: ${args.value}`;
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
    const fact = await getFact(ctx.db, normalizeFactKey(args.key));
    if (fact === null) {
      return `no fact stored for ${args.key}`;
    }
    // The value was written by a member but is replayed into a later turn — a
    // crafted value could carry an instruction (the memory-poisoning loop).
    // Fence the value as data; the key is the household's own lookup handle.
    return `${fact.key}: ${fenceUntrusted('stored-fact', fact.value)}`;
  },
});
