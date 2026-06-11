# ADR-0002: Voyage AI embeddings via a zero-dependency fetch client

**Date:** 2026-06-11 · **Status:** Accepted · **Scope:** T28 semantic store

## Context

The semantic store (pgvector, pull-only recall per SPEC) needs an embedding
provider; Anthropic offers none, so this is a new external service — an
ask-first on three axes (dependency, vendor key, spend).

## Decision criteria, in weight order

1. **Hebrew + code-switched retrieval quality** — the household's actual
   workload, and the only criterion that fails *silently*: weak embeddings
   read as "the model under-recalls," which SPEC treats as a reason to
   revisit the pull-only design — an embedding problem would be misdiagnosed
   as an architecture problem.
2. **Operational footprint** — new dep (review burden), one more vendor
   key/account in the secret inventory, one more egress-allowlist entry.
3. **Provider longevity** — a dead API is a recall-write outage even though
   migration is cheap.
4. **Stack fit** — official AI SDK provider > community package > raw fetch,
   all behind the same deps-injected `Embedder` seam.
5. **Cost and lock-in — tie-breakers only.** Verified usage math: compaction
   summaries (~1–3/day × ~300–800 tokens) + recall queries ≈ 1M tokens/year.
   Voyage's one-time 200M-token free tier covers ~two centuries; the paid
   rate after is ~$0.02/year. Re-embedding the whole store to switch
   providers costs cents, so lock-in is near-zero.

## Decision

**voyage-4-lite** (1024-dim, `output_dimension` pinned explicitly), called
through a small Zod-validated `fetch` client (`src/memory/embedder.ts`) — no
new dependency. `VOYAGE_API_KEY` joins the operational secrets through
`src/ops/config.ts`. Documents embed with `input_type: "document"`, recall
queries with `"query"` (Voyage's asymmetric retrieval prompts).

Voyage is near-top of the multilingual leaderboards (Gemini ranks first
overall) and is Anthropic's recommended embeddings partner; criteria 2–5 all
favor it. The Hebrew-specific delta vs Gemini is unquantified by public
benchmarks — accepted knowingly (option "pick Voyage now" over a comparison
spike): the `Embedder` seam plus cheap re-embedding make a later swap a
contained change. `spikes/voyage-embed.ts` is the one-time real-wire smoke
(Hebrew query must rank a code-switched document correctly); CI never calls
the real API.

## Consequences

- Egress allowlist (T16) gains `api.voyageai.com`.
- The schema pins `vector(1024)` (migration 0004); `EMBEDDING_DIMENSION`
  in `embedder.ts` must match — the client rejects drift before any insert.
- If evals (M5) show Hebrew under-recall, re-run the provider comparison on
  real fixtures before touching the pull-only architecture.
