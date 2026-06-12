// T34 gate: kill-mid-park replays to exactly one pending_actions row and
// exactly one approval prompt — through the REAL makeRunTool + makePark with
// a fake confirm-before tool. The fixture import MUST stay first: it pins
// this file's DBOS__APPVERSION before the SDK loads.
import {
  launchParkRuntime,
  parkConnectionString,
  parkToolListFor,
  parkTurnWorkflow,
} from './helpers/park-fixture.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import { loadContext } from '../../src/memory/store.ts';
import { parseTurnMessages } from '../../src/agent/context.ts';
import { deriveActionId } from '../../src/tools/registry.ts';

const childEntry = fileURLToPath(new URL('./helpers/park-child.ts', import.meta.url));
const runId = `run-${Date.now()}`;
let db: Client;

async function itemCount(list: string, item: string): Promise<number> {
  const res = await db.query('SELECT count(*)::int AS n FROM lists WHERE list = $1 AND item = $2', [
    list,
    item,
  ]);
  return (res.rows[0] as { n: number }).n;
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: parkConnectionString });
  db = new Client({ connectionString: parkConnectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

describe('kill-mid-park recovery (T34)', () => {
  it('replays to exactly one pending row and one approval prompt, no double effects', async () => {
    const conversationId = `conv-${runId}-parkkill`;
    const wfid = `parkkill-${runId}`;
    const list = parkToolListFor(conversationId);
    const actionId = deriveActionId(conversationId, 'tu-park-1');
    const child = spawn(process.execPath, [childEntry, wfid, conversationId], {
      env: process.env,
      stdio: 'ignore',
    });

    await waitFor(async () => (await itemCount(list, 'before-kill')) >= 1, 30_000);
    child.kill('SIGKILL'); // lands inside slowPark's pre-write sleep
    await waitForExit(child);
    expect(await itemCount(list, 'before-kill')).toBe(1); // not lost
    // Killed mid-park transaction: nothing committed yet.
    const preRecovery = await db.query(
      'SELECT count(*)::int AS n FROM pending_actions WHERE conversation_id = $1',
      [conversationId],
    );
    expect((preRecovery.rows[0] as { n: number }).n).toBe(0);

    await launchParkRuntime();
    // Resume explicitly AFTER launch (datasources ready): the child ran
    // under its own executor ID precisely so launch-time recovery — which
    // races datasource init on 4.19.8 (see dbos.md) — leaves it alone.
    const resumed = await DBOS.resumeWorkflow(wfid);
    const result = await resumed.getResult();

    expect(result).toEqual({ status: 'parked', rounds: 2 });
    expect(await itemCount(list, 'before-kill')).toBe(1); // still exactly once

    // Exactly one row, pending, unstamped (the composer stamps post-send).
    const rows = await db.query('SELECT * FROM pending_actions WHERE conversation_id = $1', [
      conversationId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      action_id: actionId,
      status: 'pending',
      prompt_message_id: null,
    });

    // Exactly one approval prompt closes the transcript.
    const messages = parseTurnMessages(await loadContext(db, conversationId));
    const prompts = messages.filter(
      (m) => m.role === 'assistant' && m.content.includes('Reply to this message'),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0] && 'content' in prompts[0] ? prompts[0].content : '').toContain(actionId);
    expect(messages.at(-1)).toBe(prompts[0]);

    // Every tool_use answered, parks included.
    const useIds = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (m.role === 'assistant' ? m.toolCalls.map((c) => c.id) : []));
    const resultIds = messages
      .filter((m) => m.role === 'tool')
      .map((m) => (m.role === 'tool' ? m.toolUseId : ''));
    expect(resultIds.sort()).toEqual([...useIds].sort());
  }, 90_000);

  it('an uninterrupted run produces the identical outcome (the replay baseline)', async () => {
    const conversationId = `conv-${runId}-parkclean`;
    const handle = await DBOS.startWorkflow(parkTurnWorkflow, {
      workflowID: `parkclean-${runId}`,
    })(conversationId, [{ senderId: 'wife', payload: { text: 'propose the dentist event' } }]);
    const result = await handle.getResult();

    expect(result).toEqual({ status: 'parked', rounds: 2 });
    const rows = await db.query(
      'SELECT count(*)::int AS n FROM pending_actions WHERE conversation_id = $1',
      [conversationId],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  }, 60_000);
});
