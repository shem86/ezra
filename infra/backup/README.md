# T17 — Backup pipeline + restore drill (PITR to S3)

Point-in-time recovery for the single Postgres (journal + structured state +
pgvector co-located). **Base backups + continuous WAL archiving**, client-side
encrypted, to **AWS S3** (same account/region as the EC2 host). The Baileys
session is *never* in scope — it is re-paired on loss, never restored (SPEC
"Never"); this pipeline is Postgres only.

## Design

| Concern | Choice | Why |
|---|---|---|
| Base backup | `pg_basebackup -Ft -z -Xstream` | each base is independently restorable to its own end; archived WAL extends PITR forward |
| WAL archiving | `pg_receivewal` + a physical replication slot | fully client-side — no `archive_command` (no "archive fails → disk fills" footgun); the slot's retention is the no-gap guarantee |
| Encryption | **age, asymmetric** (`age -r <recipient>`) | the host holds only the PUBLIC recipient, so a host compromise cannot decrypt existing backups; the private key is offline, needed only to restore |
| Storage | AWS S3, client-encrypted | defence in depth on top of bucket SSE; same region as compute = no cross-region egress |
| Restore | into a throwaway pgvector container, archive recovery | builds PGDATA as the postgres user inside the container — sidesteps host↔container uid skew; age/aws stay on the host |

The one source of truth for the allowed S3 host lives in the egress allowlist
(`src/ops/egress-allowlist.ts`, category `backup`).

## Files

| File | Role |
|---|---|
| `lib.sh` | config, S3 helpers, age encrypt/decrypt (sourced, not run) |
| `backup.sh` | `base` · `receivewal` (continuous) · `wal-drain` · `ensure-slot` |
| `restore.sh` | `into <container>` (restore latest base + WAL) · `drill` (self-asserting base+WAL PITR) |
| `t44-reconcile-drill.sh` | T44 gate: runbook §4 external-effect reconciliation, real S3 + real Google, self-contained + self-cleaning |
| `t44-calendar-effect.ts` | T44 calendar leg — drives the production calendar client (create/recreate/count/delete) |
| `enable-replication.sh` | T45 wiring: idempotent `host replication` pg_hba line + reload so the sidecar can stream |
| `Dockerfile` | sidecar image: pg17 client tools + aws-cli + age |
| `docker-compose.backup.yml` | sidecar overlay for the prod stack |

## Config (env; see `.env.example`)

`BACKUP_S3_BUCKET` (required) · `BACKUP_S3_PREFIX` (default `pitr`) ·
`BACKUP_AGE_RECIPIENT` (public key, required to back up) ·
`BACKUP_AGE_IDENTITY` (private key file, required to restore only) ·
standard libpq `PG*` for the source connection · standard AWS creds.

Generate the key once and **store the private half offline** (password manager
/ not on the host, not in the backup):

```
age-keygen -o age.key          # prints the public recipient on stderr
# BACKUP_AGE_RECIPIENT = the "public key:" line; keep age.key OFFLINE.
```

## S3 bucket (provisioned 2026-06-15, account 001467466089, us-east-1)

`hh-assistant-backups-001467466089` — public access fully blocked, default
SSE-S3, versioning on, TLS-only bucket policy, lifecycle: WAL expires 14d, base
35d, incomplete multipart aborts 7d, noncurrent versions 7d.

## Restore (operator)

```
BACKUP_S3_BUCKET=… BACKUP_AGE_IDENTITY=/path/age.key \
  infra/backup/restore.sh into hh-restore
# → a scratch container `hh-restore` recovers latest base + all archived WAL,
#   then promotes. Inspect with: docker exec -u postgres hh-restore psql …
```

For a real host-loss restore: stand up a fresh Postgres, run the same staging
(base + WAL via restore_command), promote, then point the app at it and
re-pair WhatsApp. Reconciliation of partial external effects (sent_log,
deterministic calendar ids) is T44's runbook.

## Restore drill (the gate)

`infra/backup/restore.sh drill` is self-asserting and self-contained: it spins
an **isolated** source Postgres (touches no real DB), drives the real
`backup.sh` against it, writes a baseline row, takes a base backup, writes a
**post-base** sentinel row that exists ONLY in archived WAL, ships it, restores
into a scratch container, and asserts the post-base row survived — proving PITR,
not just a snapshot. It cleans up containers + S3 on exit (`BACKUP_DRILL_KEEP=1`
to retain for inspection).

### Drill record — **PASS 2026-06-15**

Run on the dev Mac (Colima) against the production scripts, real S3, real age:

- base backup (`pg_basebackup -Xstream`) encrypted + uploaded; continuous
  `pg_receivewal` shipped segments 0001/0002/0003.
- post-base sentinel landed in segment `000000010000000000000003` (pg_basebackup
  issues its own WAL switch at backup end, so the post-base write moves to the
  next segment); the drill waits until that exact segment is in S3 before
  restoring — deterministic, not a timing race.
- restore into a scratch pgvector:pg17 container: archive recovery replayed base
  → WAL → promote. **`restore_sentinel` had 2 rows; the post-base row was
  present.** Teardown clean, S3 emptied.

Verdict also recorded in `docs/spike-results.md`.

## Production wiring (T45 deploy)

Bring-up, on the host after the prod stack is up:

```
# 1. enable replication for the sidecar (idempotent; re-run after a rebuild)
infra/backup/enable-replication.sh
# 2. start the sidecar (continuous WAL)
docker compose -f infra/docker-compose.prod.yml \
               -f infra/backup/docker-compose.backup.yml up -d
# 3. base backups on a host cron, e.g. daily 03:00
0 3 * * *  docker compose -f infra/docker-compose.prod.yml \
           -f infra/backup/docker-compose.backup.yml run --rm backup backup.sh base
```

**The replication `pg_hba` prerequisite (`enable-replication.sh`):** the stock
pgvector image accepts normal SQL connections from the internal network
(`host all all all scram-sha-256` — how ezra and `backup.sh ensure-slot`
connect) but trusts *replication* connections only from localhost, so
`pg_basebackup`/`pg_receivewal` are refused. `enable-replication.sh` appends
`host replication hh samenet scram-sha-256` to `pg_hba.conf` and reloads —
`hh` is the existing superuser the sidecar already uses (replication-capable),
`samenet` matches whatever subnet Docker assigns the internal bridge.
`wal_level=replica` (PG17 default) already supports physical streaming. A
least-privilege dedicated `hh_backup` role is a clean V2 hardening, not a launch
blocker (a replication connection reads the whole cluster regardless).

> **Note (validated 2026-06-15, dev Mac):** the wiring was proven end-to-end
> against the dev postgres before the host apply — a replication connection from
> a separate container is **refused** without the line (`no pg_hba.conf entry
> for replication connection`) and **succeeds** after; the prod sidecar image's
> continuous `receivewal` over TCP then shipped a complete encrypted 16 MiB WAL
> segment to S3 that decrypted back to exactly 16777216 bytes. Also fixed en
> route: `.dockerignore` excluded all of `infra`, so the sidecar image's
> `COPY infra/backup/*.sh` had never built — the two scripts are now re-included.
> The remaining step is running `enable-replication.sh` + starting the sidecar
> **on the real host** (production DB access — ask-first).
