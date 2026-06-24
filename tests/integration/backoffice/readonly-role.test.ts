// BO-17: prove the SELECT-only role the console connects through can READ but
// not WRITE. Applies the 0007 migration on the `_test` DB, sets a local password
// on the role (the real password is set out-of-band from SSM on prod), connects
// AS hh_readonly, and asserts SELECT works while INSERT/UPDATE/DELETE are denied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../../src/memory/migrate.ts';
import { queryTable } from '../../../src/backoffice/queries.ts';

const appUrl = process.env.DATABASE_URL!;
const RO_PASSWORD = 'ro-test-password';
let admin: Client;
let ro: Client;

function readonlyUrl(): string {
  const u = new URL(appUrl);
  u.username = 'hh_readonly';
  u.password = RO_PASSWORD;
  return u.toString();
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: appUrl });
  admin = new Client({ connectionString: appUrl });
  await admin.connect();
  // Give the role a password locally so we can connect (prod sets it from SSM).
  await admin.query(`ALTER ROLE hh_readonly LOGIN PASSWORD '${RO_PASSWORD}'`);
  // Seed one row to read.
  await admin.query(`INSERT INTO lists (list, item, added_by) VALUES ('ro-test', 'milk', 'Amir')`);

  ro = new Client({ connectionString: readonlyUrl() });
  await ro.connect();
});

afterAll(async () => {
  await ro?.end();
  await admin?.end();
});

describe('hh_readonly role', () => {
  it('can SELECT through the query layer', async () => {
    const listing = await queryTable(
      { query: (sql, params) => ro.query(sql, params as unknown[]) },
      'lists',
      { limit: 50 },
    );
    expect(listing.rows.some((r) => r['list'] === 'ro-test')).toBe(true);
  });

  it('can read the dbos journal schema', async () => {
    // USAGE on dbos + SELECT — the Logs screen depends on this.
    const res = await ro.query('SELECT count(*) FROM dbos.workflow_status');
    expect(Number((res.rows[0] as { count: string }).count)).toBeGreaterThanOrEqual(0);
  });

  it('CANNOT INSERT (write is denied at the role level)', async () => {
    await expect(
      ro.query(`INSERT INTO lists (list, item, added_by) VALUES ('x', 'y', 'z')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('CANNOT UPDATE or DELETE', async () => {
    await expect(ro.query(`UPDATE lists SET item = 'z'`)).rejects.toThrow(/permission denied/i);
    await expect(ro.query(`DELETE FROM lists`)).rejects.toThrow(/permission denied/i);
  });
});
