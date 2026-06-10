# Infra

## Dev database

One Postgres instance with pgvector (`docker compose up -d` at the repo root).
DBOS journal, structured state, and pgvector deliberately co-reside in a single
instance — transactional steps need state writes and step records to commit
atomically (architecture decision 3), so dev must not split what prod co-locates.

Connection string for local runs and integration tests: see `.env.example`
(`DATABASE_URL`). Integration tests are skipped entirely when `DATABASE_URL`
is unset.

## Local container runtime

The dev Mac runs containers via **Colima** (QEMU). It is occasionally flaky;
**CI (Linux) is the arbiter** for anything container-dependent — a local
container failure is an environment problem until CI reproduces it.
