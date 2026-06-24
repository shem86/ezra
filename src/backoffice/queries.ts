// Read-only, SELECT-only query layer — the ONLY database access in the
// backoffice, and the running service reaches it through a SELECT-only role
// (BO-17), so a write is impossible at two layers: no mutating SQL is authored
// here, and the role couldn't execute one if it were. Every row is Zod-parsed
// at the boundary (never trust the shape). Timestamps are cast to text in SQL
// so the API serializes clean strings without Date round-tripping.
//
// Mapping vs the prototype's mock (design→reality table in the spec): invented
// columns are dropped; household_facts NEVER exposes is_secret rows (a hard
// privacy boundary — secret-class facts must not reach prompts, traces, or
// this console); sent_log maps to delivery_class/conversation_id; jsonb fields
// are projected to readable scalars (tool name, message text, message count).

import { z } from 'zod';

export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type CellValue = string | number | boolean | null;
export type BackofficeRow = Record<string, CellValue>;

const ts = z.string(); // timestamptz cast to text in SQL
const text = z.string();
const nullableText = z.string().nullable();

const schemas = {
  lists: z.object({
    id: text,
    list: text,
    item: text,
    added_by: text,
    done: z.boolean(),
    created_at: ts,
  }),
  reminders: z.object({
    id: text,
    body: text,
    created_by: text,
    due_at: ts,
    status: text,
    conversation_id: text,
  }),
  household_facts: z.object({
    key: text,
    value: text,
    updated_at: ts,
  }),
  pending_actions: z.object({
    action_id: text,
    tool: nullableText,
    status: text,
    conversation_id: text,
    created_at: ts,
    expires_at: ts,
  }),
  sent_log: z.object({
    idempotency_key: text,
    conversation_id: text,
    delivery_class: text,
    body: nullableText,
    created_at: ts,
  }),
  conversation_inbox: z.object({
    seq: text, // bigserial → string from node-pg
    conversation_id: text,
    kind: text,
    sender_id: text,
    message_id: text,
    text: nullableText,
    enqueued_at: ts,
    processed_at: nullableText,
  }),
  conversation_context: z.object({
    conversation_id: text,
    messages: z.number(),
    updated_at: ts,
  }),
} as const;

export type TableKey = keyof typeof schemas;

export interface TableDef {
  readonly label: string;
  readonly icon: string;
  readonly columns: readonly string[];
  /** $1 = row limit. SELECT-only; the table name is never interpolated. */
  readonly sql: string;
  readonly schema: z.ZodType<BackofficeRow>;
}

// Note: the table key is a fixed registry lookup (below), never user-supplied
// SQL — there is no place to inject a table name.
export const TABLES: Record<TableKey, TableDef> = {
  reminders: {
    label: 'reminders',
    icon: 'bell',
    columns: ['id', 'body', 'created_by', 'due_at', 'status', 'conversation_id'],
    sql: `SELECT id::text AS id, body, created_by, due_at::text AS due_at, status, conversation_id
          FROM reminders ORDER BY due_at DESC LIMIT $1`,
    schema: schemas.reminders,
  },
  lists: {
    label: 'lists',
    icon: 'cart',
    columns: ['id', 'list', 'item', 'added_by', 'done', 'created_at'],
    sql: `SELECT id::text AS id, list, item, added_by, done, created_at::text AS created_at
          FROM lists ORDER BY created_at DESC LIMIT $1`,
    schema: schemas.lists,
  },
  household_facts: {
    label: 'household_facts',
    icon: 'book',
    columns: ['key', 'value', 'updated_at'],
    // The user-facing secret-fact class was removed (migration 0003 / ADR-0001):
    // this table is now key/value only and holds no credentials. "Secret-class"
    // today means operational secrets (API keys, OAuth, Baileys state) which
    // never reach the DB or this console by construction (SPEC "Never").
    sql: `SELECT key, value, updated_at::text AS updated_at
          FROM household_facts ORDER BY updated_at DESC LIMIT $1`,
    schema: schemas.household_facts,
  },
  pending_actions: {
    label: 'pending_actions',
    icon: 'pause',
    columns: ['action_id', 'tool', 'status', 'conversation_id', 'created_at', 'expires_at'],
    sql: `SELECT action_id, tool_call->>'name' AS tool, status, conversation_id,
                 created_at::text AS created_at, expires_at::text AS expires_at
          FROM pending_actions ORDER BY created_at DESC LIMIT $1`,
    schema: schemas.pending_actions,
  },
  sent_log: {
    label: 'sent_log',
    icon: 'send',
    columns: ['idempotency_key', 'conversation_id', 'delivery_class', 'body', 'created_at'],
    sql: `SELECT idempotency_key, conversation_id, delivery_class, body->>'text' AS body,
                 created_at::text AS created_at
          FROM sent_log ORDER BY created_at DESC LIMIT $1`,
    schema: schemas.sent_log,
  },
  conversation_inbox: {
    label: 'conversation_inbox',
    icon: 'logs',
    columns: ['seq', 'conversation_id', 'kind', 'sender_id', 'message_id', 'text', 'enqueued_at', 'processed_at'],
    sql: `SELECT seq::text AS seq, conversation_id, kind, sender_id, message_id,
                 payload->>'text' AS text, enqueued_at::text AS enqueued_at,
                 processed_at::text AS processed_at
          FROM conversation_inbox ORDER BY seq DESC LIMIT $1`,
    schema: schemas.conversation_inbox,
  },
  conversation_context: {
    label: 'conversation_context',
    icon: 'flow',
    columns: ['conversation_id', 'messages', 'updated_at'],
    sql: `SELECT conversation_id, jsonb_array_length(messages) AS messages,
                 updated_at::text AS updated_at
          FROM conversation_context ORDER BY updated_at DESC LIMIT $1`,
    schema: schemas.conversation_context,
  },
};

export const TABLE_KEYS = Object.keys(TABLES) as TableKey[];

export function isTableKey(value: string): value is TableKey {
  return Object.prototype.hasOwnProperty.call(TABLES, value);
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export interface TableListing {
  readonly table: TableKey;
  readonly label: string;
  readonly icon: string;
  readonly columns: readonly string[];
  readonly rows: BackofficeRow[];
}

/** Run one table's SELECT and return Zod-parsed rows. `db` is a SELECT-only
 *  pool in production; tests inject a fake or a real `_test` pool. */
export async function queryTable(
  db: Queryable,
  table: TableKey,
  options: { limit?: number } = {},
): Promise<TableListing> {
  const def = TABLES[table];
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const result = await db.query(def.sql, [limit]);
  const rows = result.rows.map((r) => def.schema.parse(r));
  return { table, label: def.label, icon: def.icon, columns: def.columns, rows };
}

/** The table catalogue (no rows) — drives the Database screen's rail. */
export function tableCatalogue(): { table: TableKey; label: string; icon: string }[] {
  return TABLE_KEYS.map((t) => ({ table: t, label: TABLES[t].label, icon: TABLES[t].icon }));
}
