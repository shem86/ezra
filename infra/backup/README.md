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
| `initdb-replication.sh` | **V2_NOTES §6** declarative bake: mounted into `/docker-entrypoint-initdb.d/`, creates the least-priv `hh_backup` REPLICATION role + the `host replication` pg_hba line at FIRST init of a fresh data dir — so continuous WAL works on first boot with no hand-run step. Runs ONLY on an empty PGDATA (helps rebuilds / create-from-zero; never mutates the live prod data dir). |
| `enable-replication.sh` | T45 wiring: idempotent `host replication` pg_hba line + reload so the sidecar can stream. **Superseded for fresh boxes by `initdb-replication.sh`** but kept (idempotent) for the existing prod box + reattached volumes. |
| `freshness.sh` | **V2_NOTES §6**: reads the latest base-backup age from S3 and pings a healthchecks.io dead-man (`<url>` fresh / `<url>/fail` stale). Surfaces a stalled base cron the WAL stream can't catch. |
| `hh-backup-base.{service,timer}` | **V2_NOTES §6** declarative base-backup schedule (daily 03:00 UTC) — replaces the hand-installed crontab line. |
| `hh-backup-freshness.{service,timer}` | **V2_NOTES §6** hourly freshness check driving `freshness.sh` → the dead-man. |
| `Dockerfile` | sidecar image: pg17 client tools + aws-cli + age + curl (freshness ping) |
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

### Builder prerequisites (credential custody — not automatable)

1. **AWS credentials for the host — instance profile. ✅ DONE + verified
   (2026-06-15).** A least-priv IAM role `hh-assistant-backup-ec2` (inline
   policy: List on `hh-assistant-backups-001467466089` + Get/Put/Delete/
   multipart on its objects) is created, **associated** with the instance, IMDS
   hop limit 2. The hardened egress firewall was blocking two paths the sidecar
   needs — both fixed in `infra/egress/nftables.sh` and applied on the host:
   the link-local IMDS allow (`169.254.169.254:80`) and the **S3-by-published-
   CIDR** set (S3 can't be allowlisted by DNS — see `docs/ops-drills.md`).
   Proven end-to-end: `aws s3 ls s3://hh-assistant-backups-001467466089/` from a
   container on `hh-assistant_egress` returns RC=0 using the instance role, and
   a non-listed host is still dropped. **No keys in `.env` — nothing to custody
   here.**
2. **Production age recipient. ✅ DONE (2026-06-15).** `BACKUP_AGE_RECIPIENT`
   (public key, builder-generated offline) is set in the host `.env`; the
   matching **private identity stays OFFLINE** (builder's password manager),
   needed only to restore. The sidecar now encrypts + ships.

The `host replication` pg_hba line (below) and the sidecar image build are
already done on the host (2026-06-15). **Continuous WAL archiving + the daily
base cron are live (see Bring-up).**

**Host-loss restore drill: PASS (2026-06-15).** `restore.sh into hh-restore`
run on a *different* machine (the dev Mac) against the real `pitr/` backups +
the builder's offline key reconstructed the production DB — full schema, 6
migrations, real rows (`reminders`=3, `sent_log`=5, latest write replayed
through WAL), promoted out of recovery. The restored superuser is `hh`, proving
it's genuinely the production cluster. Details in `docs/ops-drills.md`. **T45
is complete.**

### Bring-up — **LIVE on the host 2026-06-15**

`--env-file .env` and running from the repo root are **load-bearing**, not
optional: with `-f infra/...` the compose project directory is `infra/`, so all
relative paths (including the overlay's) and `${POSTGRES_PASSWORD}`
interpolation only resolve against the project `.env` when you point compose at
it. Run all of these from `/home/hh/hh-assistant`:

```
# 1. enable replication for the sidecar (idempotent; re-run after a rebuild)
infra/backup/enable-replication.sh
# 2. start the sidecar (continuous WAL streaming + ship)
docker compose --env-file .env -f infra/docker-compose.prod.yml \
               -f infra/backup/docker-compose.backup.yml up -d backup
# 3. base backups on hh's crontab — daily 03:00 UTC (installed on the host)
0 3 * * *  cd /home/hh/hh-assistant && docker compose --env-file .env \
           -f infra/docker-compose.prod.yml \
           -f infra/backup/docker-compose.backup.yml \
           run --rm backup backup.sh base >> backup-base.log 2>&1
```

### Automated wiring (V2_NOTES §6) — what's declarative now

The three open §6 items are now in-repo artifacts:

1. **Replication baked into initdb** (`initdb-replication.sh`, mounted into the
   postgres service in `docker-compose.prod.yml`). On a FRESH data dir it creates
   the least-priv `hh_backup` REPLICATION role and appends the `host replication`
   pg_hba line, so a rebuild / create-from-zero box streams WAL on first boot with
   no `enable-replication.sh` step. **It runs only on an empty PGDATA** — it
   cannot and does not touch the live prod data dir; that box stays wired for the
   `hh` role by the T45 `enable-replication.sh`.
2. **Base backups scheduled by a host timer** (`hh-backup-base.{service,timer}`,
   daily 03:00 UTC) — the declarative replacement for the crontab line above.
3. **Freshness surfaced to the dead-man** (`freshness.sh` +
   `hh-backup-freshness.{service,timer}`, hourly): pings a **second**
   healthchecks.io check (`BACKUP_FRESHNESS_PING_URL`, distinct from the process
   `DEADMAN_PING_URL`) — `<url>` when the latest base is within
   `BACKUP_MAX_AGE_HOURS` (default 30h), `<url>/fail` when stale/missing. The
   check alerts from outside if the fresh ping stops.

**Sidecar image (2026-06-28):** built + pushed by CI to
`ghcr.io/shem86/hh-assistant-backup` (same immutable tags as the app), pulled +
recreated on the host by `on-host-deploy.sh` — **no host-side `docker compose
build` anymore.** The old host-build was the lone exception to the CI→GHCR→pull
lifecycle and silently drifted (the image shipped *without* `freshness.sh`,
since both the Dockerfile `COPY` *and* `.dockerignore` had to know about it and
only the former did). `build:` is retained in the overlay so the restore drill /
dev can still build locally and tag it as the same GHCR ref offline.

Cloud-init (`infra/pulumi/cloud-init/user-data.yaml.tmpl`) installs + enables both
timers and starts the sidecar on a fresh box. **Operator steps remain** (this PR
does NOT touch the live host): on the existing prod box, install + enable the two
timers once (`install -m 0644 infra/backup/hh-backup-*.{service,timer}
/etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now
hh-backup-base.timer hh-backup-freshness.timer`), set
`BACKUP_FRESHNESS_PING_URL` in `.env` (create the second hc-ping check first),
disable the old crontab line, and let the next full rebuild pick up the initdb
bake. The existing prod sidecar keeps using the `hh` role (leave `BACKUP_PGUSER`
unset) until a rebuild migrates it to `hh_backup`.

**Verified live (2026-06-15):** slot `hh_backup` created, `pg_receivewal`
streaming (segments `…0003.age`/`…0004.age`, 16 MiB encrypted, shipped
automatically), and a base backup landed `base.tar.gz` (4.4 MB) + `pg_wal.tar.gz`
+ `MANIFEST` under `pitr/base/<ts>/`, all age-encrypted. The sidecar's
credentials come from the **EC2 instance role via IMDS** (no keys in `.env`);
`PGPASSWORD` is `${POSTGRES_PASSWORD}` interpolated from `.env` (one secret, not
duplicated). Two latent-bug fixes were needed first: the egress firewall had to
allow IMDS + S3-by-published-CIDR (`docs/ops-drills.md`), and the overlay's
relative paths (`context`/`env_file`) had to be authored against the project dir
`infra/` (they overshot to `/home/hh` when combined with the prod compose).

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
