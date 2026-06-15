# Spike results

## T41 — production calendar stack round-trip gate (2026-06-12)

**Verdict: PASS first run — the production client + real tool
`execute`/`revalidate` round-trip the real Calendar API; T41 closed.**

`spikes/calendar-roundtrip.ts` (`node --env-file=.env
spikes/calendar-roundtrip.ts`), husband's calendar, far-future slot
(precheck-abort if occupied; self-cleaning — deletes only its own ids):

- The production 66-char `hh`+sha256(action_id) event id — first time the
  real derivation touched Google (T39's spike used `toString(32)`) —
  **accepted on create and returned verbatim** by events.list.
- Re-execute with the same ctx: **real 409 → folded to already-exists
  success** through the production status path (the recovery-replay no-op).
- Production `listEvents` Zod parse holds against real responses, **timed
  and all-day shapes**; the list tool renders both correctly.
- **Eastern anchoring round-trips**: Google returned exactly the instant
  `wallTimeToInstant` produced (07:30 EDT → 11:30Z); `durationMin` default
  landed as a 60-minute event.
- **Manufactured conflict caught**: `revalidate` for a different action over
  the occupied window → busy; the action's own id stays exempt (the
  replay-after-landed-POST guard) → free; an all-day event does **not**
  block the slot.
- Clean exit: both gate events deleted, window empty.

## T39 — calendar service-account round trip (2026-06-12)

**Verdict: PASS — full create / idempotent-409 / read / delete drill on
BOTH calendars (two-calendar PASS 2026-06-12; T39 closed).**

`spikes/calendar-sa.ts` (`node --env-file=.env spikes/calendar-sa.ts`),
service account `hh-agent@shem86.iam.gserviceaccount.com` per ADR-0004:

- Zero-dep RS256 JWT (`node:crypto`) → `oauth2.googleapis.com/token`
  accepted; access token issued for scope `calendar.events`.
- Husband's calendar, full drill: **create 200 → re-create with the same
  supplied event id 409 → read-back matches → delete 204.** The 409 on
  re-create is the deterministic-event-id idempotency T40's `execute`
  builds on (event ids are base32hex, `a-v0-9` — `toString(32)` emits
  exactly that alphabet).
- Wife's calendar, same full drill: **PASS** after her share landed.
  Two access-failure modes observed on the way, both loud and
  first-call (never silent): no share at all reads as **404 on
  create** (the Calendar API's "no access" answer); a share at a
  read-only level ("See all event details") reads as **403
  `requiredAccessLevel`**. The fix was flipping her share for the SA
  to "Make changes to events" — ACL changes applied within a minute
  once set correctly (a 5×60s retry loop at the wrong level never
  healed, so 403 here means wrong level, not propagation).

## T28 — Voyage embeddings wire smoke (2026-06-11)

**Verdict: PASS — real-API contract matches the client; Hebrew code-switched
ranking correct. One-time check; CI stays on the fake embedder.**

`spikes/voyage-embed.ts` (`node --env-file=.env spikes/voyage-embed.ts`),
model `voyage-4-lite` with explicit `output_dimension: 1024`:

- Both calls returned 1024-dim vectors; the usage tap reported tokens
  (40 for two documents, 7 for the query) — the T33 cost hook works.
- The Hebrew query `מתי נגמר הצהרון?` ranked the code-switched afterschool
  document at cosine similarity **0.4505** vs **0.1419** for the plumber
  document — a clean margin, not a coin flip, easing ADR-0002's accepted
  unknown on Hebrew quality (single fixture, not a benchmark; M5 evals
  remain the real test).
- Asymmetric `input_type` (document/query) accepted as documented.



## T8 — DBOS semantics spike (2026-06-09)

**Verdict: PASS. DBOS pinned at `@dbos-inc/dbos-sdk` 4.19.8 (+ `@dbos-inc/node-pg-datasource` 4.19.8).**

`tests/integration/dbos-spike.test.ts` proves, against the single dev Postgres
(`docker compose up -d`), everything the architecture leans on:

1. **Transactional step atomicity / exactly-once** — a datasource transaction's
   app-state write commits atomically with its checkpoint
   (`dbos.transaction_completion` in the same DB); re-running the same
   `workflowID` returns the same output without re-applying the write.
2. **Kill-mid-flight recovery** — child process SIGKILLed between steps;
   `DBOS.launch()` in a fresh process recovers the pending workflow, replays
   the completed step from the journal (no double effect), executes the
   remaining step exactly once, and produces output identical to an
   uninterrupted run.
3. **Queue concurrency-1 FIFO** — five enqueued workflows execute serially in
   enqueue order.
4. **Scheduled workflows fire** (6-field crontab, `DBOS.registerScheduled`).
5. **Co-residence** — DBOS journal (`dbos` schema), app state, and the
   pgvector extension all live in the one `hh_assistant` database
   (`systemDatabaseUrl` = app `DATABASE_URL`).

### Version-specific findings (4.19.x)

- **Queues register at runtime**: `DBOS.registerQueue` must be called *after*
  `DBOS.launch()` (throws before). Workflows and scheduled workflows register
  *before* launch.
- **Recovery is application-version-scoped**: pending workflows are only
  claimed by an executor whose app version matches. The version is an MD5 of
  workflow source unless pinned via `DBOS__APPVERSION`, which DBOS reads **at
  SDK import time**. Differently-transformed copies of the same source (vitest
  vs `node` type-stripping) hash differently — production deploys that expect
  recovery across restarts must keep workflow source stable or pin the version
  explicitly. The spike pins it through vitest `test.env`.
- **Transactions are datasource-based**: the old `@DBOS.transaction()` is gone;
  use `@dbos-inc/node-pg-datasource` (`dataSource.registerTransaction` /
  `runTransaction`), with `NodePostgresDataSource.initializeDBOSSchema()` run
  once at setup.
- **Shutdown race**: runtime queue registration can race pool teardown on
  `DBOS.shutdown()` ("Cannot use a pool after calling end"); the suite inserts
  a short grace period. Revisit if it flakes in CI.

### Follow-up for M3

- The T9 determinism lint rule matches the `@DBOS.workflow()` decorator form.
  The spike (and likely the production code) uses the functional
  `DBOS.registerWorkflow(fn)` API — **extend the rule to cover functions
  passed to `DBOS.registerWorkflow` before T22** (tracked as part of T22's
  acceptance, or a small T9 follow-up at M3 entry).

## T7 — Prompt-caching spike (2026-06-09)

**Verdict: PASS — `cache_control` works through AI SDK Core provider
passthrough. No `@anthropic-ai/sdk` escape hatch needed.**

`spikes/cache-control.ts` (`node --env-file=.env spikes/cache-control.ts`),
pinned at `ai` 6.0.199 + `@ai-sdk/anthropic` 3.0.82, model `claude-haiku-4-5`,
~6.1k-token stable system prefix with
`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }`:

- Cold call: `cache_creation_input_tokens: 6135`, `cache_read_input_tokens: 0`
- Every subsequent call (different user questions, two separate process runs):
  `cache_read_input_tokens: 6135`, only 14 uncached input tokens per request

Notes for M4 (`callModel`):
- The AI SDK surfaces the numbers in `result.usage.inputTokenDetails`
  (`cacheReadTokens`/`cacheWriteTokens`) and raw Anthropic usage under
  `result.providerMetadata.anthropic.usage`.
- `providerOptions` attach to a system *message* (requires
  `allowSystemInMessages: true`), not to the plain `system:` string option.
- Haiku-class minimum cacheable prefix is 2048 tokens — shorter prefixes
  silently don't cache.

## T10 — M1 gate review

**CLOSED 2026-06-09** — builder accepted the gate: caching confirmed via T7
(no escape hatch), DBOS pin 4.19.8 accepted per T8 findings above. Follow-up
carried into M3: extend the T9 determinism rule to the functional
`DBOS.registerWorkflow` API before T22.

## T31 — Langfuse real-wire smoke (2026-06-11)

**Verdict: PASS — the zero-dep batch ingestion sink delivers; spans render
with usage, levels, and error status intact.**

`node --env-file=.env spikes/langfuse-trace.ts` against the US cloud
(`LANGFUSE_BASE_URL=https://us.cloud.langfuse.com` — the config default is
the EU host; US projects must set the var). Flush accepted all events;
verified through the public read API (not just the flush 207): trace
`hh-spike-1781234469074` shows the GENERATION (`callModel`,
`cache_read_input_tokens=1100` in usageDetails), the DEFAULT span
(`runTool`), and the ERROR span (`embedSummary`) with its statusMessage.

Gotcha fixed en route: the spike originally died under bare node with
`ERR_MODULE_NOT_FOUND` — `tracing.ts` VALUE-imports `deriveActionId` from
the tools registry (the T31 "ops imports are type-only" note was wrong for
that one), and bare node doesn't remap `.js` specifiers. The spike now uses
the documented child-entry pattern (`ts-ext-hooks` + dynamic import).

## T32/T33 — `pnpm dev` scripted day + cost gate (2026-06-11)

**Verdict: PASS — every v1 tool exercised happy-path end-to-end with real
Sonnet calls; cost extrapolates to $1.62/mo, 18× under the $30 ceiling;
cache reads nonzero on every generation.**

Run `dev-*-mqadcmm0` (9 turns, 18 generations, `claude-sonnet-4-6`,
Sonnet-only per ADR-0003). Usage pulled from the Langfuse traces
(`turn-mqadcmm0-1..9`); note the AI SDK's `usage.inputTokens` is the TOTAL
(uncached + cache read + cache write) — verified in the pinned
`@ai-sdk/anthropic` source — so uncached = input − cacheRead − cacheWrite.

| Metric | Value |
|---|---|
| Input tokens (total) | 48,727 |
| — served from cache | 41,388 (85%) |
| — cache writes | 3,812 |
| — uncached | 3,527 |
| Output tokens | 1,122 |
| Day cost (Sonnet 4.6: $3/$15 per MTok in/out, $3.75 cache write, $0.30 cache read) | **$0.0541** |
| Per turn | $0.0060 |
| × 30 days | **$1.62/mo** |

Margin: even at 5× the scripted volume (~45 turns/day) the month lands
≈ $8 — the gate cannot plausibly fail on volume. Caveats recorded honestly:
no compaction fired (short conversations; adds one Haiku summarize + one
Voyage embed per ~60 messages — negligible), no proactive reminder turns in
the script (same per-turn economics), and the day contains no multi-tool
chain turn (T33's coverage line) — a chained turn roughly doubles per-turn
cost, irrelevant at this margin; T38's evals add chained scenarios anyway.

Two real findings from the runs (both fixed in this commit):

1. **Prompt: shared-data framing was missing.** Sonnet refused a member's
   request for the stored parking-gate code ("I can only share household
   information with household members"). The stable prompt now states the
   two senders ARE the two members and all household data is shared between
   them, no secrecy (matches ADR-0001's rationale).
2. **Fixture: `builder@wa` read as a building contractor.** The refusal
   persisted after fix 1 — the model interpreted "builder" semantically as
   a tradesperson and would not give an "outside party" a gate code
   (observed twice). Fixture id renamed `husband@wa`; production JIDs are
   phone-number-shaped, so the production prompt must name/map the two real
   sender ids — added to the TASKS.md ledger for T42.

Minor observation, not a defect: the dev DB's lists are shared across runs
(keyed by list name, not conversation), so re-runs accumulate items — the
model noticed the duplicate לחם rows and offered to clean them up.

---

## T17 — Backup pipeline + PITR restore drill (PASS 2026-06-15)

Encrypted point-in-time recovery to AWS S3 (account 001467466089, us-east-1):
`pg_basebackup -Xstream` base + continuous `pg_receivewal` WAL archiving, each
artifact age-encrypted client-side (asymmetric — host holds only the public
recipient), restored into a throwaway pgvector:pg17 container via archive
recovery. Bucket `hh-assistant-backups-001467466089`: public access blocked,
SSE-S3, versioning, TLS-only policy, lifecycle expiry (WAL 14d / base 35d).

`infra/backup/restore.sh drill` (self-contained: isolated source DB, real
backup.sh, real S3, real age) PASSED — a **post-base** sentinel row that
existed ONLY in archived WAL survived the restore (`restore_sentinel` = 2 rows,
post-base row present), proving PITR rather than a snapshot.

Gotchas burned in:
- `pg_basebackup -Xstream` issues its own WAL **switch** at backup end, so a
  post-base write lands in the *next* segment — the drill waits until that exact
  segment is in S3 before restoring (deterministic, not a sleep race).
- The WAL receiver must run **continuously from before the base** or a gap
  between base-end and the first archived segment swallows writes.
- Archive recovery **requires a `restore_command`** even when WAL is already in
  `pg_wal`; the restore serves the staged archived segments via `cp` and the
  base's bundled WAL is `cp -n` fallback that never shadows the archive.
- The drill provisions its OWN isolated Postgres and drives the pg tools over
  its local socket — no `pg_hba` edit on any shared DB. Production needs a
  replication `pg_hba` line for the sidecar (the one open T45 wiring item).

Full design + runbook + drill record: `infra/backup/README.md`.

## T44 — Recovery-runbook external-effect reconciliation drill (PASS 2026-06-15)

The T17 drill proves base+WAL PITR; T44's drill proves the **runbook §4
reconciliation** — that effects which already left the box are not duplicated
when the DB is restored *behind* them. Automated as
`infra/backup/t44-reconcile-drill.sh` (+ calendar leg `t44-calendar-effect.ts`,
which drives the **production** `makeGoogleCalendarClient` / `deriveCalendarEventId`).

Timeline built and reconciled:
- **PRE-base:** an `approved` `pending_actions` row + a baseline at-least-once
  `sent_log` row.
- **base backup** (real `backup.sh` → encrypted → real S3).
- **POST-base** (the effects that "already left the box"): the action flips to
  `executed`, an at-most-once + an at-least-once `sent_log` row land, and a
  **real Google event** is created with id `hh`+sha256(action_id).
- **base-only restore** (no archived WAL ⇒ recovery stops at base-end) into a
  scratch container = the rewind.
- **reconcile:** §4c action back to `approved` (executed flip rewound); §4a
  post-base `sent_log` rows absent, baseline survived; §4b the restored action's
  id re-derives identically → re-execute → real Google **409 → folded to
  already-exists** → window holds **exactly one** event (no duplicate).

Isolation: isolated source Postgres (no real DB), **drill-scoped S3 prefix**
(never production `pitr/`), **ephemeral age keypair** (the production private
identity stays offline — encrypt+decrypt both happen in one run, same `lib.sh`
age path), far-future calendar slot prechecked empty + deleted on exit. Verified
zero residue. No src/test changes — the primitives were already test-locked
(`send-class-recovery.test.ts`, `calendar-approval.test.ts`, T41 real wire); the
drill is the end-to-end confirmation. Drill record: `docs/recovery-runbook.md`.

Gotchas burned in:
- `docker exec` drops stdin without `-i` — a heredoc piped to `docker exec
  psql` (no `-i`) silently runs nothing; the table-creation step needs `-i`.
- Base-only restore (the rewind) needs **no** `restore_command`/`recovery.signal`:
  extract the base + its bundled `-Xstream` WAL into `pg_wal` and start normally;
  recovery reaches base-end consistency and stops there. Adding archived WAL is
  what would roll *forward* past the rewind point (that path is the T17 drill).
