// Fixture for the T43 send-class kill-mid-flight gate. The workflow under
// test wraps deliverReply in one step; the fake transport records each send
// into wire_sends (so the test counts sends across a crash) then sleeps wide
// enough to SIGKILL into — AFTER the row is observable, so the kill always
// lands post-send. Module-level singletons are banned in src/ but fine here
// (same exemption as spikes). The pin import MUST precede the SDK import.
import './pin-appversion-sendclass.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { Client } from 'pg';
import { getSentEntry, recordSend } from '../../../src/memory/store.ts';
import { deliverReply, type DeliverReplyArgs } from '../../../src/transport/send-class.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the send-class fixture');
}
export const sendClassConnectionString: string = connectionString;

// Plain client, exactly as main.ts wires `replyDb`: each statement
// autocommits, independent of the DBOS step journal — that independence is
// what lets the sent_log claim survive the kill and gate the replay.
let replyDb: Client | undefined;
async function getReplyDb(): Promise<Client> {
  if (!replyDb) {
    replyDb = new Client({ connectionString });
    await replyDb.connect();
  }
  return replyDb;
}

// Wide enough to reliably SIGKILL into after the row appears. A plain timer,
// not DBOS.sleep: this models the in-flight transport call inside the step,
// which is exactly where a crash strands the send/log pair.
const WIRE_SLEEP_MS = 3000;

async function fakeSend(message: {
  conversationId: string;
  text: string;
}): Promise<{ messageId: string }> {
  const db = await getReplyDb();
  const res = await db.query(
    'INSERT INTO wire_sends (conversation_id, text) VALUES ($1, $2) RETURNING id',
    [message.conversationId, message.text],
  );
  await new Promise((resolve) => setTimeout(resolve, WIRE_SLEEP_MS));
  return { messageId: `wire-${(res.rows[0] as { id: number }).id}` };
}

async function deliverReplyStep(args: DeliverReplyArgs): Promise<void> {
  const db = await getReplyDb();
  await deliverReply(
    {
      recordSend: (input) => recordSend(db, input),
      getSentEntry: (key) => getSentEntry(db, key),
      send: fakeSend,
    },
    args,
  );
}

// The kill target: one step that delivers a reply. A crash mid-step (during
// fakeSend's sleep) leaves the step un-journaled, so resume replays it — the
// exact path main.ts's sendReply step takes.
async function deliverReplyWorkflowFn(args: DeliverReplyArgs): Promise<string> {
  await DBOS.runStep(() => deliverReplyStep(args), { name: 'sendReply' });
  return `delivered-${args.idempotencyKey}`;
}
export const deliverReplyWorkflow = DBOS.registerWorkflow(deliverReplyWorkflowFn);

export async function launchSendClassRuntime(): Promise<void> {
  // No datasource transaction in this workflow (deliverReply uses the plain
  // client), but initialize the schema for parity and a clean system DB.
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-sendclass-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
