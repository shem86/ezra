// T43 send-class kill gate: prove the two orderings survive a real process
// crash, where the unit fakes can only prove the branch logic.
//
//   at-most-once (log-then-send): claim commits, crash after send, replay
//   (claim taken) skips the send — the wire never sees a duplicate.
//
//   at-least-once (send-then-log): send lands, crash before the log, replay
//   (log absent) re-sends — the duplicate the class accepts so a reminder is
//   never dropped; the log then settles to exactly one row.
//
// The fixture import MUST stay first: it pins DBOS__APPVERSION before the SDK
// loads, and (as a side effect) registers deliverReplyWorkflow in THIS process
// so the resumed workflow can replay here under the same name — the parent
// drives recovery by id, so the workflow handle itself is never named here.
import { launchSendClassRuntime, sendClassConnectionString } from './helpers/send-class-fixture.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';

const runId = `sc-${Date.now()}`;
let db: Client;

/** Spawn the child, wait for its first wire send to appear, SIGKILL mid-send. */
async function killAfterFirstSend(
  workflowId: string,
  sendClass: string,
  key: string,
  conversationId: string,
  text: string,
): Promise<void> {
  const child = spawn(
    'node',
    [
      'tests/integration/helpers/send-class-child.ts',
      workflowId,
      sendClass,
      key,
      conversationId,
      text,
    ],
    { env: { ...process.env }, stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i += 1) {
    if ((await wireSendCount(conversationId)) >= 1) break;
    await delay(100);
  }
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function wireSendCount(conversationId: string): Promise<number> {
  const res = await db.query(
    'SELECT count(*)::int AS n FROM wire_sends WHERE conversation_id = $1',
    [conversationId],
  );
  return (res.rows[0] as { n: number }).n;
}

async function sentLogClass(key: string): Promise<string | null> {
  const res = await db.query('SELECT delivery_class FROM sent_log WHERE idempotency_key = $1', [
    key,
  ]);
  return res.rows[0] ? (res.rows[0] as { delivery_class: string }).delivery_class : null;
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: sendClassConnectionString });
  db = new Client({ connectionString: sendClassConnectionString });
  await db.connect();
  await db.query(
    `CREATE TABLE IF NOT EXISTS wire_sends (
       id bigserial PRIMARY KEY,
       conversation_id text NOT NULL,
       text text NOT NULL,
       sent_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await launchSendClassRuntime();
}, 30_000);

afterAll(async () => {
  await db.end();
  await delay(1500); // dbos.md teardown race grace
  await DBOS.shutdown();
});

describe('send-class durability across a crash (T43)', () => {
  it(
    'at-most-once: replay after a post-send crash never re-sends',
    { timeout: 40_000 },
    async () => {
      const workflowId = `amo-${runId}`;
      const conversationId = `conv-amo-${runId}`;
      const key = `send-amo-${runId}`;

      await killAfterFirstSend(workflowId, 'at-most-once', key, conversationId, 'ok, done');
      // Log-then-send: the claim committed before the send we observed.
      expect(await sentLogClass(key)).toBe('at-most-once');
      expect(await wireSendCount(conversationId)).toBe(1);

      await DBOS.resumeWorkflow(workflowId);
      expect(await DBOS.retrieveWorkflow(workflowId).getResult()).toBe(`delivered-${key}`);

      // The claim gated the replay — still exactly one send on the wire.
      expect(await wireSendCount(conversationId)).toBe(1);
    },
  );

  it(
    'at-least-once: replay after a pre-log crash re-sends, then settles to one log row',
    { timeout: 40_000 },
    async () => {
      const workflowId = `alo-${runId}`;
      const conversationId = `conv-alo-${runId}`;
      const key = `send-alo-${runId}`;

      await killAfterFirstSend(
        workflowId,
        'at-least-once',
        key,
        conversationId,
        'reminder: trash night',
      );
      // Send-then-log: the send landed but the log row had not committed yet.
      expect(await sentLogClass(key)).toBeNull();
      expect(await wireSendCount(conversationId)).toBe(1);

      await DBOS.resumeWorkflow(workflowId);
      expect(await DBOS.retrieveWorkflow(workflowId).getResult()).toBe(`delivered-${key}`);

      // The duplicate the class accepts — a reminder is never dropped — and the
      // log now settles to exactly one row.
      expect(await wireSendCount(conversationId)).toBe(2);
      expect(await sentLogClass(key)).toBe('at-least-once');
    },
  );
});
