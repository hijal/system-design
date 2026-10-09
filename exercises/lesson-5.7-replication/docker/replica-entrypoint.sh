#!/bin/sh
# Replica: if the data directory is empty, take a full copy from the primary (pg_basebackup),
# then start as a standby. The -R flag writes standby.signal and primary_conninfo -
# meaning "I am a replica, I have to fetch WAL from this primary".
set -e
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h primary -p 5432 -U taskflow; do sleep 1; done
  PGPASSWORD=replicator pg_basebackup -h primary -p 5432 -U replicator -D "$PGDATA" -R -X stream -P
  chmod 0700 "$PGDATA"
fi
exec docker-entrypoint.sh postgres
