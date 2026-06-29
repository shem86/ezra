-- Compaction capture log (docs/compaction-eval-spec.md). Records the INPUT and
-- OUTPUT of each summarize-and-embed compaction so the mechanism can be
-- evaluated after the fact. The head transcript is discarded everywhere else —
-- DBOS journals step OUTPUTS not inputs, conversation_context is OVERWRITTEN
-- with the compacted transcript, and trace spans carry metadata only — so
-- without this table there is no way to score a summary against what it was
-- made from.
--
-- source_key = `compact-<workflowID>` mirrors semantic_memories.source_key:
-- at most one compaction per turn, so a crash-replay re-derives the same key
-- and the ON CONFLICT insert is a no-op (never a duplicate). The shared key
-- also JOINs a log row to the semantic_memories row it produced.
--
-- summarizer_model is captured per row so a Haiku-vs-Sonnet comparison on the
-- same inputs is queryable (the summarizer runs on config.cheapModelId today).
--
-- Read access: migration 0007's ALTER DEFAULT PRIVILEGES already grants SELECT
-- on future public tables to hh_readonly, so the backoffice SELECT-only role
-- (the eval's prod spot-check path) can read this with no follow-up grant.
CREATE TABLE compaction_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  conversation_id text NOT NULL,
  source_key text NOT NULL UNIQUE,
  head jsonb NOT NULL,         -- the summarized messages (TurnMessage[]), verbatim
  summary text NOT NULL,       -- the model's result
  cut_index int NOT NULL,      -- split point: head = msgs[0..cut), tail = msgs[cut..]
  head_count int NOT NULL,
  tail_count int NOT NULL,
  summarizer_model text NOT NULL,
  head_chars int NOT NULL,     -- sum of head message content lengths (conciseness baseline)
  summary_chars int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The spot-check path reads the most recent rows; keep that ordering cheap.
CREATE INDEX compaction_log_created_at_idx ON compaction_log (created_at DESC);
