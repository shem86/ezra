// Step helpers (T19): the two primitives every workflow builds on —
// transactional structured-state writes and idempotency keys for external
// effects (SPEC "Hard boundaries", architecture decision 3).

/**
 * Key for an external effect, derived from the workflow's identity so a
 * recovery replay of the same step produces the same key and dedupes at the
 * effect log (e.g. `sent_log`) instead of double-firing.
 */
export function deriveIdempotencyKey(workflowID: string, stepNumber: number): string {
  if (workflowID.length === 0) {
    throw new Error('deriveIdempotencyKey: workflowID must be non-empty');
  }
  if (!Number.isInteger(stepNumber) || stepNumber < 0) {
    throw new Error(`deriveIdempotencyKey: stepNumber must be a non-negative integer, got ${stepNumber}`);
  }
  return `${workflowID}:${stepNumber}`;
}
