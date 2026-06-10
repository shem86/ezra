-- Structured store schema v0 (T18).
-- Source-of-truth state: the transcript never holds exact facts (SPEC "Truth
-- vs continuity") — these tables do, read through typed tools at use time.

-- Shared lists: one row per item; the list name groups them ('groceries',
-- 'todos'). Concurrent edits serialize upstream via the concurrency-1 queue.
CREATE TABLE lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list text NOT NULL,
  item text NOT NULL,
  added_by text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);

CREATE INDEX lists_open_items_idx ON lists (list) WHERE NOT done;

-- due_at is the absolute next-fire instant; conversion from household-local
-- wall time (Eastern, never server time) happens before rows get here.
CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  body text NOT NULL,
  due_at timestamptz NOT NULL,
  recurrence text, -- DBOS 6-field crontab; NULL = one-shot
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'fired', 'cancelled')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reminders_due_idx ON reminders (due_at) WHERE status = 'scheduled';

-- is_secret marks secret-class rows: never into prompts, Langfuse traces, or
-- the semantic store (SPEC "Never"). Enforcement lives in the read paths.
CREATE TABLE household_facts (
  key text PRIMARY KEY,
  value text NOT NULL,
  is_secret boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Fire-and-fold parking for confirm-before tools (architecture decision 10):
-- action_id is the quoted-reply rendezvous key. Status transitions get their
-- execute-once guard in T24; v0 fixes the vocabulary so rows survive it.
CREATE TABLE pending_actions (
  action_id text PRIMARY KEY,
  conversation_id text NOT NULL,
  tool_call jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'executed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- WhatsApp has no server-side idempotency: this log is the dedupe record for
-- both send classes and the recovery runbook's reconciliation source.
CREATE TABLE sent_log (
  idempotency_key text PRIMARY KEY,
  conversation_id text NOT NULL,
  delivery_class text NOT NULL
    CHECK (delivery_class IN ('at-least-once', 'at-most-once')),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Persisted model-message transcript, whole-document per conversation. The
-- concurrency-1 consumer is the only writer, so replace-on-persist is safe.
CREATE TABLE conversation_context (
  conversation_id text PRIMARY KEY,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
