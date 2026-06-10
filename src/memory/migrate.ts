import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client } from 'pg';

// Forward-only SQL migrations, applied in filename order, each inside its own
// transaction. Schema work happens at setup time, so this deliberately does
// NOT go through a DBOS step — the transactional-step boundary applies to
// runtime structured-state writes, not DDL.

// Resolves to <repo>/migrations from both src/ (vitest) and dist/ (compiled).
const defaultMigrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// Arbitrary constant; serializes concurrent runners (e.g. parallel CI jobs
// sharing a database) on a pg advisory lock.
const migrationLockId = 7_201_811_801;

export interface MigrateOptions {
  readonly databaseUrl: string;
  readonly migrationsDir?: string;
}

/** Applies pending migrations; returns the filenames applied this run. */
export async function runMigrations(options: MigrateOptions): Promise<string[]> {
  const dir = options.migrationsDir ?? defaultMigrationsDir;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const seen = await client.query('SELECT name FROM schema_migrations');
    const alreadyApplied = new Set(seen.rows.map((r: { name: string }) => r.name));

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed`, { cause: err });
      }
      applied.push(file);
    }
  } finally {
    // Lock released implicitly on disconnect.
    await client.end();
  }
  return applied;
}
