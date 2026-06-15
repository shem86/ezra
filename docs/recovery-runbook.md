# Recovery runbook (T44)

What to do when the agent loses state. Four loss scenarios, exact commands,
and the reconciliation of external effects that already landed when the
restored database is rewound behind them.

This runbook is **mechanical, not judgment**: every step is a command or a
query whose answer is already determined. Where a residual risk remains
(at-most-once re-send across a point-in-time rewind), it is named explicitly
rather than papered over.

## Principles (why the steps are what they are)

- **One Postgres holds everything** — DBOS journal, structured state, and
  pgvector co-reside (architecture decision 3, `dbos.md`). So a database
  restore rewinds the *workflow journal too*: a turn that completed after the
  backup point comes back as `PENDING` and **replays**. Reconciliation is
  therefore about replayed external effects, not lost ones.
- **Idempotency is the safety net, not operator vigilance.** Replays are
  gated by `sent_log` (sends) and deterministic ids (calendar). The operator's
  job is to restore to the *latest* recoverable point (minimising the rewound
  window) and then confirm the gates held — not to hand-pick what to re-run.
- **The Baileys session is never restored** (SPEC "Never"). It is re-paired on
  loss. It is not in the backup set and must not be put there.

## Scenario 1 — Process crash (host fine, DB fine)

The common case: OOM, `kill -9`, a panic. The database (journal + state) is
intact; only the process died mid-flight.

**Action: just restart.**

```
pnpm start            # or: docker compose -f infra/docker-compose.prod.yml up -d
```

What happens on its own:

1. `src/start.ts` sets a fresh per-generation `DBOS__VMID` **before** the SDK
   import, so DBOS's launch-time auto-recovery is a deliberate no-op (it would
   otherwise race datasource init and error recovered workflows permanently —
   `dbos.md` ⚠).
2. After launch (datasources initialised), `resumeStrandedWorkflows()`
   (`src/orchestration/recovery.ts`) lists `PENDING` roots from prior
   generations, skips the current generation and foreign app versions, and
   `DBOS.resumeWorkflow`s the rest. They replay from their last journaled step.
3. WhatsApp redelivers any inbound messages the dead process received but never
   acked; `ingestWorkflowId(messageId)` dedupes redelivery (`ingest.ts`).

**No restore, no re-pair.** Proven by the kill-mid-turn → restart → turn-
completes drill in `tests/integration/launch-recovery.test.ts` (`pnpm
test:recovery`). Then run the **External-effect reconciliation** section below
— a replayed turn may re-fire sends (see the at-most-once note).

## Scenario 2 — Host loss (rebuild from backups)

The box is gone (terminated, disk dead, region migration). Restore Postgres
from the PITR pipeline (T17) onto a fresh host.

1. **Stand up the host** — idempotent baseline:
   ```
   infra/provision-host.sh        # hh user, SSH lockdown, patching (T15)
   ```
2. **Restore Postgres to the latest recoverable point.** Restore the latest
   base + *all* archived WAL — this minimises the rewound window, which is what
   bounds the at-most-once re-send risk below. The self-contained path builds
   PGDATA inside a pgvector container (sidesteps host↔container uid skew):
   ```
   BACKUP_S3_BUCKET=…  BACKUP_AGE_IDENTITY=/path/age.key \
     infra/backup/restore.sh into hh-restore
   # restores latest base + WAL via archive recovery, then promotes.
   # Inspect: docker exec -u postgres hh-restore psql -d hh_assistant -c '\dt'
   ```
   For an in-place production Postgres rather than a scratch container, follow
   the same staging (base → WAL via `restore_command` → promote) per
   `infra/backup/README.md` "Restore (operator)". The age **private** key is
   required here and lives offline (restore-only); the host never holds it.
3. **Point the app at the restored DB** (`DATABASE_URL` = the one Postgres) and
   apply any forward migrations the restored snapshot predates:
   ```
   pnpm migrate          # forward-only; a no-op if already current
   ```
4. **Re-pair WhatsApp** (the session was not restored — Scenario 3):
   ```
   pnpm pair --reset
   ```
5. **Start** (`pnpm start`) — recovery proceeds as in Scenario 1.
6. **Reconcile external effects** — the section below. After a host-loss
   restore the rewound window can be larger than a crash, so this is where it
   matters most.
7. **Re-open replication for ongoing backups** — the restored Postgres needs
   the replication `pg_hba` line for the backup sidecar (the stock pgvector
   image only trusts replication from localhost), then the sidecar restarted:
   ```
   infra/backup/enable-replication.sh    # idempotent; appends the line + reloads
   docker compose -f infra/docker-compose.prod.yml \
                  -f infra/backup/docker-compose.backup.yml up -d   # continuous WAL
   ```
   Until this is in place the new host runs **without** continuous WAL archiving
   (`infra/backup/README.md` "Production wiring").

## Scenario 3 — Baileys session loss

The WhatsApp session is corrupt, was logged out from the phone, or was lost
with the host. There is no restore path **by design**.

```
pnpm pair --reset     # scan the QR on the phone (docs/pairing.md)
```

Never restore Baileys session state from a backup (SPEC "Never"); it is
gitignored, excluded from the backup set, and re-pairing is the only recovery.
A restored session risks a ban. Echo suppression is sent-id based (not
`fromMe`), so it survives a re-pair without special handling.

## Scenario 4 — Partial external effects (the reconciliation)

This is the heart of T44. After **any** restore that rewinds the database
behind effects that already left the box (Scenarios 1 and 2), the replayed
workflows will re-attempt those effects. Reconciliation is reading the two
ledgers that say "already done" and trusting the gates that enforce it.

### 4a — Sends (`sent_log`)

`sent_log` answers *"what did we already send."* Every outbound text is keyed
by a deterministic idempotency key (`send-${messageId}` /
`approval-${actionId}`, `src/transport/send-class.ts`) so a replay lands on the
**same row**, not a second send.

| Class | Producers | Replay behaviour | Reconciliation |
|---|---|---|---|
| **at-least-once** | reminders, nags, approval prompts (sender `system`) | send-then-log; a replay after a rewound log row **re-sends** | **Accepted by the class** — a duplicate reminder beats a missed one. No action. |
| **at-most-once** | human replies, `system:hitl` notices | log-then-send; the row is the tombstone | If the row survived the restore, the replay is skipped — no duplicate. **Residual:** a send whose row landed in the *rewound window* lost its tombstone, so the replay **can re-send once.** |

**The residual at-most-once duplicate is the one genuine reconciliation
hazard, and it is bounded, not eliminated:**

- It only affects sends whose `sent_log` row committed *after* the restore
  point. Restoring to the latest archived WAL (Scenario 2 step 2) shrinks that
  window to near-zero.
- The duplicate is one conversational reply or one low-stakes notice — never a
  reminder (those are at-least-once by design) and never a calendar write (4b).
- To see the exposure, list the at-most-once rows near the restore point:
  ```
  SELECT idempotency_key, conversation_id, created_at
    FROM sent_log
   WHERE delivery_class = 'at-most-once'
   ORDER BY created_at DESC LIMIT 20;
  ```
  Anything a *live* observer saw sent but that is **absent** here is a row the
  rewind dropped; its turn will re-send it on replay. This is awareness, not a
  fix — there is no safe way to suppress a send the journal no longer knows it
  made. Forking the library to defer receipts was rejected at T42 for a smaller
  window; this is the same trade at restore scale.

Locked by `tests/integration/send-class-recovery.test.ts`: at-most-once never
re-sends across a crash *when the tombstone survives*; at-least-once re-sends
then settles to one row.

### 4b — Calendar events (deterministic ids)

Deterministic ids answer *"what did we already create."* A calendar event's id
is `hh` + SHA-256 hex of the `action_id` (`deriveCalendarEventId`,
`src/tools/calendar-client.ts`) — a pure function of journaled state, identical
across replay.

So a `pending_actions` row restored as `approved` whose `create_calendar_event`
effect committed *after* the restore point will, on replay, re-derive the **same**
event id and POST it. Google returns **409**, which the client folds to
already-exists success (`calendar.ts`). **No duplicate event, no operator
action.** This is mechanical and complete — there is no residual here, unlike
4a. The own-id exemption in `revalidate` ensures a replay does not see its own
event as a conflict and wrongly mark the action `stale`.

Locked by `tests/integration/calendar-approval.test.ts` (replay execute →
already-exists no-op) and proven on the real Google wire at T41
(`spikes/calendar-roundtrip.ts`).

### 4c — Pending actions left mid-approval

A rewind can also un-settle an approval: a row that was `pending` at the
restore point but reached `approved`/`executed` afterwards comes back
`pending`. The approval reply that settled it is gone (unless WhatsApp
redelivers it). The action then simply **waits** — the TTL sweep (T37) expires
it gently (`APPROVAL_TTL_HOURS`, 12h default) and the user is told nothing was
executed and can ask again. No effect double-fires (the calendar id in 4b makes
even a re-approval safe). To list what is hanging:

```
SELECT action_id, status, created_at, expires_at
  FROM pending_actions
 WHERE status IN ('pending', 'approved')
 ORDER BY created_at DESC;
```

## The restore drill (the T44 gate)

> **Status: PASS 2026-06-15** (Claude under builder authorization). Unlike the
> T17 drill (which proves base + WAL PITR), the T44 drill also creates and
> reconciles a **real external effect**: a calendar event written *after* the
> backup point, then restored behind, then confirmed not duplicated on
> re-execute. That is a real Google Calendar write and real S3 — **ask-first**
> (SPEC: real calendar writes, spending). The mechanisms it exercises are each
> already test-locked (4a/4b above); the drill is the end-to-end confirmation.
>
> Automated as `infra/backup/t44-reconcile-drill.sh` (+ the calendar leg
> `infra/backup/t44-calendar-effect.ts`, which drives the **production**
> `makeGoogleCalendarClient` and `deriveCalendarEventId`). Self-contained and
> self-cleaning: an isolated source Postgres (no real DB touched), a
> drill-scoped S3 prefix (never the production `pitr/`), an **ephemeral age
> keypair** (the production private identity is offline and not needed — encrypt
> and decrypt both happen in one run, the same `lib.sh` age path), and a
> far-future calendar slot prechecked empty and deleted on exit.

Procedure:

1. **Baseline.** Note a known `sent_log` state and an approved
   `pending_actions` row on the *live* (or an isolated source) DB.
2. **Base backup**, then continuous WAL: `infra/backup/restore.sh drill`
   already proves base + WAL PITR end to end — extend it (or drive `backup.sh`
   manually) so the timeline is:
   - take the base backup;
   - **after the base**, (a) deliver one at-most-once reply and one
     at-least-once reminder (rows land in WAL only), and (b) approve + execute a
     `create_calendar_event` action so a **real event** with id
     `hh`+sha256(action_id) exists in Google but its `pending_actions`/effect
     rows live only in archived WAL;
   - ship the WAL.
3. **Restore to a point between the base and the post-base effects** (the
   rewind), into a scratch pgvector container.
4. **Diff against live**: the post-base rows are absent in the restore (= the
   rewound window).
5. **Run the reconciliation steps** (4a/4b) on the restored state:
   - at-most-once row absent ⇒ replay would re-send (the documented residual);
   - at-least-once row absent ⇒ replay re-sends (accepted);
   - re-execute the restored-as-`approved` calendar action ⇒ re-derives the
     same id ⇒ Google 409 ⇒ folded to already-exists ⇒ **no second event**.
6. **Log the result** in the table below, then tear down (scratch container +
   the drill's calendar event + S3 artifacts).

### Drill record

| Date | Restore point | sent_log reconciliation | calendar reconciliation | Verdict |
|---|---|---|---|---|
| 2026-06-15 | base-end (rewound behind all post-base effects) | post-base at-most-once + at-least-once rows **absent**; pre-base baseline survived (§4a) | restored-as-`approved` action (§4c) re-executed → re-derived id `hh`+sha256(action_id) → real Google **409 → folded to already-exists**; window held **exactly one** event, no duplicate (§4b) | **PASS** (`infra/backup/t44-reconcile-drill.sh`, real S3 + real Google, self-cleaned) |

Run venue: dev Mac (Colima), production backup scripts + production calendar
client, ephemeral age key, drill-scoped S3 prefix (account `001467466089`,
us-east-1). The T17 base+WAL PITR leg was re-confirmed PASS the same day
(`infra/backup/restore.sh drill`). The remaining production wiring — the prod
`postgres` replication `pg_hba` line so continuous WAL archiving runs on the
real host — is the standing T45 item (`infra/backup/README.md`); the drill
sidesteps it via an isolated source over the local socket.
