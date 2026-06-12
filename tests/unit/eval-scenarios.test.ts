// T38: structure checks for the decision-9 scenario scripts — CI holds the
// fixture set to its contract (the five SPEC scenarios present, household
// sender ids per the T32 lesson, code-switched Hebrew/English coverage per
// SPEC assumption 1). Whether the scenarios PASS is `pnpm eval`'s job.

import { describe, expect, it } from 'vitest';
import { evalScenarios } from '../../evals/fixtures/decision9.ts';

const hebrew = /[֐-׿]/;
const english = /[a-zA-Z]/;

const allMessages = evalScenarios.flatMap((s) => s.messages);

describe('decision-9 scenario fixtures', () => {
  it('covers the five SPEC scenarios plus double-approval and sender-attribution', () => {
    expect(evalScenarios.map((s) => s.name).sort()).toEqual(
      [
        'approve-after-delay',
        'deny',
        'abandon-by-unrelated-message',
        'refine-the-pending-action',
        'stale-action-at-execution',
        'execute-once-double-approval',
        'sender-attribution',
      ].sort(),
    );
  });

  it('uses only unambiguous household member ids (the T32 builder@wa lesson)', () => {
    for (const message of allMessages) {
      expect(['husband@wa', 'wife@wa']).toContain(message.senderId);
    }
  });

  it('both spouses speak — either-spouse approval is the locked policy', () => {
    const senders = new Set(allMessages.map((m) => m.senderId));
    expect(senders).toEqual(new Set(['husband@wa', 'wife@wa']));
  });

  it('covers Hebrew-only, English-only, and code-switched messages (SPEC assumption 1)', () => {
    const texts = allMessages.map((m) => m.text);
    expect(texts.some((t) => hebrew.test(t) && !english.test(t))).toBe(true);
    expect(texts.some((t) => english.test(t) && !hebrew.test(t))).toBe(true);
    expect(texts.some((t) => hebrew.test(t) && english.test(t))).toBe(true);
  });

  it('every approval scenario exercises propose_event; sender-attribution exercises the T27 args', () => {
    for (const scenario of evalScenarios) {
      if (scenario.name === 'sender-attribution') {
        expect(scenario.covers).toEqual(
          expect.arrayContaining(['add_list_item', 'create_reminder']),
        );
      } else {
        expect(scenario.covers).toContain('propose_event');
      }
    }
  });

  it('quoted replies only appear after a turn that can have parked', () => {
    for (const scenario of evalScenarios) {
      scenario.messages.forEach((message, i) => {
        if (message.quotesPrompt === true) expect(i).toBeGreaterThan(0);
      });
    }
  });

  it('conversation keys are unique — scenarios must not share state', () => {
    const keys = evalScenarios.map((s) => s.conversationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
