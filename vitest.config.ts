import { defineConfig } from 'vitest/config';

// Integration tests need the dev Postgres (docker compose); skip the whole
// suite when no DATABASE_URL is configured so unit tests stay runnable anywhere.
const hasDb = Boolean(process.env.DATABASE_URL);

export default defineConfig({
  test: {
    environment: 'node',
    // DBOS recovery only claims pending workflows of the same application
    // version (an MD5 of workflow source by default). The vitest-transformed
    // parent and the node-run child of the kill/recover spike would hash
    // differently, so pin one version for the whole test process tree.
    // DBOS reads this at SDK import time, hence env-level, not in-test.
    env: { DBOS__APPVERSION: 'hh-spike-v1' },
    include: [
      'tests/unit/**/*.test.ts',
      'eslint-rules/**/*.test.ts',
      ...(hasDb ? ['tests/integration/**/*.test.ts'] : []),
    ],
  },
});
