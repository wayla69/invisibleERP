#!/usr/bin/env bash
# ITGC-OP-01 — restore a dump produced by pg-backup.sh (ierp-<stamp>.dump.gz, custom format).
# Restores into TARGET_DATABASE_URL. Destructive to the target, so it requires explicit confirmation
# unless FORCE=1. Pairs with pg-backup.sh (backup) and verify-restore.sh (drill).
#
# Usage:   TARGET_DATABASE_URL=postgresql://… ./tools/ops/restore.sh path/to/ierp-<stamp>.dump.gz
# Env:
#   TARGET_DATABASE_URL  (required) where to restore (NEVER point this at prod by accident)
#   FORCE=1              skip the interactive confirmation (used by the automated drill)
#   JOBS                 parallel restore workers (default 4)
set -euo pipefail

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
DUMP="${1:?usage: restore.sh <dump-file (.dump or .dump.gz)>}"
JOBS="${JOBS:-4}"
[ -f "$DUMP" ] || { echo "[restore] no such file: $DUMP" >&2; exit 1; }

if [ "${FORCE:-0}" != "1" ]; then
  echo "[restore] WARNING: this will restore into:"
  echo "          $(echo "$TARGET_DATABASE_URL" | sed -E 's#//[^@]*@#//***@#')"
  printf "          Type 'yes' to continue: "
  read -r ans
  [ "$ans" = "yes" ] || { echo "[restore] aborted"; exit 1; }
fi

# Decompress gzip dumps to a temp file pg_restore can read.
WORK="$DUMP"; TMP=""
case "$DUMP" in
  *.gz) TMP="$(mktemp --suffix=.dump)"; echo "[restore] gunzip → $TMP"; gunzip -c "$DUMP" > "$TMP"; WORK="$TMP" ;;
esac
cleanup() { [ -n "$TMP" ] && rm -f "$TMP"; }
trap cleanup EXIT

echo "[restore] restoring $DUMP → target (clean, if-exists)…"
# --clean --if-exists drops objects before recreating so a re-run is idempotent.
pg_restore --clean --if-exists --no-owner --no-privileges -j "$JOBS" -d "$TARGET_DATABASE_URL" "$WORK"

echo "[restore] done. If restoring into a brand-new cluster, run db:migrate to (re)create the app_user"
echo "          role + RLS policies before pointing the app at it (see tools/ops/BACKUP-RUNBOOK.md)."
