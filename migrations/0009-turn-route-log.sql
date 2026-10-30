-- Turn-route log (docs/specs/jev-turn-routing-plan.md §5, §5b, §8a). One row per
-- routed turn: the tier it ran on, what the router proposed, why (`source`),
-- and — when Jev was asked — the exact request and the answers it returned, so
-- any routing decision can be re-run and real traffic can be labelled into the
-- eval set. Message text lives HERE (our Postgres), never in Langfuse traces:
-- the T31 boundary keeps spans metadata-only.
--
-- workflow_id is UNIQUE: the router runs at most once per turn, so a
-- crash-replay re-issues the same insert and ON CONFLICT makes it a no-op.
--
-- source: 'jev' | 'pre-rule:<rule>' | 'fallback-error:<kind>'. A Jev outage
-- shows up as a run of fallback-error rows — the backoffice Router panel reads
-- exactly that.
--
-- Read access: migration 0007's ALTER DEFAULT PRIVILEGES grants SELECT on
-- future public tables to hh_readonly, so the backoffice role can read this
-- with no follow-up grant.
CREATE TABLE turn_route_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL UNIQUE,
  conversation_id text NOT NULL,
  mode text NOT NULL,              -- shadow | on
  tier text NOT NULL,              -- what the turn ran on
  proposed text NOT NULL,          -- what the router chose before shadow/rollout
  source text NOT NULL,
  questions_version text NOT NULL, -- routeQuestionsVersion: which wording answered
  jev_model text,                  -- the versioned id that answered (null: Jev not asked / failed)
  latency_ms int,
  input_tokens int,
  answers jsonb,                   -- RouteAnswers probabilities (null unless source = 'jev')
  request jsonb,                   -- the exact { state, questions } sent (null on a pre-rule)
  response jsonb,                  -- Jev's validated answers, wire format (null unless answered)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The Router panel and turn view read the most recent rows.
CREATE INDEX turn_route_log_created_at_idx ON turn_route_log (created_at DESC);
