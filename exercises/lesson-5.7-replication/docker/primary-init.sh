#!/bin/sh
# Runs once, when the primary starts for the first time (docker-entrypoint-initdb.d).
# A replication user and permission, so the replica can take the WAL stream.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
