// Phase 1 probe (docs/specs/jev-turn-routing-plan.md §8): do the §3b routing
// questions, over the §4 state, judge synthetic English / Hebrew /
// code-switched turns the way the labels say — and how fast is Jev?
//
// Run: TYPESAFE_API_KEY=… node spikes/jev-turn-route-probe.ts [--split tune|holdout|all] [--model jev-latest]
// Writes every exact payload + raw response to evals/fixtures/turn-route/phase1-results-<split>.json
// so any answer can be re-run. Spike code — env reads and direct I/O are fine here.

import { readFileSync, writeFileSync } from 'node:fs';

type Tier = 'fast' | 'standard' | 'deep';
interface Msg { readonly from: string; readonly text: string }
interface Case {
  readonly id: string;
  readonly lang: 'en' | 'he' | 'mixed';
  readonly tier: Tier;
  readonly recent: readonly Msg[];
  readonly latest: readonly Msg[];
  readonly expect: Record<string, boolean | string | null>;
}

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : dflt;
};
const split = flag('split', 'all');
const model = flag('model', 'jev-latest');
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY not set');

const casesPath = new URL('../evals/fixtures/turn-route/phase1-cases.json', import.meta.url);
const resultsPath = new URL(`../evals/fixtures/turn-route/phase1-results-${split}.json`, import.meta.url);
const all: Case[] = JSON.parse(readFileSync(casesPath, 'utf8')).cases;
const isHoldout = (c: Case): boolean => Number(c.id.split('-')[1]) % 3 === 0;
const cases = all.filter((c) => split === 'all' || (split === 'holdout') === isHoldout(c));

// --- §3b questions — the auditable surface (graduates to src/agent/turn-route.ts) ---
const questions = {
  asks_anything: {
    type: 'noul',
    instructions: 'Does `latest_messages` ask the assistant to do something or to answer something?',
    criteria: {
      true: 'The sender wants an action taken or a question answered, including a short "yes" that accepts an offer the assistant just made.',
      false: 'The sender only thanks, greets, acknowledges, or reacts to what the assistant already did.',
    },
  },
  intent: {
    type: 'choice',
    instructions: 'What is `latest_messages` mainly asking the assistant for?',
    criteria: {
      list_edit: 'Adding, removing, or checking items on a shopping list or to-do list.',
      reminder: 'Creating, moving, or cancelling a reminder at a time.',
      calendar: 'Reading, creating, or changing calendar events, or finding a free time in the calendars.',
      household_fact: 'Looking up or storing a household fact, such as a password, a code, or a phone number.',
      planning_or_advice: 'Planning something, or recommending a choice between options.',
      social: 'Thanks, greetings, acknowledgements, or emoji reactions.',
    },
  },
  several_requests: {
    type: 'noul',
    instructions: 'Does `latest_messages` contain more than one separate request for the assistant?',
    criteria: {
      true: 'The sender asks for two or more different things, for example adding a list item and also setting a reminder.',
      false: 'The sender asks for one thing, even if that one thing names several items, like adding eggs and bread to the same list.',
    },
  },
  refers_back: {
    type: 'noul',
    instructions: 'Does `latest_messages` refer to something in `recent_conversation` that must be looked up to understand what is meant?',
    criteria: {
      true: 'The message only makes sense with the earlier conversation, like "move it to Friday" or a "yes" answering the assistant\'s question.',
      false: 'The message is fully understandable on its own.',
    },
  },
  weighs_options: {
    type: 'noul',
    instructions: 'Does `latest_messages` ask the assistant to compare options, plan around constraints, or recommend something?',
    criteria: {
      true: 'The sender wants a plan made or a recommendation between alternatives, like which day is better or how to organise a weekend.',
      false: 'The sender asks for a specific fact or a specific action, like what time an event is or adding an item.',
    },
  },
  // Variant (tune round 1): v1's "plan around constraints" also caught "find a
  // time we're both free" — a lookup with one answer, which §3c means for
  // standard. The variant asks for judgment between alternatives only, and
  // names the confusing case in the false criterion.
  weighs_options_v2: {
    type: 'noul',
    instructions: 'Does `latest_messages` ask the assistant to make a plan or to recommend one option over others?',
    criteria: {
      true: 'Answering needs a judgment call between alternatives, like which day is better for a visit or how to organise a weekend with guests.',
      false: 'The sender wants one thing looked up or done, like the time of an event, adding an item, or finding a slot when both are free.',
    },
  },
  schedule_reasoning: {
    type: 'noul',
    instructions: 'Does `latest_messages` ask to find a time, check who is available, or work around a clash between schedules?',
    criteria: {
      true: 'Answering needs looking across calendars or availability, like finding when both are free.',
      false: 'The message names its time directly or is not about time, like setting a reminder for tomorrow at 9 or asking when one appointment is.',
    },
  },
  corrects_previous: {
    type: 'noul',
    instructions: "Does `latest_messages` say the assistant's last reply in `recent_conversation` was wrong or misunderstood?",
    criteria: {
      true: 'The sender points out a mistake, like "no, I said Friday" after the assistant set Thursday.',
      false: 'The sender accepts the reply, thanks the assistant, or changes their own plan, like "move it to Friday" after Thursday was set as asked.',
    },
  },
} as const;

const household =
  'Two adults (husband, wife) messaging their home assistant on WhatsApp, in Hebrew, English, or a mix of both.';
const assistantCan =
  'edit shared shopping and to-do lists, set reminders, store and recall household facts, read and propose calendar events';

const renderState = (c: Case) => ({
  household,
  assistant_can: assistantCan,
  recent_conversation: c.recent.length === 0 ? '(none)' : c.recent.map((m) => `${m.from}: ${m.text}`).join('\n'),
  latest_messages: c.latest.map((m) => ({ from: m.from, text: m.text })),
});

// --- §3c truth table ---
const YES = 0.7;
const NO = 0.3;
type Answers = Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number> }>;
const yes = (a: Answers, k: string): boolean => (a[k]?.noul ?? 0.5) > YES;
const no = (a: Answers, k: string): boolean => (a[k]?.noul ?? 0.5) < NO;
const weighsKey = flag('weighs', 'weighs_options');
// Variants score against the label of the question they replace.
const labelKey = (q: string): string => q.replace(/_v\d+$/, '');
function decideTier(a: Answers): Tier {
  if (yes(a, weighsKey) || (yes(a, 'schedule_reasoning') && yes(a, 'several_requests'))) return 'deep';
  if (no(a, 'asks_anything') && a.intent?.choice === 'social') return 'fast';
  const intent = a.intent?.choice;
  if (
    (intent === 'list_edit' || intent === 'social') &&
    no(a, 'several_requests') &&
    no(a, 'refers_back') &&
    no(a, 'schedule_reasoning')
  )
    return 'fast';
  return 'standard';
}

// --- run ---
interface Row {
  id: string; lang: string; holdout: boolean; label: Tier; routed: Tier; ms: number;
  model: string; inputTokens: number; answers: Answers; payload: unknown;
}
const rows: Row[] = [];
for (const c of cases) {
  const payload = { model, state: renderState(c), questions };
  const t0 = performance.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json();
  if (!res.ok) {
    console.error(c.id, res.status, JSON.stringify(body).slice(0, 400));
    process.exit(1);
  }
  const answers = body.answers as Answers;
  rows.push({
    id: c.id, lang: c.lang, holdout: isHoldout(c), label: c.tier, routed: decideTier(answers), ms,
    model: body.model, inputTokens: body.usage?.input_tokens ?? 0, answers, payload,
  });
  process.stdout.write('.');
}
process.stdout.write('\n');

// --- report ---
const fmt = (p: number | undefined): string => (p === undefined ? '  -  ' : p.toFixed(2));
const byId = new Map(all.map((c) => [c.id, c]));
const qNames = Object.keys(questions);
const agree: Record<string, Record<string, { ok: number; unsettled: number; n: number }>> = {};
const misses: string[] = [];
for (const r of rows) {
  const c = byId.get(r.id)!;
  for (const q of qNames) {
    const want = c.expect[labelKey(q)];
    if (want === null || want === undefined) continue;
    const slot = ((agree[q] ??= {})[r.lang] ??= { ok: 0, unsettled: 0, n: 0 });
    slot.n++;
    const a = r.answers[q]!;
    if (q === 'intent') {
      if (a.choice === want) slot.ok++;
      else misses.push(`${r.id} intent: got ${a.choice} (${fmt(a.probabilities?.[a.choice!])}) want ${String(want)}`);
    } else {
      const p = a.noul!;
      const ok = want ? p > YES : p < NO;
      if (ok) slot.ok++;
      else if (p >= NO && p <= YES) { slot.unsettled++; misses.push(`${r.id} ${q}: ${fmt(p)} UNSETTLED want ${String(want)}`); }
      else misses.push(`${r.id} ${q}: ${fmt(p)} WRONG want ${String(want)}`);
    }
  }
}

console.log(`\nmodel answered: ${[...new Set(rows.map((r) => r.model))].join(', ')} · split=${split} · n=${rows.length} · deep reads ${weighsKey}`);
console.log('\nPer-question agreement (ok/n, unsettled in brackets):');
console.log('question            ' + ['en', 'he', 'mixed'].map((l) => l.padEnd(12)).join(''));
for (const q of qNames) {
  const cells = ['en', 'he', 'mixed'].map((l) => {
    const s = agree[q]?.[l];
    return (s ? `${s.ok}/${s.n}${s.unsettled ? ` [${s.unsettled}]` : ''}` : '-').padEnd(12);
  });
  console.log(q.padEnd(20) + cells.join(''));
}

console.log('\nTier confusion (label → routed), per language:');
for (const lang of ['en', 'he', 'mixed']) {
  const rs = rows.filter((r) => r.lang === lang);
  const exact = rs.filter((r) => r.label === r.routed).length;
  const dangerous = rs.filter((r) => r.routed === 'fast' && r.label !== 'fast');
  const stage1 = rs.filter((r) => (r.label === 'fast' ? 'standard' : r.label) === (r.routed === 'fast' ? 'standard' : r.routed)).length;
  console.log(
    `${lang.padEnd(6)} exact ${exact}/${rs.length} · stage-1 (no fast) ${stage1}/${rs.length} · fast-on-harder ${dangerous.length}` +
      (dangerous.length ? ` (${dangerous.map((r) => r.id).join(', ')})` : ''),
  );
}
const off = rows.filter((r) => r.label !== r.routed).map((r) => `${r.id}${r.holdout ? '*' : ''} ${r.label}→${r.routed}`);
console.log(`tier misses (* = holdout): ${off.length ? off.join(' · ') : 'none'}`);

const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p: number): number => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]!;
const tokens = rows.reduce((s, r) => s + r.inputTokens, 0);
console.log(`\nlatency ms: p50 ${pct(50)} · p95 ${pct(95)} · max ${lat.at(-1)}`);
console.log(`input tokens: ${tokens} total, ${Math.round(tokens / rows.length)}/request → $${((tokens * 0.042) / 1e6).toFixed(5)} this run`);
console.log(`\nquestion-level misses (${misses.length}):\n  ${misses.join('\n  ')}`);

writeFileSync(resultsPath, JSON.stringify({ ranAt: new Date().toISOString(), split, model, rows }, null, 2) + '\n');
console.log(`\nwrote ${resultsPath.pathname}`);
