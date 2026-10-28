// Fact-key lookup (STATUS item 11): does the REAL model follow the code-owned
// matching paths? The integration suite proves the tools behave; only the
// model can prove it reacts correctly — retries with the exact existing key
// after a near-duplicate refusal instead of forcing `distinct: true`, and
// answers from search results after an exact-key miss.
//
// The eval DB is long-lived and accumulates fact rows across runs, so every
// seeded key carries a run-unique number and every assertion is scoped to
// keys containing it — stale rows can neither satisfy nor fail a run, and
// nothing is ever deleted.
//
// Seeded keys are chosen so the model's natural guess is NOT the stored key:
// the save scenario's stored key is a word-superset of the likely guess (the
// shape the near-duplicate guard catches), and the read scenario's stored key
// ends in a word the question never uses (forcing the search fallback).

import type { EvalScenario } from './decision9.ts';

const HUSBAND = 'husband@wa';
const WIFE = 'wife@wa';

export interface FactScenarioSet {
  readonly scenarios: readonly EvalScenario[];
  /** Save scenario: the stored key, its stale value, the value the member gives. */
  readonly save: { readonly key: string; readonly oldValue: string; readonly newValue: string; readonly tag: string };
  /** Read scenario: the stored key and value the reply must carry. */
  readonly read: { readonly key: string; readonly value: string; readonly tag: string };
  /** List-all scenario (item 13): a fact the conversation never mentions. */
  readonly listAll: { readonly key: string; readonly value: string };
}

/**
 * Item 13 existence scenarios: a member asks whether a fact is known. The
 * pass is a fact-tool call before answering (prod answered one of these from
 * memory with no call) — never the answer's content, which the long-lived
 * eval DB's residue could make right or wrong by luck.
 */
export const FACT_TOOLS = ['get_fact', 'list_facts'] as const;

/** `runNumber` must differ per run; the two scenarios derive distinct tags. */
export function makeFactScenarios(runNumber: number): FactScenarioSet {
  const saveTag = `${runNumber}`;
  const readTag = `${runNumber + 1}`;
  return {
    save: {
      key: `gym-locker-${saveTag}-code`,
      oldValue: '1357',
      newValue: '8642',
      tag: saveTag,
    },
    read: {
      key: `bike-lock-${readTag}-combination`,
      value: `${readTag.slice(-3)}-71`,
      tag: readTag,
    },
    listAll: {
      key: `storage-unit-${runNumber + 2}-code`,
      value: `${runNumber + 2}`.slice(-4),
    },
    scenarios: [
      {
        name: 'fact-dedup-on-save',
        conversationKey: 'fact-dedup',
        messages: [{ senderId: WIFE, text: `save the code for locker ${saveTag}: 8642` }],
        covers: ['set_fact'],
      },
      {
        name: 'fact-search-on-read',
        conversationKey: 'fact-search',
        messages: [{ senderId: HUSBAND, text: `what's the code for bike lock ${readTag}?` }],
        covers: ['get_fact'],
      },
      {
        // The prod wording, verbatim (2026-10-28).
        name: 'fact-list-all',
        conversationKey: 'fact-list-all',
        messages: [{ senderId: HUSBAND, text: 'List all of the facts you have saved' }],
        covers: ['list_facts'],
      },
      {
        name: 'fact-existence-en',
        conversationKey: 'fact-exists-en',
        messages: [{ senderId: WIFE, text: 'do you know when our anniversary is?' }],
        covers: ['get_fact', 'list_facts'],
      },
      {
        // The prod wording, verbatim — answered from memory with no tool call.
        name: 'fact-existence-he',
        conversationKey: 'fact-exists-he',
        messages: [{ senderId: HUSBAND, text: 'אתה יודע מתי היום הולדת שלי?' }],
        covers: ['get_fact', 'list_facts'],
      },
    ],
  };
}
