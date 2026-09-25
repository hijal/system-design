#!/bin/sh
# Primary প্রথমবার চালু হওয়ার সময় একবার চলে (docker-entrypoint-initdb.d)।
# Replica যাতে WAL stream নিতে পারে, তার জন্য একটা replication user আর অনুমতি।
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
