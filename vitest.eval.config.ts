import { defineConfig } from 'vitest/config';

// `pnpm eval` (T38): the on-demand model-in-the-loop suite — real Sonnet
// turns, real Haiku classification, dev Postgres. Costs money; NEVER CI
// (testing.md taxonomy 3). Separate config + .eval.ts suffix keep these
// files invisible to `pnpm test`'s globs in both directions. Env comes from
// node's --env-file in the pnpm script — vitest does not read .env itself.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    // One file launches DBOS and both call paid APIs — run them serially.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
