// Turn routing core (docs/specs/jev-turn-routing-plan.md §3–§4). Jev answers
// narrow judgments about the turn; this module's truth table decides the
// model tier — the decision stays in code, visible and testable, never asked
// of the model.
//
// This file is the auditable surface: every question, criterion, and
// threshold lives here and nowhere else. CHANGING ANY OF IT — or the Jev pin,
// a tier model id (env overrides included), or evals/fixtures/turn-route —
// means running `pnpm eval:route` and putting the result in the PR
// (.claude/rules/testing.md, "Routing evals" — both land in plan Phase 4;
// until then, spikes/jev-turn-route-probe.ts is the live check). The wording below is the one
// Phase 1 measured (docs/spike-results.md); unit tests replay its recorded
// answers through decideTier.

import { createHash } from 'node:crypto';
import type { JevAnswer, JevQuestions } from './jev-client.js';

export type Tier = 'fast' | 'standard' | 'deep';

export const turnRouteQuestions = {
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
      calendar:
        'Reading, creating, or changing calendar events, or finding a free time in the calendars.',
      household_fact:
        'Looking up or storing a household fact, such as a password, a code, or a phone number.',
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
    instructions:
      'Does `latest_messages` refer to something in `recent_conversation` that must be looked up to understand what is meant?',
    criteria: {
      true: 'The message only makes sense with the earlier conversation, like "move it to Friday" or a "yes" answering the assistant\'s question.',
      false: 'The message is fully understandable on its own.',
    },
  },
  // v2 (Phase 1): v1 asked "compare options, plan around constraints, or
  // recommend", and the "plan around constraints" arm pulled "find a time
  // we're both free" — one lookup, §3c standard — to deep.
  weighs_options: {
    type: 'noul',
    instructions:
      'Does `latest_messages` ask the assistant to make a plan or to recommend one option over others?',
    criteria: {
      true: 'Answering needs a judgment call between alternatives, like which day is better for a visit or how to organise a weekend with guests.',
      false: 'The sender wants one thing looked up or done, like the time of an event, adding an item, or finding a slot when both are free.',
    },
  },
  schedule_reasoning: {
    type: 'noul',
    instructions:
      'Does `latest_messages` ask to find a time, check who is available, or work around a clash between schedules?',
    criteria: {
      true: 'Answering needs looking across calendars or availability, like finding when both are free.',
      false: 'The message names its time directly or is not about time, like setting a reminder for tomorrow at 9 or asking when one appointment is.',
    },
  },
  // Monitoring only (§5b correction rate per tier) — decideTier never reads it.
  corrects_previous: {
    type: 'noul',
    instructions:
      "Does `latest_messages` say the assistant's last reply in `recent_conversation` was wrong or misunderstood?",
    criteria: {
      true: 'The sender points out a mistake, like "no, I said Friday" after the assistant set Thursday.',
      false: 'The sender accepts the reply, thanks the assistant, or changes their own plan, like "move it to Friday" after Thursday was set as asked.',
    },
  },
} as const satisfies JevQuestions;

export type RouteIntent = keyof typeof turnRouteQuestions.intent.criteria;

/** Strict bounds: above `yes` reads yes, below `no` reads no, between is unsettled. */
export const routeThresholds = { yes: 0.7, no: 0.3 } as const;

/** Hash of the question set + thresholds — tags traces so a wording change is attributable. */
export const routeQuestionsVersion = createHash('sha256')
  .update(JSON.stringify({ turnRouteQuestions, routeThresholds }))
  .digest('hex')
  .slice(0, 12);

export interface RouteAnswers {
  readonly asksAnything: number;
  readonly intent: RouteIntent;
  readonly severalRequests: number;
  readonly refersBack: number;
  readonly weighsOptions: number;
  readonly scheduleReasoning: number;
  readonly correctsPrevious: number;
}

const yes = (p: number): boolean => p > routeThresholds.yes;
const no = (p: number): boolean => p < routeThresholds.no;

/**
 * The §3c truth table, top-down. Only settled answers can buy a non-default
 * tier; every unsettled band falls through to standard, today's behavior.
 */
export function decideTier(a: RouteAnswers): Tier {
  if (yes(a.weighsOptions) || (yes(a.scheduleReasoning) && yes(a.severalRequests))) return 'deep';
  if (no(a.asksAnything) && a.intent === 'social') return 'fast';
  if (
    (a.intent === 'list_edit' || a.intent === 'social') &&
    no(a.severalRequests) &&
    no(a.refersBack) &&
    no(a.scheduleReasoning)
  ) {
    return 'fast';
  }
  return 'standard';
}

/** Validated-wire answers → RouteAnswers. Throws on a missing or mistyped answer; never defaults one. */
export function toRouteAnswers(wire: Readonly<Record<string, JevAnswer>>): RouteAnswers {
  const noul = (id: string): number => {
    const answer = wire[id];
    if (answer?.type !== 'noul') throw new Error(`turn route: no noul answer for "${id}"`);
    return answer.noul;
  };
  const intent = wire.intent;
  if (intent?.type !== 'choice' || !(intent.choice in turnRouteQuestions.intent.criteria)) {
    throw new Error('turn route: no valid intent answer');
  }
  return {
    asksAnything: noul('asks_anything'),
    intent: intent.choice as RouteIntent,
    severalRequests: noul('several_requests'),
    refersBack: noul('refers_back'),
    weighsOptions: noul('weighs_options'),
    scheduleReasoning: noul('schedule_reasoning'),
    correctsPrevious: noul('corrects_previous'),
  };
}

export interface PreRouteInput {
  readonly hasPendingActions: boolean;
  readonly hasQuotedReply: boolean;
  readonly hasText: boolean;
}

export type PreRouteRule = 'pending-actions' | 'quoted-reply' | 'no-text';

/**
 * §3a: turns code can route without asking Jev. HITL-adjacent turns stay on
 * the model the decision-9 eval proved (standard), and a batch with no text
 * has nothing for Jev to judge.
 */
export function preRouteTier(input: PreRouteInput): { tier: 'standard'; rule: PreRouteRule } | null {
  if (input.hasPendingActions) return { tier: 'standard', rule: 'pending-actions' };
  if (input.hasQuotedReply) return { tier: 'standard', rule: 'quoted-reply' };
  if (!input.hasText) return { tier: 'standard', rule: 'no-text' };
  return null;
}

/** §7b staged rollout: a tier not yet enabled runs as standard. */
export function applyRollout(tier: Tier, enabled: ReadonlySet<Tier>): Tier {
  return enabled.has(tier) ? tier : 'standard';
}

export interface RouteMessage {
  /** Member label (husband/wife) or 'assistant' — never a JID (§4). */
  readonly from: string;
  readonly text: string;
}

const routeRecentMessages = 4;

const household =
  'Two adults (husband, wife) messaging their home assistant on WhatsApp, in Hebrew, English, or a mix of both.';
const assistantCan =
  'edit shared shopping and to-do lists, set reminders, store and recall household facts, read and propose calendar events';

/**
 * The §4 state: only what the questions need. No tool results, no calendar
 * contents — narrower for privacy, and an irrelevant field can sway an answer.
 */
export function renderRouteState(input: {
  readonly recent: readonly RouteMessage[];
  readonly latest: readonly RouteMessage[];
}): {
  readonly household: string;
  readonly assistant_can: string;
  readonly recent_conversation: string;
  readonly latest_messages: ReadonlyArray<{ readonly from: string; readonly text: string }>;
} {
  const recent = input.recent.slice(-routeRecentMessages);
  return {
    household,
    assistant_can: assistantCan,
    // An explicit "(none)": an empty field can read as a signal.
    recent_conversation:
      recent.length === 0 ? '(none)' : recent.map((m) => `${m.from}: ${m.text}`).join('\n'),
    latest_messages: input.latest.map((m) => ({ from: m.from, text: m.text })),
  };
}
