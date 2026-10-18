#!/bin/bash
set -euo pipefail
export PGDATA=/var/lib/postgresql/data/restore
initdb -D "$PGDATA" -U supabase_admin --auth-local=trust --auth-host=reject \
  --locale-provider=icu --icu-locale=en_US.UTF-8 --encoding=UTF8
exec postgres -D "$PGDATA" \
  -c listen_addresses= -c unix_socket_directories=/tmp \
  -c shared_preload_libraries=pg_cron,pg_stat_statements,pg_net \
  -c pg_net.database_name=postgres \
  -c cron.database_name=anarosa_restore -c cron.launch_active_jobs=off \
  -c shared_buffers=32MB -c max_connections=20 -c work_mem=2MB \
  -c maintenance_work_mem=16MB -c max_wal_size=128MB -c min_wal_size=32MB
