// Issue #5: the integration suite must never write into the database the app
// reads. We keep the locked single-Postgres co-location (journal + structured
// state + pgvector in ONE database) but use a SEPARATE database *within the
// same server* for tests — derived from the app's DATABASE_URL by suffixing the
// database name with `_test`. This module is the single source of truth for
// that derivation; both vitest.config.ts (to inject the override into every
// worker) and the global setup (to create the database) import it so they can
// never drift.

// Postgres identifiers we generate must be safe to interpolate into a
// `CREATE DATABASE "<name>"` (identifiers cannot be parameterized). The derived
// name is `<appdb>_test`, so this also constrains what app database names we
// accept — anything outside this set is a misconfiguration we want to fail on.
const SAFE_DB_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const TEST_SUFFIX = '_test';

/** The database name embedded in a postgres connection string. */
export function databaseNameOf(connectionString: string): string {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  if (!name) {
    throw new Error(`DATABASE_URL has no database name: ${connectionString}`);
  }
  return name;
}

/**
 * Maps the app's DATABASE_URL to the dedicated test database URL on the same
 * server. Already-`_test` URLs pass through unchanged (idempotent), so running
 * the suite with a test URL already configured is a no-op rather than producing
 * `..._test_test`.
 */
export function deriveTestDatabaseUrl(appConnectionString: string): string {
  const url = new URL(appConnectionString);
  const dbName = databaseNameOf(appConnectionString);
  if (dbName.endsWith(TEST_SUFFIX)) return appConnectionString;

  if (!SAFE_DB_NAME.test(dbName)) {
    throw new Error(`unsupported database name for test isolation: ${dbName}`);
  }
  url.pathname = `/${dbName}${TEST_SUFFIX}`;
  return url.toString();
}
