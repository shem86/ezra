import { loadDatabaseUrl } from '../ops/config.js';
import { runMigrations } from './migrate.js';

// Dev entry point for `pnpm migrate` (runs from dist; CI applies migrations
// through the integration suite instead).
const applied = await runMigrations({ databaseUrl: loadDatabaseUrl() });
console.log(
  applied.length === 0 ? 'migrations: up to date' : `migrations applied: ${applied.join(', ')}`,
);
