// Household-fact tools (T27). Autonomous: upsert-able internal rows. Facts
// are plain conversational data — credentials never flow through tools (the
// operational-secret boundary lives in src/ops/config.ts and deps wiring).

import { z } from 'zod';
import { defineTool } from './define-tool.js';
import type { HouseholdToolDeps } from './deps.js';
import {
  getFact,
  listFactKeys,
  searchFacts,
  upsertFact,
  type HouseholdFact,
} from '../memory/store.js';
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

/** The words of a key or query, in normalized form — the unit of matching. */
export function factTerms(raw: string): string[] {
  return [...new Set(normalizeFactKey(raw).split('-'))].filter((t) => t.length > 0);
}

const SEARCH_CANDIDATES = 50;
const SEARCH_RESULTS = 5;
const CATALOG_KEYS = 50;

/** Key hits outweigh value hits; ties keep the store's newest-first order. */
function rankByTerms(facts: readonly HouseholdFact[], terms: readonly string[]): HouseholdFact[] {
  const score = (f: HouseholdFact): number => {
    const key = f.key.toLowerCase();
    const value = f.value.toLowerCase();
    return terms.reduce((n, t) => n + (key.includes(t) ? 2 : 0) + (value.includes(t) ? 1 : 0), 0);
  };
  return facts
    .map((fact, i) => ({ fact, i, s: score(fact) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.fact);
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
  key: z
    .string()
    .min(1)
    .describe("The fact's key, or a few words describing it — unmatched keys fall back to search"),
});

export const getFactTool = defineTool<HouseholdToolDeps, typeof getFactSchema>({
  name: 'get_fact',
  description:
    'Read a household fact. Tries the exact key, then the closest matches by key and value ' +
    'words; if nothing matches, returns the stored keys so you can retry with a real one.',
  schema: getFactSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    // Stored values were written by a member but are replayed into a later
    // turn — a crafted value could carry an instruction (the memory-poisoning
    // loop). Every value is fenced as data. A single key is the household's
    // own lookup handle and stays as framing; the bulk catalog, which replays
    // many stored strings at once, is fenced too.
    const fact = await getFact(ctx.db, normalizeFactKey(args.key));
    if (fact !== null) {
      return `${fact.key}: ${fenceUntrusted('stored-fact', fact.value)}`;
    }
    const terms = factTerms(args.key);
    const candidates = await searchFacts(ctx.db, { terms, limit: SEARCH_CANDIDATES });
    const matches = rankByTerms(candidates, terms).slice(0, SEARCH_RESULTS);
    if (matches.length > 0) {
      const lines = matches.map((f) => `${f.key}: ${fenceUntrusted('stored-fact', f.value)}`);
      return `no fact stored under ${args.key}; closest matches:\n${lines.join('\n')}`;
    }
    const keys = await listFactKeys(ctx.db, CATALOG_KEYS);
    if (keys.length === 0) {
      return `no fact stored for ${args.key} (no facts are stored yet)`;
    }
    return (
      `no fact matched ${args.key}. Stored fact keys (retry get_fact with one exactly):\n` +
      fenceUntrusted('stored-fact', keys.join('\n'))
    );
  },
});
