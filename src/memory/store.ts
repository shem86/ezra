// Structured store v0 (T18): typed accessors over the schema-v0 tables.
// Functions take a Queryable rather than owning a connection so the same
// query runs inside a DBOS datasource transaction (T19) or a plain pg client
// in tests — the transactional-step boundary is the caller's job, not ours.

interface QueryResultLike {
  rows: Record<string, unknown>[];
}

export interface Queryable {
  query(queryText: string, values?: unknown[]): Promise<QueryResultLike>;
}

export type ReminderStatus = 'scheduled' | 'fired' | 'cancelled';
export type PendingActionStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'expired';
export type DeliveryClass = 'at-least-once' | 'at-most-once';

export interface ListItem {
  readonly id: string;
  readonly list: string;
  readonly item: string;
  readonly addedBy: string;
  readonly done: boolean;
  readonly createdAt: Date;
  readonly doneAt: Date | null;
}

export interface Reminder {
  readonly id: string;
  readonly conversationId: string;
  readonly body: string;
  readonly dueAt: Date;
  readonly recurrence: string | null;
  readonly status: ReminderStatus;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface HouseholdFact {
  readonly key: string;
  readonly value: string;
  readonly isSecret: boolean;
  readonly updatedAt: Date;
}

export interface PendingAction {
  readonly actionId: string;
  readonly conversationId: string;
  readonly toolCall: unknown;
  readonly status: PendingActionStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface SentLogEntry {
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly deliveryClass: DeliveryClass;
  readonly body: unknown;
  readonly createdAt: Date;
}

function mapListItem(row: Record<string, unknown>): ListItem {
  return {
    id: row.id as string,
    list: row.list as string,
    item: row.item as string,
    addedBy: row.added_by as string,
    done: row.done as boolean,
    createdAt: row.created_at as Date,
    doneAt: (row.done_at as Date | null) ?? null,
  };
}

export async function addListItem(
  db: Queryable,
  input: { list: string; item: string; addedBy: string },
): Promise<ListItem> {
  const res = await db.query(
    'INSERT INTO lists (list, item, added_by) VALUES ($1, $2, $3) RETURNING *',
    [input.list, input.item, input.addedBy],
  );
  return mapListItem(res.rows[0]!);
}

export async function getOpenItems(db: Queryable, list: string): Promise<ListItem[]> {
  const res = await db.query(
    'SELECT * FROM lists WHERE list = $1 AND NOT done ORDER BY created_at, id',
    [list],
  );
  return res.rows.map(mapListItem);
}

export async function markItemDone(db: Queryable, id: string): Promise<ListItem | null> {
  const res = await db.query(
    'UPDATE lists SET done = true, done_at = now() WHERE id = $1 RETURNING *',
    [id],
  );
  return res.rows[0] ? mapListItem(res.rows[0]) : null;
}

function mapReminder(row: Record<string, unknown>): Reminder {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    body: row.body as string,
    dueAt: row.due_at as Date,
    recurrence: (row.recurrence as string | null) ?? null,
    status: row.status as ReminderStatus,
    createdBy: row.created_by as string,
    createdAt: row.created_at as Date,
  };
}

export async function createReminder(
  db: Queryable,
  input: {
    conversationId: string;
    body: string;
    dueAt: Date;
    createdBy: string;
    recurrence?: string;
  },
): Promise<Reminder> {
  const res = await db.query(
    `INSERT INTO reminders (conversation_id, body, due_at, recurrence, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.conversationId, input.body, input.dueAt, input.recurrence ?? null, input.createdBy],
  );
  return mapReminder(res.rows[0]!);
}

/**
 * Scheduled→fired transition guard: true only for the run that actually
 * flipped it, so a sweep replay or a racing tick cannot double-fire.
 */
export async function markReminderFired(db: Queryable, id: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE reminders SET status = 'fired' WHERE id = $1 AND status = 'scheduled' RETURNING id",
    [id],
  );
  return res.rows.length > 0;
}

export async function getDueReminders(db: Queryable, asOf: Date): Promise<Reminder[]> {
  const res = await db.query(
    "SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= $1 ORDER BY due_at, id",
    [asOf],
  );
  return res.rows.map(mapReminder);
}

function mapFact(row: Record<string, unknown>): HouseholdFact {
  return {
    key: row.key as string,
    value: row.value as string,
    isSecret: row.is_secret as boolean,
    updatedAt: row.updated_at as Date,
  };
}

export async function upsertFact(
  db: Queryable,
  input: { key: string; value: string; isSecret?: boolean },
): Promise<HouseholdFact> {
  const res = await db.query(
    `INSERT INTO household_facts (key, value, is_secret) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = excluded.value, is_secret = excluded.is_secret, updated_at = now()
     RETURNING *`,
    [input.key, input.value, input.isSecret ?? false],
  );
  return mapFact(res.rows[0]!);
}

export async function getFact(db: Queryable, key: string): Promise<HouseholdFact | null> {
  const res = await db.query('SELECT * FROM household_facts WHERE key = $1', [key]);
  return res.rows[0] ? mapFact(res.rows[0]) : null;
}

function mapPendingAction(row: Record<string, unknown>): PendingAction {
  return {
    actionId: row.action_id as string,
    conversationId: row.conversation_id as string,
    toolCall: row.tool_call,
    status: row.status as PendingActionStatus,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
  };
}

export async function createPendingAction(
  db: Queryable,
  input: { actionId: string; conversationId: string; toolCall: unknown; expiresAt: Date },
): Promise<PendingAction> {
  // jsonb params are stringified explicitly: node-pg would format a bare JS
  // array as a Postgres array literal, not JSON.
  const res = await db.query(
    `INSERT INTO pending_actions (action_id, conversation_id, tool_call, expires_at)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
    [input.actionId, input.conversationId, JSON.stringify(input.toolCall), input.expiresAt],
  );
  return mapPendingAction(res.rows[0]!);
}

export async function getPendingAction(
  db: Queryable,
  actionId: string,
): Promise<PendingAction | null> {
  const res = await db.query('SELECT * FROM pending_actions WHERE action_id = $1', [actionId]);
  return res.rows[0] ? mapPendingAction(res.rows[0]) : null;
}

function mapSentEntry(row: Record<string, unknown>): SentLogEntry {
  return {
    idempotencyKey: row.idempotency_key as string,
    conversationId: row.conversation_id as string,
    deliveryClass: row.delivery_class as DeliveryClass,
    body: row.body,
    createdAt: row.created_at as Date,
  };
}

/**
 * Insert-if-absent on the idempotency key — the dedupe primitive both send
 * classes build on. Returns false when the key was already logged.
 */
export async function recordSend(
  db: Queryable,
  input: {
    idempotencyKey: string;
    conversationId: string;
    deliveryClass: DeliveryClass;
    body: unknown;
  },
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO sent_log (idempotency_key, conversation_id, delivery_class, body)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [input.idempotencyKey, input.conversationId, input.deliveryClass, JSON.stringify(input.body)],
  );
  return res.rows.length > 0;
}

export async function getSentEntry(
  db: Queryable,
  idempotencyKey: string,
): Promise<SentLogEntry | null> {
  const res = await db.query('SELECT * FROM sent_log WHERE idempotency_key = $1', [
    idempotencyKey,
  ]);
  return res.rows[0] ? mapSentEntry(res.rows[0]) : null;
}

export async function loadContext(db: Queryable, conversationId: string): Promise<unknown[]> {
  const res = await db.query(
    'SELECT messages FROM conversation_context WHERE conversation_id = $1',
    [conversationId],
  );
  return res.rows[0] ? (res.rows[0].messages as unknown[]) : [];
}

export async function saveContext(
  db: Queryable,
  conversationId: string,
  messages: unknown[],
): Promise<void> {
  await db.query(
    `INSERT INTO conversation_context (conversation_id, messages) VALUES ($1, $2::jsonb)
     ON CONFLICT (conversation_id) DO UPDATE
       SET messages = excluded.messages, updated_at = now()`,
    [conversationId, JSON.stringify(messages)],
  );
}

export type InboxKind = 'human' | 'proactive';

export interface InboxItem {
  readonly seq: number;
  readonly conversationId: string;
  readonly kind: InboxKind;
  readonly senderId: string;
  readonly messageId: string;
  readonly payload: unknown;
  readonly enqueuedAt: Date;
  readonly processedAt: Date | null;
}

function mapInboxItem(row: Record<string, unknown>): InboxItem {
  return {
    // pg returns int8 as a string; Number() is safe — an inbox serial will
    // never approach 2^53.
    seq: Number(row.seq),
    conversationId: row.conversation_id as string,
    kind: row.kind as InboxKind,
    senderId: row.sender_id as string,
    messageId: row.message_id as string,
    payload: row.payload,
    enqueuedAt: row.enqueued_at as Date,
    processedAt: (row.processed_at as Date | null) ?? null,
  };
}

/**
 * Insert-if-absent on the message id — same shape as `recordSend`. Returns
 * false for a redelivered duplicate (crash after enqueue, before ack).
 */
export async function insertInboxItem(
  db: Queryable,
  input: {
    conversationId: string;
    kind: InboxKind;
    senderId: string;
    messageId: string;
    payload: unknown;
  },
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO conversation_inbox (conversation_id, kind, sender_id, message_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING seq`,
    [input.conversationId, input.kind, input.senderId, input.messageId, JSON.stringify(input.payload)],
  );
  return res.rows.length > 0;
}

export async function getPendingInbox(db: Queryable, conversationId: string): Promise<InboxItem[]> {
  const res = await db.query(
    `SELECT * FROM conversation_inbox
     WHERE conversation_id = $1 AND processed_at IS NULL
     ORDER BY seq`,
    [conversationId],
  );
  return res.rows.map(mapInboxItem);
}

export async function markInboxProcessed(db: Queryable, seqs: number[]): Promise<void> {
  if (seqs.length === 0) return;
  await db.query('UPDATE conversation_inbox SET processed_at = now() WHERE seq = ANY($1)', [seqs]);
}
