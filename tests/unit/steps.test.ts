import { describe, expect, it } from 'vitest';
import type { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { deriveIdempotencyKey, registerTransactionalStep } from '../../src/orchestration/steps.ts';
import type { Queryable } from '../../src/memory/store.ts';

// The real datasource only exposes `client` inside a transaction; this fake
// stands in so we can assert the wiring (write runs against the datasource's
// transaction client, registered under the given name). Durability itself is
// proven against real Postgres in tests/integration/steps.test.ts.
function makeFakeDataSource() {
  const transactionClient: Queryable = {
    query: async () => ({ rows: [] }),
  };
  const registeredNames: (string | undefined)[] = [];
  const fake = {
    client: transactionClient,
    registerTransaction<TResult, TArgs extends unknown[]>(
      fn: (...args: TArgs) => Promise<TResult>,
      config?: { name?: string },
    ): (...args: TArgs) => Promise<TResult> {
      registeredNames.push(config?.name);
      return fn;
    },
  };
  return {
    dataSource: fake as unknown as NodePostgresDataSource,
    transactionClient,
    registeredNames,
  };
}

describe('registerTransactionalStep', () => {
  it('registers the write as a datasource transaction under the given name', () => {
    const { dataSource, registeredNames } = makeFakeDataSource();

    registerTransactionalStep(dataSource, 'addListItem', async (_db: Queryable) => undefined);

    expect(registeredNames).toEqual(['addListItem']);
  });

  it('does not run the write at registration time', () => {
    const { dataSource } = makeFakeDataSource();
    let runs = 0;

    registerTransactionalStep(dataSource, 'countingWrite', async (_db: Queryable) => {
      runs += 1;
    });

    expect(runs).toBe(0);
  });

  it('runs the write against the transaction client, passing args through', async () => {
    const { dataSource, transactionClient } = makeFakeDataSource();
    const seen: { db: Queryable; item: string }[] = [];
    const step = registerTransactionalStep(
      dataSource,
      'recordingWrite',
      async (db: Queryable, item: string) => {
        seen.push({ db, item });
        return `wrote-${item}`;
      },
    );

    const result = await step('milk');

    expect(result).toBe('wrote-milk');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.db).toBe(transactionClient);
    expect(seen[0]?.item).toBe('milk');
  });
});

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
