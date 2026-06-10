// T27 gate: the v1 tool surface exercised through makeToolRegistry +
// makeRunTool against real Postgres, state asserted in the DB — the
// transactional-step boundary is the composer's job (T19), so no DBOS launch
// is needed here; what this suite proves is the SQL, the tz conversion, the
// secret-class read enforcement, and the code-switched round-trips.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/memory/migrate.ts';
import { makeRunTool } from '../../src/tools/registry.ts';
import { makeHouseholdToolRegistry } from '../../src/tools/index.ts';
import type { ToolCall } from '../../src/agent/context.ts';

const connectionString = process.env.DATABASE_URL ?? '';
const runId = `run-${Date.now()}`;
const conv = `tools-${runId}`;
let db: Client;

const runTool = makeRunTool(makeHouseholdToolRegistry(), {
  toolDeps: {},
  park: async () => {
    throw new Error('no household tool is confirm-before; park must be unreachable');
  },
});

let nextId = 0;
function call(name: string, args: unknown): ToolCall {
  nextId += 1;
  return { id: `tu-${runId}-${nextId}`, name, args };
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: connectionString });
  db = new Client({ connectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  await db.end();
});

describe('lists tools', () => {
  const list = `groceries-${runId}`;

  it('add_list_item writes the row and answers with the item and its id', async () => {
    const result = await runTool(db, call('add_list_item', { list, item: 'milk', addedBy: 'shem' }), conv);

    expect(result.parked).toBe(false);
    const rows = await db.query('SELECT * FROM lists WHERE list = $1 AND item = $2', [list, 'milk']);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ added_by: 'shem', done: false });
    expect(result.content).toContain('milk');
    expect(result.content).toContain(rows.rows[0]?.id as string);
  });

  it('round-trips mixed Hebrew/English content intact', async () => {
    await runTool(db, call('add_list_item', { list, item: 'חלב וגבינה for shabbat', addedBy: 'רעות' }), conv);

    const result = await runTool(db, call('get_list', { list }), conv);

    expect(result.content).toContain('חלב וגבינה for shabbat');
  });

  it('get_list shows open items with ids; mark_item_done removes them', async () => {
    const added = await runTool(db, call('add_list_item', { list, item: 'eggs', addedBy: 'shem' }), conv);
    const idMatch = /id ([0-9a-f-]{36})/.exec(added.content);
    expect(idMatch).not.toBeNull();
    const itemId = idMatch![1]!;

    const before = await runTool(db, call('get_list', { list }), conv);
    expect(before.content).toContain('eggs');
    expect(before.content).toContain(itemId);

    const done = await runTool(db, call('mark_item_done', { id: itemId }), conv);
    expect(done.content).toContain('eggs');

    const after = await runTool(db, call('get_list', { list }), conv);
    expect(after.content).not.toContain('eggs');
  });

  it('get_list on an empty list says so instead of returning nothing', async () => {
    const result = await runTool(db, call('get_list', { list: `empty-${runId}` }), conv);

    expect(result.content).toMatch(/empty/i);
  });

  it('mark_item_done on a missing id reports not-found without throwing', async () => {
    const result = await runTool(
      db,
      call('mark_item_done', { id: '00000000-0000-0000-0000-000000000000' }),
      conv,
    );

    expect(result.parked).toBe(false);
    expect(result.content).toMatch(/no .*item|not found/i);
  });

  it('rejects a non-uuid item id as invalid args instead of dying in the DB', async () => {
    const result = await runTool(db, call('mark_item_done', { id: 'the milk one' }), conv);

    expect(result.content).toContain('invalid arguments');
  });
});

describe('household-fact tools', () => {
  it('set_fact then get_fact round-trips a code-switched value', async () => {
    await runTool(db, call('set_fact', { key: `wifi-${runId}`, value: 'הסיסמא היא fios-guest' }), conv);

    const result = await runTool(db, call('get_fact', { key: `wifi-${runId}` }), conv);

    expect(result.content).toContain('הסיסמא היא fios-guest');
  });

  it('set_fact updates an existing key in place', async () => {
    await runTool(db, call('set_fact', { key: `car-${runId}`, value: 'parked on Elm' }), conv);
    await runTool(db, call('set_fact', { key: `car-${runId}`, value: 'parked on Main' }), conv);

    const rows = await db.query('SELECT value FROM household_facts WHERE key = $1', [`car-${runId}`]);
    expect(rows.rows).toEqual([{ value: 'parked on Main' }]);
  });

  it('get_fact on a missing key says so', async () => {
    const result = await runTool(db, call('get_fact', { key: `nope-${runId}` }), conv);

    expect(result.content).toMatch(/no fact/i);
  });

  it('secret-class enforcement: get_fact acknowledges a secret fact but withholds the value', async () => {
    const key = `alarm-code-${runId}`;
    await runTool(db, call('set_fact', { key, value: 'SECRET-9471', isSecret: true }), conv);

    const result = await runTool(db, call('get_fact', { key }), conv);

    // The value must never enter the transcript (SPEC "Never"; the schema
    // comment's "enforcement lives in the read paths" lands exactly here).
    expect(result.content).not.toContain('SECRET-9471');
    expect(result.content).toContain(key);
    expect(result.content).toMatch(/secret/i);
  });

  it('secret-class enforcement: set_fact confirmation never echoes a secret value', async () => {
    const result = await runTool(
      db,
      call('set_fact', { key: `safe-${runId}`, value: 'SECRET-1136', isSecret: true }),
      conv,
    );

    expect(result.content).not.toContain('SECRET-1136');
  });
});
