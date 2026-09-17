#!/usr/bin/env bash
# Copy one application's own data into Supabase (portal.* or amc.*). See docs/DATABASE-MERGE.md.
#
#   scripts/merge/merge-copy.sh portal            dry run: stage, load, report, ROLL BACK
#   scripts/merge/merge-copy.sh portal --apply    the same, then COMMIT
#   scripts/merge/merge-copy.sh amc [--apply] [--snapshot /home/ubuntu/merge-snapshots/x.db]
#
# Everything runs on tgbgaws. The staged rows (they include password hashes) are deleted
# again at the end, whether or not the load committed. Needs migrations 0004–0006.
set -euo pipefail

APP="${1:?portal|amc}"; shift
APPLY=0; SNAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --snapshot) SNAP="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
HERE="$(cd "$(dirname "$0")" && pwd)"
SSH="ssh -o ServerAliveInterval=15 tgbgaws"
PSQL="docker exec -i supabase-db-x123f7phha4w5nas4dtq2k50 psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -q"
case "$APP" in
  portal) SRC=gbg; LOAD="$HERE/load-portal.sql" ;;
  amc)    SRC=amc; LOAD="$HERE/load-amc.sql" ;;
  *) echo "unknown app: $APP" >&2; exit 2 ;;
esac

cleanup() { echo "DELETE FROM merge_stage.rows WHERE src = '$SRC';" | $SSH "$PSQL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== staging $APP"
$SSH "bash -s -- $APP $SNAP" < "$HERE/stage.sh"

echo "== loading $APP ($([ $APPLY = 1 ] && echo 'APPLY — will commit' || echo 'dry run — will roll back'))"
{
  echo "\\set ON_ERROR_STOP 1"
  echo "BEGIN;"
  cat "$LOAD"
  if [ $APPLY = 1 ]; then echo "COMMIT;"; else echo "ROLLBACK;"; fi
} | $SSH "$PSQL"

echo "== done ($([ $APPLY = 1 ] && echo committed || echo 'rolled back — nothing changed'))"
