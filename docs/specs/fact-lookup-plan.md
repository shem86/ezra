# Fact lookup — code owns key matching, not model recall

**Problem.** `get_fact` reads `household_facts` by exact key (`getFact`'s
`WHERE key = $1`). A read only hits if the model reproduces, weeks later, the
exact slug it invented at `set_fact` time (`wifi-network` vs `wifi-password`
vs `WiFi`). Misses read as "no fact stored" — the household thinks ezra forgot.

**Approach.** Facts are open-ended, so a code-owned key enum doesn't fit (that
pattern is reserved for closed sets like member preferences). Instead the
model still *names* a fact, but code owns *matching*: normalized keys,
search-based reads with a key-catalog fallback, and a near-duplicate guard on
writes. No DB migration, no new dependency, no new tool name (`get_fact` /
`set_fact` keep their names, so the scripted day, the injection eval and the
UC-5 fencing coverage are untouched).

Out of scope: embeddings (only if Hebrew↔English lexical misses show up — a
migration, ask-first), a delete tool, member preferences (separate design).

## Tasks

### F1 · `normalizeFactKey` — one canonical key form
- Pure function in `src/tools/facts.ts`: lowercase, runs of anything that is
  not a letter/digit (Unicode-aware — Hebrew survives) → `-`, trim `-`.
  Degenerate input (all punctuation) falls back to the trimmed lowercase raw.
- `set_fact` writes the normalized key; `get_fact` tries the normalized key
  first.
- **Accept:** unit tests — `WiFi Password` / `wifi_password` /
  ` wifi-password ` all → `wifi-password`; Hebrew key kept; `!!!` non-empty.
  Integration: `set_fact {key:'Gate Code'}` then `get_fact {key:'gate-code'}`
  hits.

### F2 · `get_fact` falls back to search, then to the key catalog
- Store: `searchFacts(db, terms, limit)` (ILIKE any term over key OR value)
  and `listFactKeys(db, limit)` in `src/memory/store.ts` — reads only.
- `get_fact` arg stays `key`, described as "the fact's key or a few words
  describing it". Order: exact normalized key → term search ranked by key
  hits then value hits (top 5, each value fenced as today) → if nothing
  matches, the stored key list (fenced — keys are replayed stored text too)
  so the model picks a real key instead of guessing again.
- Legacy un-normalized keys already in prod are reached by the ILIKE search.
- **Accept:** unit (fake Queryable) — search results fenced, catalog fenced,
  empty store says so plainly. Integration — stored `wifi-password` found by
  `get_fact {key:'wifi'}` and by a value word; miss returns the catalog.

### F3 · `set_fact` near-duplicate guard
- New key (normalized form not stored) whose terms match existing keys →
  don't write; return the similar keys and tell the model to update one by
  its exact key, or re-call with `distinct: true` to store separately.
  Updates to an existing key and `distinct: true` write as before.
- **Accept:** integration — `wifi-password` stored, `set_fact {key:'wifi'}`
  writes nothing and names `wifi-password`; same call with `distinct: true`
  writes; updating `wifi-password` itself is unguarded.

### F4 · Record it
- `STATUS.md` entry (dated, how verified); archive this plan under
  `docs/specs/archive/`. `pnpm check:docs` green.

Every task: RED test first, `pnpm lint && pnpm test` (+ integration with
`DATABASE_URL`) and `pnpm build` green, one commit.
