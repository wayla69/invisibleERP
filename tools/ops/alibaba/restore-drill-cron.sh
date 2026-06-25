#!/usr/bin/env bash
# Monthly Tier 0 restore DRILL (cron) — ITGC-OP-01 evidence. "A backup you have never restored is not
# a backup." Loads the host .env and runs the shared tools/ops/verify-restore.sh, which restores the
# latest local dump into a throwaway scratch database, sanity-checks core tables, then drops it.
#
# Tier 0 caveat: the scratch DB is created on the SAME Postgres server as production (a separate,
# throwaway database — it never touches the prod database). It adds brief load during the drill; for a
# stricter boundary, point SCRATCH_ADMIN_URL at a separate scratch instance.
#
#   Cron (installed by ecs-tier0-setup.sh):
#     0 3 1 * * ENV_FILE=/path/.env bash /path/restore-drill-cron.sh >> /var/log/ierp-restore-drill.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OPS_DIR="$(cd "$HERE/.." && pwd)"          # tools/ops
ENV_FILE="${ENV_FILE:-$HERE/.env}"
[ -f "$ENV_FILE" ] || { echo "[drill] missing env file: $ENV_FILE" >&2; exit 1; }

set -a; . "$ENV_FILE"; set +a

# Maintenance DB where verify-restore.sh may CREATE/DROP a throwaway scratch database.
# Tier 1 (RDS): set DRILL_ADMIN_URL to the RDS master pointed at the "postgres" db.
# Tier 0 (local db container): leave it unset → use the localhost-bound port.
if [ -n "${DRILL_ADMIN_URL:-}" ]; then
  ADMIN_URL="$DRILL_ADMIN_URL"
else
  : "${POSTGRES_USER:?}"; : "${POSTGRES_PASSWORD:?}"
  ADMIN_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/postgres"
fi

echo "[drill] $(date -u +%FT%TZ) starting monthly restore drill"
SCRATCH_ADMIN_URL="$ADMIN_URL" \
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ierp}" \
  bash "$OPS_DIR/verify-restore.sh"
echo "[drill] done — capture this output as ITGC-OP-01 evidence (see tools/ops/BACKUP-RUNBOOK.md)"
