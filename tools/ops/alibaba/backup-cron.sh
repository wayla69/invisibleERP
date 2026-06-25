#!/usr/bin/env bash
# Hourly Tier 0 backup wrapper (cron). Loads the host .env, then runs the shared, battle-tested
# tools/ops/pg-backup.sh against the dockerized Postgres (via its localhost-bound port) and pushes
# an offsite copy to Alibaba Cloud OSS. Pruning + integrity gate live in pg-backup.sh.
#
#   Cron (installed by ecs-tier0-setup.sh):
#     0 * * * * ENV_FILE=/path/.env bash /path/backup-cron.sh >> /var/log/ierp-backup.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OPS_DIR="$(cd "$HERE/.." && pwd)"          # tools/ops
ENV_FILE="${ENV_FILE:-$HERE/.env}"
[ -f "$ENV_FILE" ] || { echo "[backup-cron] missing env file: $ENV_FILE" >&2; exit 1; }

set -a; . "$ENV_FILE"; set +a

# Tier 1 (external RDS): set BACKUP_DB_URL to the RDS connection string.
# Tier 0 (local db container): leave it unset → connect over the localhost-bound port.
if [ -n "${BACKUP_DB_URL:-}" ]; then
  SRC_DB_URL="$BACKUP_DB_URL"
else
  : "${POSTGRES_USER:?}"; : "${POSTGRES_PASSWORD:?}"; : "${POSTGRES_DB:?}"
  SRC_DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB}"
fi

echo "[backup-cron] $(date -u +%FT%TZ) starting hourly backup"
DATABASE_URL="$SRC_DB_URL" \
BACKUP_OSS="${BACKUP_OSS:-}" \
RETAIN_DAYS="${RETAIN_DAYS:-14}" \
  bash "$OPS_DIR/pg-backup.sh" "${BACKUP_DIR:-/var/backups/ierp}"
echo "[backup-cron] done"
