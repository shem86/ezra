// Shape guard for the compaction eval fixtures (no model calls — CI-safe; the
// quality scoring itself is pnpm eval only). Locks the invariants the scorer
// relies on: unique names, non-trivial heads, planted ground truth present, and
// declared languages actually appearing in the head so the language-preservation
// check is meaningful.
import { describe, expect, it } from 'vitest';
import {
  compactionScenarios,
  evalCompactionConfig,
} from '../../evals/fixtures/compaction.ts';
import { compactionSenderId } from '../../src/agent/compaction.ts';

const HEBREW = /[֐-׿]/;
const LATIN = /[A-Za-z]/;

describe('compaction eval fixtures', () => {
  it('has a meaningful spread of scenarios with unique names', () => {
    expect(compactionScenarios.length).toBeGreaterThanOrEqual(8);
    const names = compactionScenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every scenario has a head over threshold and at least one planted commitment', () => {
    for (const s of compactionScenarios) {
      expect(s.head.length, s.name).toBeGreaterThan(evalCompactionConfig.thresholdMessages);
      expect(s.mustPreserve.length, s.name).toBeGreaterThan(0);
      expect(s.mustPreserve.every((c) => c.trim().length > 0), s.name).toBe(true);
    }
  });

  it('declared languages actually appear in the head (so the no-translate check bites)', () => {
    for (const s of compactionScenarios) {
      const text = s.head.map((m) => m.content).join('\n');
      if (s.languages.includes('he')) expect(HEBREW.test(text), `${s.name} he`).toBe(true);
      if (s.languages.includes('en')) expect(LATIN.test(text), `${s.name} en`).toBe(true);
    }
  });

  it('the fold-in scenario opens with a prior compaction summary', () => {
    const foldIn = compactionScenarios.filter((s) => s.foldIn !== undefined);
    expect(foldIn.length).toBeGreaterThanOrEqual(1);
    for (const s of foldIn) {
      expect(s.head[0]?.role, s.name).toBe('user');
      expect((s.head[0] as { senderId?: string }).senderId, s.name).toBe(compactionSenderId);
    }
  });
});
