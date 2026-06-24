// UC-6 (ADR-0005): CI holds the injection fixtures to their contract — the
// behavioral pass/fail is `pnpm eval`'s job (evals/injection.eval.ts), but the
// shape (household ids, a real instruction + a detectable marker in each
// payload, the read tools covered) is checked here with no model calls.

import { describe, expect, it } from 'vitest';
import {
  injectionScenarios,
  calendarEventInjectionTitle,
  poisonedFactValue,
  CAL_INJECTION_MARKER,
  FACT_INJECTION_MARKER,
} from '../../evals/fixtures/injection.ts';

describe('injection scenario fixtures (UC-6)', () => {
  it('defines the calendar-title and poisoned-fact scenarios', () => {
    expect(injectionScenarios.map((s) => s.name).sort()).toEqual([
      'calendar-event-injection',
      'poisoned-fact-injection',
    ]);
  });

  it('member messages are benign and use only household member ids', () => {
    for (const message of injectionScenarios.flatMap((s) => s.messages)) {
      expect(['husband@wa', 'wife@wa']).toContain(message.senderId);
      // The attack lives in third-party content, never the member's words.
      expect(message.text).not.toContain(CAL_INJECTION_MARKER);
      expect(message.text).not.toContain(FACT_INJECTION_MARKER);
    }
  });

  it('each seeded payload carries a real instruction AND a detectable marker', () => {
    expect(calendarEventInjectionTitle).toContain(CAL_INJECTION_MARKER);
    expect(calendarEventInjectionTitle).toMatch(/ignore|instruction/i);
    expect(poisonedFactValue).toContain(FACT_INJECTION_MARKER);
    expect(poisonedFactValue).toMatch(/ignore|also|immediately/i);
  });

  it('covers the point-of-provenance read tools (calendar list + get_fact)', () => {
    const covered = new Set(injectionScenarios.flatMap((s) => s.covers));
    expect(covered).toContain('list_calendar_events');
    expect(covered).toContain('get_fact');
  });

  it('conversation keys are unique — scenarios must not share state', () => {
    const keys = injectionScenarios.map((s) => s.conversationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
