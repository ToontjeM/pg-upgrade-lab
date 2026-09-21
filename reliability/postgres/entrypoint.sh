#!/bin/bash
# Wraps the official postgres image's own entrypoint so the same image can
# boot as either the primary or a streaming standby, chosen at container
# start via ROLE (see docker-compose.yml). Same technique as this project's
# sibling demo pgpooldemo/postgres/entrypoint.sh.
#
# Primary: falls straight through to docker-entrypoint.sh, which runs
# initdb + 10-init-publication.sh on first boot (see that script) and just
# starts postgres on every boot after.
#
# Standby: docker-entrypoint.sh only knows how to initdb a fresh node, not
# clone one -- so on a truly empty data directory this clones the primary
# via pg_basebackup first, using -C -S to also create the standby's own
# physical replication slot (STANDBY_SLOT) at clone time. Once that's done
# the directory is no longer "empty", so docker-entrypoint.sh recognizes it
# as already initialized and goes straight to starting postgres.
set -Eeo pipefail

if [ "${ROLE:-primary}" = "standby" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  : "${PRIMARY_HOST:?PRIMARY_HOST must be set for ROLE=standby}"
  : "${STANDBY_SLOT:?STANDBY_SLOT must be set for ROLE=standby}"

  echo "[pg-entrypoint] standby bootstrap: waiting for primary at $PRIMARY_HOST..."
  until gosu postgres pg_isready -h "$PRIMARY_HOST" -U replicator -d postgres -q; do
    sleep 2
  done

  mkdir -p "$PGDATA"
  chown -R postgres:postgres /var/lib/postgresql
  # Empty PGDATA's *contents*, not the directory itself: on PG16-and-earlier
  # images PGDATA (.../data) is the image's own declared VOLUME, so it's a
  # mountpoint -- `rm -rf "$PGDATA"` fails with "Device or resource busy".
  # On PG18+ the declared VOLUME moved up to the parent /var/lib/postgresql,
  # so PGDATA there is just a plain subdirectory -- emptying its contents
  # works identically either way, so one script covers both layouts.
  find "$PGDATA" -mindepth 1 -delete

  echo "[pg-entrypoint] primary is ready -- cloning via pg_basebackup..."
  # dbname=postgres in the connection string (not just host/user) matters on
  # PG17+: sync_replication_slots' background worker connects with a normal
  # libpq connection, not just the WAL streaming protocol, and needs a
  # dbname to connect with. pg_basebackup -R would otherwise write a
  # primary_conninfo with no dbname at all, and slot sync would silently
  # never start. Harmless to always include it, so this stays one script
  # for both PG16 (no slot sync feature to speak of) and PG18.
  gosu postgres pg_basebackup \
    -d "host=$PRIMARY_HOST user=replicator dbname=postgres application_name=$(hostname)" \
    -D "$PGDATA" -Fp -Xs -P -R -C -S "$STANDBY_SLOT"
  echo "[pg-entrypoint] base backup complete."
fi

exec docker-entrypoint.sh "$@"
