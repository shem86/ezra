-- Backoffice SELECT-only role (BO-17). The read-only console connects through
-- THIS role (BACKOFFICE_DATABASE_URL), so a write is impossible at the DB layer
-- regardless of app code. Forward-only and idempotent — it re-runs on every
-- migrate-gate without error.
--
-- The role's PASSWORD is set OUT-OF-BAND (ALTER ROLE on the host, from the SSM
-- BACKOFFICE_DATABASE_URL — BO-21), NEVER hard-coded here: a migration is
-- committed to git, and a credential must never enter the repo (CLAUDE.md
-- "Never"). Created LOGIN-but-passwordless, so it cannot connect until the
-- password is set — fail-closed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hh_readonly') THEN
    CREATE ROLE hh_readonly LOGIN;
  END IF;
END
$$;

-- DBOS creates the `dbos` schema (journal) at launch; ensure it exists so the
-- grants + default privileges below apply even before the first launch on a
-- from-zero database. pgvector's `vector` type and semantic_memories live in
-- `public`. These are the only two schemas the console reads.
CREATE SCHEMA IF NOT EXISTS dbos;

GRANT USAGE ON SCHEMA public, dbos TO hh_readonly;

-- Read every existing table in both schemas...
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hh_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA dbos TO hh_readonly;

-- ...and every FUTURE table the app role creates — new migrations (public) and
-- DBOS's own tables (dbos), both created as the app superuser that runs this
-- migration. So the console keeps reading the journal across DBOS upgrades
-- without a follow-up grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO hh_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA dbos GRANT SELECT ON TABLES TO hh_readonly;
