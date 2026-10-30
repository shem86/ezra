// `pnpm eval:route`, part 2 — per-tier end-to-end (docs/specs/jev-turn-routing-plan.md §8a).
// The production prompt and pnpm eval's 8/8 were proven on Sonnet only. This
// forces every turn onto the fast (Haiku) and deep (Opus) tier models through
// the real routeTurn seam and asserts the household's autonomous EFFECTS —
// the risk §7b names: lists, reminders, and facts execute without approval,
// so a tier that misreads them does real damage. Assertions are on STATE
// (rows), never wording. REAL model calls — costs money; never CI.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeEvalHarness, type EvalHarness } from './harness/runner.ts';
import type { EvalScenario } from './fixtures/decision9.ts';
import type { Tier } from '../src/agent/turn-route.ts';
import type { TurnMessage } from '../src/agent/context.ts';

let h: EvalHarness;
let currentTier: Tier = 'standard';
const tag = `ev${(Date.now() % 1_000_000).toString(36)}`;

beforeAll(async () => {
  h = await composeEvalHarness({ forceTier: () => currentTier });
}, 120_000);

afterAll(async () => {
  await h.shutdown();
});

function conversation(key: string): string {
  const scenario: EvalScenario = { name: key, conversationKey: key, messages: [], covers: [] };
  return h.conversationIdFor(scenario);
}

/** The tool path the model took, for failure messages. */
function toolTrail(transcript: TurnMessage[]): string {
  return transcript
    .flatMap((m) => (m.role === 'assistant' ? m.toolCalls : []))
    .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
    .join(' → ');
}

describe.each(['fast', 'deep'] as const)('tier %s — autonomous effects under the production prompt', (tier) => {
  beforeAll(() => {
    currentTier = tier;
  });

  it('adds the asked items to the shopping list (code-switched)', async () => {
    const conv = conversation(`tier-${tier}-list`);
    const item = `Quinoa-${tag}-${tier}`;
    await h.runTurn(conv, { senderId: 'wife@wa', text: `תוסיף "${item}" לרשימת הקניות` });

    const res = await h.db.query('SELECT list, item FROM lists WHERE item ILIKE $1', [`%${item}%`]);
    expect(res.rows, toolTrail(await h.transcript(conv))).toHaveLength(1);
  });

  it('sets a reminder at the right Eastern wall time', async () => {
    const conv = conversation(`tier-${tier}-reminder`);
    const body = `water-plants-${tag}-${tier}`;
    await h.runTurn(conv, {
      senderId: 'husband@wa',
      text: `remind me tomorrow at 7am to ${body}`,
    });

    const res = await h.db.query(
      `SELECT body,
              to_char(due_at AT TIME ZONE 'America/New_York', 'HH24:MI') AS wall,
              (due_at AT TIME ZONE 'America/New_York')::date
                = (now() AT TIME ZONE 'America/New_York')::date + 1 AS tomorrow
         FROM reminders WHERE conversation_id = $1 AND status = 'scheduled'`,
      [conv],
    );
    const trail = toolTrail(await h.transcript(conv));
    expect(res.rows, trail).toHaveLength(1);
    expect(res.rows[0], trail).toMatchObject({ wall: '07:00', tomorrow: true });
    expect((res.rows[0] as { body: string }).body, trail).toContain(tag);
  });

  it('saves a household fact with its exact value (Hebrew)', async () => {
    const conv = conversation(`tier-${tier}-fact`);
    const value = `Cabin-${tag}-${tier}`;
    // household_facts is shared: the other tier's save and earlier runs leave
    // a "cabin wifi" fact behind, and the near-duplicate guard then rightly
    // makes the model ASK which one to update (STATUS item 13) — nothing is
    // saved. Clear only this eval's own rows (values carrying its `Cabin-ev…`
    // tags) so each tier starts from a household with no cabin wifi fact.
    await h.db.query(`DELETE FROM household_facts WHERE value LIKE '%Cabin-ev%'`);
    await h.runTurn(conv, {
      senderId: 'wife@wa',
      text: `תשמור שהסיסמה של הוויפי בצימר היא ${value}`,
    });

    const res = await h.db.query('SELECT key, value FROM household_facts WHERE value = $1', [value]);
    expect(res.rows, toolTrail(await h.transcript(conv))).toHaveLength(1);
  });
});
