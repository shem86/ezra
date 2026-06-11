-- Semantic store (T28): lossy episodic recall, pull-only (SPEC "Semantic
-- recall is pull-only"). Co-resides with the journal and structured state in
-- the ONE Postgres — splitting would break the transactional-step co-commit.
CREATE EXTENSION IF NOT EXISTS vector;

-- Dimension is pinned to the embedder (voyage-4-lite, output_dimension 1024
-- requested explicitly) — src/memory/embedder.ts EMBEDDING_DIMENSION must
-- match. source_key is the write path's idempotency handle: compaction
-- replays (architecture: keyed on workflowID/stepNumber) upsert into it, so
-- a crash-replay cannot double-write a summary.
CREATE TABLE semantic_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  source_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- No ANN index yet: at household scale (a few summaries a day) an exact scan
-- is both faster to write and exactly correct. Add HNSW only if row counts
-- ever make recall latency visible.
