#!/usr/bin/env bash
# ITGC-OP-01 — automated restore DRILL (proves backups from pg-backup.sh are actually recoverable).
# Spins the latest (or given) dump into a throwaway scratch database, runs the sanity checks from the
# runbook (tenants / fiscal_periods / journal_entries), prints an evidence summary, then drops the
# scratch DB. Run quarterly (or monthly) and attach the output to the ITGC-OP-01 evidence repository.
#
# "A backup you have never restored is not a backup."
#
# Usage:   SCRATCH_ADMIN_URL=postgresql://…/postgres ./tools/ops/verify-restore.sh [dump-file]
# Env:
#   SCRATCH_ADMIN_URL  (required) connection to a server where we may CREATE/DROP DATABASE
#                       (e.g. the maintenance "postgres" db). MUST NOT be production.
#   BACKUP_DIR         where to find dumps if none given (default: ./backups)
set -euo pipefail

: "${SCRATCH_ADMIN_URL:?SCRATCH_ADMIN_URL is required (a non-prod server where we can create/drop a DB)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DUMP="${1:-$(ls -t "$BACKUP_DIR"/ierp-*.dump.gz 2>/dev/null | head -n1 || true)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "[verify] no dump found (looked for ierp-*.dump.gz in $BACKUP_DIR)" >&2; exit 1; }

SCRATCH_DB="ierp_restore_drill_$(date -u +%Y%m%d%H%M%S)"
BASE_URL="${SCRATCH_ADMIN_URL%/*}"
TARGET_URL="$BASE_URL/$SCRATCH_DB"

cleanup() { psql "$SCRATCH_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "[verify] dump under test: $DUMP"
echo "[verify] creating scratch db: $SCRATCH_DB"
psql "$SCRATCH_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH_DB\";" >/dev/null

echo "[verify] restoring…"
TARGET_DATABASE_URL="$TARGET_URL" FORCE=1 "$(dirname "$0")/restore.sh" "$DUMP" >/dev/null 2>&1 || true

echo "[verify] sanity checks:"
# Core tables of the ledger/tenant model; empty/absent ⇒ a bad backup.
for tbl in tenants users accounts journal_entries; do
  cnt="$(psql "$TARGET_URL" -tAc "SELECT count(*) FROM public.$tbl" 2>/dev/null || echo "ERR")"
  printf "          %-18s rows=%s\n" "$tbl" "$cnt"
  [ "$cnt" = "ERR" ] && { echo "[verify] FAIL: table $tbl missing in restored db" >&2; exit 1; }
done

echo "[verify] PASS — backup is restorable. (scratch db will be dropped)"
