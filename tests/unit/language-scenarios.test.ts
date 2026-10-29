// STATUS item 14 follow-up: CI holds the reply-language eval fixtures to their
// contract — the behavioral pass/fail is `pnpm eval`'s job
// (evals/language.eval.ts), but the shape that makes each scenario MEAN
// something (a run of one language, then a switch) and the language detector
// the assertion rests on are checked here with no model calls.

import { describe, expect, it } from 'vitest';
import { languageScenarios, openingLanguage } from '../../evals/fixtures/language.ts';

const hebrew = /[֐-׿]/;
const latin = /[A-Za-z]/;

describe('reply-language eval fixtures (STATUS item 14)', () => {
  it('each scenario runs in one language, then switches on the final message', () => {
    expect(languageScenarios.map((s) => s.name).sort()).toEqual([
      'switch-en-after-he',
      'switch-he-after-en',
    ]);
    for (const s of languageScenarios) {
      const lead = s.messages.slice(0, -1);
      const last = s.messages.at(-1)!;
      expect(lead.length).toBeGreaterThanOrEqual(2);
      const leadPattern = s.expected === 'en' ? hebrew : latin;
      for (const m of lead) expect(m.text).toMatch(leadPattern);
      // The switching message itself is single-language, so "its language" is unambiguous.
      expect(last.text).toMatch(s.expected === 'en' ? latin : hebrew);
      expect(last.text).not.toMatch(s.expected === 'en' ? hebrew : latin);
    }
  });

  it('the en-after-he scenario ends on the prod wording that drew a Hebrew reply', () => {
    const s = languageScenarios.find((x) => x.name === 'switch-en-after-he')!;
    expect(s.messages.at(-1)!.text).toBe('List all of the facts you have saved');
  });
});

describe('openingLanguage', () => {
  it('reads the 2026-10-29 prod replies: 4.6 opened in English, 5.5 in Hebrew', () => {
    expect(openingLanguage('Here are all 4 stored facts:\n\n1. **husband-birthday** — 10 ביולי 1986')).toBe('en');
    expect(openingLanguage('יש 4 עובדות שמורות:\n\n1. *husband-birthday*: 10 ביולי 1986')).toBe('he');
  });

  it('skips blank lines and judges the first line with letters', () => {
    expect(openingLanguage('\n\n  \n4\nבטח, הנה הקוד')).toBe('he');
  });

  it('a code-switched opening goes to the majority script', () => {
    expect(openingLanguage('The code for הכניסה is below')).toBe('en');
    expect(openingLanguage('הקוד של ה-gym הוא למטה')).toBe('he');
  });

  it('a reply with no letters has no language', () => {
    expect(openingLanguage('1234 ✅')).toBe('none');
  });
});
