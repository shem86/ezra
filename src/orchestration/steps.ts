// Step helpers (T19): the two primitives every workflow builds on —
// transactional structured-state writes and idempotency keys for external
// effects (SPEC "Hard boundaries", architecture decision 3).

import type { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import type { Queryable } from '../memory/store.js';

/**
 * The one sanctioned way to perform a structured-state write from a
 * workflow. Wraps a store accessor (anything taking a `Queryable`) in a
 * DBOS datasource transaction, so the app write and the step checkpoint
 * commit in one Postgres transaction — that co-commit is the exactly-once
 * guarantee; a plain step or raw query would not have it.
 *
 * Register at module load with the same `name` in every process that may
 * recover the workflow; call only from inside a workflow.
 */
export function registerTransactionalStep<TArgs extends unknown[], TResult>(
  dataSource: NodePostgresDataSource,
  name: string,
  write: (db: Queryable, ...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return dataSource.registerTransaction(
    // `dataSource.client` resolves to the transaction-scoped client and is
    // only readable inside the transaction — read it at call time, not here.
    async (...args: TArgs): Promise<TResult> => write(dataSource.client, ...args),
    { name },
  );
}

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
