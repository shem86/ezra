// T36: the relatedness classifier's pure parts — prompt assembly and verdict
// parsing. The model call itself is thin glue (makeClassifyRelatedness, same
// pattern as makeSummarize) and is exercised with a scripted classify in the
// handle-turn integration tests; accuracy on the fixture set is T38's
// report-only job, never CI's.
import { describe, expect, it } from 'vitest';
import {
  classifierSystemPrompt,
  parseClassifierVerdict,
  renderClassifierPrompt,
} from '../../src/agent/relatedness.ts';
import {
  relatednessFixtureAction,
  relatednessFixtures,
} from '../../evals/fixtures/relatedness.ts';

describe('parseClassifierVerdict', () => {
  it('parses each bare-JSON verdict kind', () => {
    expect(parseClassifierVerdict('{"kind":"approve"}')).toEqual({ kind: 'approve' });
    expect(parseClassifierVerdict('{"kind":"deny"}')).toEqual({ kind: 'deny' });
    expect(parseClassifierVerdict('{"kind":"unrelated"}')).toEqual({ kind: 'unrelated' });
    expect(
      parseClassifierVerdict('{"kind":"refine","updatedArgs":{"title":"dentist","time":"16:00"}}'),
    ).toEqual({ kind: 'refine', updatedArgs: { title: 'dentist', time: '16:00' } });
  });

  it('tolerates code fences and surrounding prose', () => {
    expect(parseClassifierVerdict('```json\n{"kind":"approve"}\n```')).toEqual({
      kind: 'approve',
    });
    expect(parseClassifierVerdict('The verdict is: {"kind":"deny"} based on the wording.')).toEqual(
      { kind: 'deny' },
    );
  });

  it('degrades every malformed output to unrelated — never throws, never auto-denies', () => {
    expect(parseClassifierVerdict('')).toEqual({ kind: 'unrelated' });
    expect(parseClassifierVerdict('not json at all')).toEqual({ kind: 'unrelated' });
    expect(parseClassifierVerdict('{"kind":"explode"}')).toEqual({ kind: 'unrelated' });
    expect(parseClassifierVerdict('{"verdict":"approve"}')).toEqual({ kind: 'unrelated' });
    expect(parseClassifierVerdict('{broken json')).toEqual({ kind: 'unrelated' });
  });

  it('a refine without an updatedArgs object degrades to unrelated', () => {
    expect(parseClassifierVerdict('{"kind":"refine"}')).toEqual({ kind: 'unrelated' });
    expect(parseClassifierVerdict('{"kind":"refine","updatedArgs":"4pm"}')).toEqual({
      kind: 'unrelated',
    });
  });
});

describe('renderClassifierPrompt', () => {
  const input = {
    senderId: 'wife',
    message: 'תזיז את זה ל-4pm',
    action: { toolName: 'propose_event', summary: '{"title":"dentist","time":"15:00"}' },
    recentContext: 'assistant: I proposed a dentist event for 15:00.',
  };

  it('carries the message, sender, pending proposal, and recent context', () => {
    const prompt = renderClassifierPrompt(input);
    expect(prompt).toContain('תזיז את זה ל-4pm');
    expect(prompt).toContain('wife');
    expect(prompt).toContain('propose_event');
    expect(prompt).toContain('{"title":"dentist","time":"15:00"}');
    expect(prompt).toContain('assistant: I proposed a dentist event for 15:00.');
  });

  it('is deterministic for identical input', () => {
    expect(renderClassifierPrompt(input)).toBe(renderClassifierPrompt(input));
  });

  it('the system prompt demands the JSON verdict contract', () => {
    expect(classifierSystemPrompt).toContain('"kind"');
    expect(classifierSystemPrompt).toContain('updatedArgs');
  });
});

describe('relatedness fixture set (consumed by the T38 accuracy report)', () => {
  const classes = ['approve', 'deny', 'refine', 'unrelated'] as const;
  const hebrew = /[֐-׿]/;
  const english = /[a-zA-Z]/;

  it.each(classes)('covers %s in Hebrew, English, and code-switched messages', (expected) => {
    const ofClass = relatednessFixtures.filter((f) => f.expected === expected);
    expect(ofClass.length).toBeGreaterThanOrEqual(3);
    expect(ofClass.some((f) => hebrew.test(f.message) && !english.test(f.message))).toBe(true);
    expect(ofClass.some((f) => english.test(f.message) && !hebrew.test(f.message))).toBe(true);
    expect(ofClass.some((f) => hebrew.test(f.message) && english.test(f.message))).toBe(true);
  });

  it('the fixture action is the digest shape the classifier sees at runtime', () => {
    expect(relatednessFixtureAction.toolName).toBeTruthy();
    expect(() => JSON.parse(relatednessFixtureAction.summary)).not.toThrow();
  });
});
