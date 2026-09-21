#!/bin/bash
# Runs once, only on the node that actually performs initdb -- i.e. only the
# primary. Standbys never run this: they're cloned from the primary via
# pg_basebackup before the data directory would otherwise look "empty" to
# the official entrypoint (see entrypoint.sh), same as this project's
# sibling demo pgpooldemo/postgres/init-replication.sh.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-'EOSQL'
  CREATE ROLE replicator WITH REPLICATION LOGIN;

  CREATE TABLE demo_events (
    id serial PRIMARY KEY,
    note text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE PUBLICATION pub FOR TABLE demo_events;
EOSQL

# POSTGRES_HOST_AUTH_METHOD=trust already made the official entrypoint write
# a permissive pg_hba.conf for ordinary connections, but "all" as the
# database field there does not match replication connections -- those need
# their own explicit line.
echo "host replication replicator all trust" >> "$PGDATA/pg_hba.conf"
