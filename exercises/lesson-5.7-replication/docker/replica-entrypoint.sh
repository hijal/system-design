#!/bin/sh
# Replica: data directory খালি হলে primary থেকে পুরো কপি নাও (pg_basebackup),
# তারপর standby হিসেবে চালু হও। -R flag টা standby.signal আর primary_conninfo লিখে দেয় —
# মানে "আমি একটা replica, WAL আনতে হবে এই primary থেকে"।
set -e
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h primary -p 5432 -U taskflow; do sleep 1; done
  PGPASSWORD=replicator pg_basebackup -h primary -p 5432 -U replicator -D "$PGDATA" -R -X stream -P
  chmod 0700 "$PGDATA"
fi
exec docker-entrypoint.sh postgres
