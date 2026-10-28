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
}

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
    ],
  };
}
