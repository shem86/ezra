import { describe, expect, it } from 'vitest';
import { deriveIdempotencyKey } from '../../src/orchestration/steps.ts';

describe('deriveIdempotencyKey', () => {
  it('derives a stable key from (workflowID, stepNumber)', () => {
    const first = deriveIdempotencyKey('wf-123', 3);
    const second = deriveIdempotencyKey('wf-123', 3);
    expect(first).toBe(second);
    expect(first).toContain('wf-123');
  });

  it('different step numbers in the same workflow get different keys', () => {
    expect(deriveIdempotencyKey('wf-123', 1)).not.toBe(deriveIdempotencyKey('wf-123', 2));
  });

  it('the same step number in different workflows gets different keys', () => {
    expect(deriveIdempotencyKey('wf-a', 1)).not.toBe(deriveIdempotencyKey('wf-b', 1));
  });

  it('rejects an empty workflowID', () => {
    expect(() => deriveIdempotencyKey('', 1)).toThrow(/workflowID/);
  });

  it('rejects non-integer step numbers', () => {
    expect(() => deriveIdempotencyKey('wf-123', 1.5)).toThrow(/stepNumber/);
    expect(() => deriveIdempotencyKey('wf-123', Number.NaN)).toThrow(/stepNumber/);
  });

  it('rejects negative step numbers', () => {
    expect(() => deriveIdempotencyKey('wf-123', -1)).toThrow(/stepNumber/);
  });
});
