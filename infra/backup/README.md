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
| `restore.sh` | `into <container>` (restore latest base + WAL) · `drill` (self-asserting) |
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

## Production wiring (lands at T45 deploy)

`docker compose -f infra/docker-compose.prod.yml -f infra/backup/docker-compose.backup.yml up -d`
runs the sidecar (continuous WAL). Base backups: a host cron runs
`… run --rm backup backup.sh base` (e.g. daily 03:00).

**Prerequisite — `pg_hba` for replication:** the stock pgvector image only
trusts replication from localhost. The prod `postgres` must permit a
replication connection from the backup user over the `internal` network
(a `host replication <user> <internal-subnet> scram-sha-256` line + a
replication-capable role). The drill avoids this by using its own isolated
source over the local socket; production must configure it explicitly. This is
the one open wiring item for T45.
