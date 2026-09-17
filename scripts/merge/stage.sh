#!/usr/bin/env bash
# Runs ON tgbgaws (piped over ssh by merge-copy.sh): copies one application's rows into
# Supabase's merge_stage.rows as JSON. Rows never leave the server.
#
#   stage.sh portal                 rows from gbg (Postgres)
#   stage.sh amc [snapshot-path]    rows from a SQLite snapshot; without a path a fresh one is
#                                   taken with SQLite's online backup (safe while AMC writes)
set -euo pipefail

APP="${1:?portal|amc}"
SUPA=supabase-db-x123f7phha4w5nas4dtq2k50
GBG=g13ju6epg6wnum4nabolt8se
AMC_DB=/data/amc/reminders.db

# This script arrives on stdin (bash -s), so a command that does not read a pipe must not
# inherit stdin, or it would swallow the rest of the script.
supa() { docker exec -i "$SUPA" psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -q "$@"; }   # reads a pipe/heredoc
supa_c() { docker exec "$SUPA" psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -q "$@" </dev/null; }

supa <<'SQL'
CREATE SCHEMA IF NOT EXISTS merge_stage;
REVOKE ALL ON SCHEMA merge_stage FROM PUBLIC;
CREATE TABLE IF NOT EXISTS merge_stage.rows (src text NOT NULL, tbl text NOT NULL, row jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS rows_src_tbl ON merge_stage.rows (src, tbl);
SQL

if [ "$APP" = portal ]; then
  supa_c -c "DELETE FROM merge_stage.rows WHERE src = 'gbg'"
  gbg() { docker exec "$GBG" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d gbg -q "$@"' sh "$@" </dev/null; }
  TABLES=$(gbg -Atc "select tablename from pg_tables where schemaname = 'public'
                     and tablename not in ('customers','assets','zuper_records','zuper_webhook_events','zuper_sync_runs')
                     order by 1")
  for t in $TABLES; do
    gbg -c "COPY (SELECT 'gbg', '$t', row_to_json(x)::text FROM public.\"$t\" x) TO STDOUT" \
      | supa -c "COPY merge_stage.rows (src, tbl, row) FROM STDIN"
  done
  # The retired mirror: only what is needed to translate its ids — no customer data.
  gbg -c "COPY (SELECT 'gbg', 'customers', json_build_object('id', id, 'zuper_customer_uid', zuper_customer_uid)::text FROM public.customers) TO STDOUT" \
    | supa -c "COPY merge_stage.rows (src, tbl, row) FROM STDIN"
  gbg -c "COPY (SELECT 'gbg', 'assets', json_build_object('id', id, 'zuper_asset_uid', zuper_asset_uid)::text FROM public.assets) TO STDOUT" \
    | supa -c "COPY merge_stage.rows (src, tbl, row) FROM STDIN"
  gbg -c "COPY (SELECT 'gbg', '__drizzle_migrations', row_to_json(x)::text FROM drizzle.__drizzle_migrations x) TO STDOUT" \
    | supa -c "COPY merge_stage.rows (src, tbl, row) FROM STDIN"
  supa_c -Atc "SELECT 'staged from gbg: ' || count(*) || ' rows in ' || count(DISTINCT tbl) || ' tables' FROM merge_stage.rows WHERE src = 'gbg'"

elif [ "$APP" = amc ]; then
  SNAP="${2:-}"
  if [ -z "$SNAP" ]; then
    mkdir -p "$HOME/merge-snapshots" && chmod 700 "$HOME/merge-snapshots"
    SNAP="$HOME/merge-snapshots/amc-reminders-$(date -u +%Y%m%dT%H%M%SZ).db"
    sudo sqlite3 "$AMC_DB" ".backup '$SNAP'" </dev/null
    sudo chown "$(id -u):$(id -g)" "$SNAP" && chmod 600 "$SNAP"
  fi
  [ "$(sqlite3 "$SNAP" 'pragma integrity_check;' </dev/null)" = ok ] || { echo "snapshot failed its integrity check: $SNAP" >&2; exit 1; }
  echo "snapshot: $SNAP"
  supa_c -c "DELETE FROM merge_stage.rows WHERE src = 'amc'"
  TABLES=$(sqlite3 "$SNAP" </dev/null "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'
                            and name not in ('zuper_jobs','zuper_job_assignees','zuper_webhook_events') order by 1")
  for t in $TABLES; do
    COLS=$(sqlite3 "$SNAP" </dev/null "select group_concat(quote(name) || ', \"' || name || '\"', ', ') from pragma_table_info('$t')")
    sqlite3 -csv "$SNAP" </dev/null "select 'amc', '$t', json_object($COLS) from \"$t\"" \
      | supa -c "COPY merge_stage.rows (src, tbl, row) FROM STDIN WITH (FORMAT csv)"
  done
  supa_c -Atc "SELECT 'staged from AMC: ' || count(*) || ' rows in ' || count(DISTINCT tbl) || ' tables' FROM merge_stage.rows WHERE src = 'amc'"
else
  echo "unknown app: $APP" >&2; exit 2
fi
