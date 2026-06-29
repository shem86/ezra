// Pure scorer logic for the compaction eval — CI-safe (no model). Locks the
// mechanical checks and the commitment-fraction aggregation the report depends
// on; the model-in-the-loop scoring itself is pnpm eval only.
import { describe, expect, it } from 'vitest';
import {
  commitmentScore,
  containsLanguage,
  isConcise,
  languagePreserved,
  scoreScenario,
  type JudgeVerdict,
} from '../../evals/harness/compaction-score.ts';

function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    commitments: [],
    faithfulness: { score: 1, inventedClaims: [] },
    boundaryDiscipline: { score: 1, issues: [] },
    languageNotes: '',
    ...over,
  };
}

describe('language detection', () => {
  it('detects Hebrew and Latin script', () => {
    expect(containsLanguage('שלום', 'he')).toBe(true);
    expect(containsLanguage('hello', 'he')).toBe(false);
    expect(containsLanguage('hello', 'en')).toBe(true);
    expect(containsLanguage('שלום', 'en')).toBe(false);
  });
});

describe('languagePreserved', () => {
  it('fails when a head language is missing from the summary (translated away)', () => {
    const headText = 'shem: אני אאסוף את הילדים tomorrow';
    expect(languagePreserved(headText, 'Shem will pick up the kids tomorrow', ['he', 'en'])).toBe(false);
    expect(languagePreserved(headText, 'שם יאסוף the kids מחר', ['he', 'en'])).toBe(true);
  });

  it('does not require a language the head never used', () => {
    expect(languagePreserved('hello world', 'a summary', ['he'])).toBe(true);
  });
});

describe('isConcise', () => {
  it('requires the summary to be shorter than the head', () => {
    expect(isConcise(100, 40)).toBe(true);
    expect(isConcise(40, 100)).toBe(false);
    expect(isConcise(50, 50)).toBe(false);
  });
});

describe('commitmentScore', () => {
  it('is the fraction preserved AND correctly attributed; empty scores 1', () => {
    expect(commitmentScore([])).toBe(1);
    expect(
      commitmentScore([
        { claim: 'a', preserved: true, correctlyAttributed: true, evidence: 'x' },
        { claim: 'b', preserved: true, correctlyAttributed: false, evidence: 'y' },
      ]),
    ).toBe(0.5);
    expect(
      commitmentScore([{ claim: 'a', preserved: false, correctlyAttributed: false, evidence: 'absent' }]),
    ).toBe(0);
  });
});

describe('scoreScenario', () => {
  it('rolls the judge verdict + mechanical checks into one score, listing misses', () => {
    const score = scoreScenario(
      { name: 'demo', languages: ['he', 'en'] },
      'שם יאסוף the kids',
      verdict({
        commitments: [
          { claim: 'pickup', preserved: true, correctlyAttributed: true, evidence: '...' },
          { claim: 'confirm', preserved: false, correctlyAttributed: false, evidence: 'absent' },
        ],
        faithfulness: { score: 0.8, inventedClaims: ['made-up dentist appt'] },
      }),
      'shem: אני אאסוף the kids and reut will confirm', // head text: he + en
    );

    expect(score.commitment).toBe(0.5);
    expect(score.missing).toEqual(['confirm']);
    expect(score.faithfulness).toBe(0.8);
    expect(score.invented).toEqual(['made-up dentist appt']);
    expect(score.languageOk).toBe(true); // summary has both scripts
    expect(score.concise).toBe(true); // summary shorter than head text
  });
});
