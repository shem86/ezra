import { defineConfig } from 'vitest/config';
import { deriveTestDatabaseUrl } from './tests/integration/helpers/test-database-url.ts';

// Integration tests need the dev Postgres (docker compose); skip the whole
// suite when no DATABASE_URL is configured so unit tests stay runnable anywhere.
const appDatabaseUrl = process.env.DATABASE_URL;
const hasDb = Boolean(appDatabaseUrl);

// Issue #5: never let the integration suite write into the database the app
// reads. We redirect it to a dedicated `_test` database on the SAME server —
// preserving the locked single-Postgres co-location within the test
// environment — by overriding DATABASE_URL for every worker (and the fixture
// child processes they spawn with `env: process.env`). global-setup.ts creates
// that database before the suite runs.
const testDatabaseUrl = appDatabaseUrl ? deriveTestDatabaseUrl(appDatabaseUrl) : undefined;

export default defineConfig({
  test: {
    environment: 'node',
    // DBOS recovery only claims pending workflows of the same application
    // version (an MD5 of workflow source by default). The vitest-transformed
    // parent and the node-run child of the kill/recover spike would hash
    // differently, so pin one version for the whole test process tree.
    // DBOS reads this at SDK import time, hence env-level, not in-test.
    env: {
      DBOS__APPVERSION: 'hh-spike-v1',
      // Workers and their fixture children see the test database, never the
      // app's. Omitted on unit-only runs so nothing else changes there.
      ...(testDatabaseUrl ? { DATABASE_URL: testDatabaseUrl } : {}),
    },
    globalSetup: hasDb ? ['./tests/integration/global-setup.ts'] : [],
    include: [
      'tests/unit/**/*.test.ts',
      'eslint-rules/**/*.test.ts',
      ...(hasDb ? ['tests/integration/**/*.test.ts'] : []),
    ],
  },
});
