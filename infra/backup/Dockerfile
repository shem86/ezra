# Backup sidecar image (T17): Postgres 17 client tools (pg_basebackup,
# pg_receivewal) + aws-cli + age, carrying the backup scripts. It connects to
# the production `postgres` service over the internal network and ships
# encrypted base backups + archived WAL to S3.
#
# Built from postgres:17 purely for its matched client binaries — it runs no
# server. age + awscli come from Debian bookworm. No secrets baked in; the S3
# target, age recipient, and DB connection arrive at runtime (compose env_file).
FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends awscli age ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/hh-backup
COPY infra/backup/lib.sh infra/backup/backup.sh ./
RUN chmod +x backup.sh

# Default: stream WAL continuously and ship completed segments. Base backups
# run on a schedule via `docker compose ... run --rm backup base` (host cron) —
# see infra/backup/README.md.
ENTRYPOINT ["bash"]
CMD ["backup.sh", "receivewal"]
