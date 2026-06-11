# ADR-0001: Remove the user-facing secret-fact class

**Date:** 2026-06-11 · **Status:** Accepted · **Supersedes:** the "secret
class for the structured store" recommendation in the architecture doc's
deferred risks ("Secrets in context, traces, and at rest") as it applies to
*household facts*. The operational-credential half of that concern is
unchanged.

## Context

The architecture doc (v3.5, deferred risks) recommended a secret class on the
structured store so household secrets stored as facts (wifi password and
similar) never enter prompts or Langfuse traces. T18 added an `is_secret`
column to `household_facts`; T27 enforced it on the tool read/echo paths:
`set_fact` accepted an `isSecret` arg and withheld the value from its
confirmation, and `get_fact` on a secret row acknowledged existence but
withheld the value.

## Decision

Remove the user-facing secret-fact class entirely: the `is_secret` column
(migration `0003`), the store field, the `isSecret` tool arg, both withhold
branches, and their tests. Rescope the term "secret-class" project-wide to
mean **operational credentials only** — API keys, OAuth refresh tokens,
Baileys session state — which never enter the model path *by construction*
(tools receive authenticated clients via `deps`, never raw credentials;
prompt assembly never touches `Config`; `src/ops/config.ts` is the only env
reader).

## Rationale

1. **As built, secret facts were write-only.** The WhatsApp chat is the only
   read surface, and `get_fact` withheld secret values from it — so a stored
   secret could never be retrieved by anyone. "What's the wifi password?" got
   a refusal from the household's own assistant: strictly worse than not
   storing the value. Making it useful would require an out-of-band delivery
   path (value through the transport without touching the transcript) —
   unjustifiable complexity for a two-person household.
2. **The flag never protected the real exposure path.** A secret arrives *as
   a WhatsApp message* before it is ever stored, so it is already in the
   transcript, prompts, traces, and (post-compaction) the semantic store.
   `is_secret` sanitized only the tool_result echo — the smallest slice.
3. **Ongoing cost with no payoff:** an `isSecret` classification decision on
   every `set_fact`, schema tokens in every prompt, misclassification risk in
   both directions, and extra spec/test surface.

## Consequences

- Facts are plain conversational data; a value stored as a fact flows through
  prompts and traces like any other message content. If conversation-borne
  secrets ever become a real concern, the lever is Langfuse data-retention /
  masking settings, not a storage class.
- T31 rescoped: no fact-value redaction; it verifies the by-construction
  credential boundary holds in emitted traces.
- T39 unaffected: OAuth refresh tokens remain secret-class in the operational
  sense (stored in Postgres, in encrypted backups, never model-visible).
- The encryption-at-rest deferred risk survives intact; its remaining scope
  is backups, the Baileys volume, and OAuth tokens — none depended on the
  facts flag.
