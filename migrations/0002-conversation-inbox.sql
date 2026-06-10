-- Conversation inbox (T21): the durable rendezvous for the conversation lane.
-- Ingestion inserts here (transactional step, exactly-once) BEFORE any
-- debounce waiting — consumer-side debounce groups rows that are already
-- durable, never messages held in memory (architecture decision 2).
-- seq is the total order: FIFO across human and proactive items is by
-- enqueue order, not send/arrival time (decision 2 ordering note).
CREATE TABLE conversation_inbox (
  seq bigserial PRIMARY KEY,
  conversation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human', 'proactive')),
  sender_id text NOT NULL,
  -- The idempotency anchor: a redelivered WhatsApp message (crash after
  -- enqueue, before ack) lands on this constraint and inserts nothing.
  message_id text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz -- NULL = pending; set when its batch completes
);

CREATE INDEX conversation_inbox_pending_idx
  ON conversation_inbox (conversation_id, seq)
  WHERE processed_at IS NULL;
