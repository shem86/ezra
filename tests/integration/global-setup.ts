import { Client } from 'pg';
import { databaseNameOf, deriveTestDatabaseUrl } from './helpers/test-database-url.ts';

// Vitest globalSetup (issue #5). Runs ONCE in the vitest host process, before
// any worker — and before any test/fixture child process — reads DATABASE_URL.
// It ensures the dedicated test database exists; vitest.config.ts handles
// pointing every worker at it via `test.env`. Each integration test still
// bootstraps its own schema with runMigrations(), so this only has to create
// the empty database.
//
// process.env.DATABASE_URL here is the APP url (test.env overrides apply to
// workers, not this host process), which is exactly what we want: we connect to
// the app's server to create the sibling `_test` database.
export async function setup(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) return; // unit-only run; integration suite is excluded.

  const testUrl = deriveTestDatabaseUrl(appUrl);
  if (testUrl === appUrl) return; // already a `_test` URL; nothing to create.

  const testDbName = databaseNameOf(testUrl);

  // Connect to the server's maintenance database to issue CREATE DATABASE
  // (you cannot create a database while connected to the one being created).
  const admin = new URL(appUrl);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      testDbName,
    ]);
    if (existing.rowCount === 0) {
      // testDbName is validated as a safe identifier by deriveTestDatabaseUrl;
      // identifiers cannot be parameterized.
      await client.query(`CREATE DATABASE "${testDbName}"`);
    }
  } finally {
    await client.end();
  }
}
