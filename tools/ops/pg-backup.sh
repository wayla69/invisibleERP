#!/usr/bin/env bash
# Postgres logical backup for Invisible ERP (Railway / any Postgres).
# Usage:  DATABASE_URL=postgres://… ./pg-backup.sh [OUT_DIR]
# Cron:   0 * * * *  DATABASE_URL=… /path/pg-backup.sh /var/backups/ierp >> /var/log/ierp-backup.log 2>&1
#
# Produces a compressed custom-format dump (pg_restore-friendly) named ierp-YYYYMMDD-HHMMSS.dump.gz,
# verifies it is restorable (pg_restore --list), and prunes dumps older than RETAIN_DAYS (default 14).
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
OUT_DIR="${1:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
mkdir -p "$OUT_DIR"

ts="$(date -u +%Y%m%d-%H%M%S)"
dump="$OUT_DIR/ierp-$ts.dump"

echo "[backup] $ts → $dump"
# -Fc = custom format (compressed, selective restore); --no-owner/--no-privileges = portable across roles
pg_dump --no-owner --no-privileges -Fc "$DATABASE_URL" -f "$dump"

# integrity gate: a dump that pg_restore can't read its TOC of is worthless — fail loudly
if ! pg_restore --list "$dump" >/dev/null; then
  echo "[backup] FATAL: dump failed pg_restore --list integrity check" >&2
  rm -f "$dump"; exit 1
fi

gzip -f "$dump"
echo "[backup] ok: ${dump}.gz ($(du -h "${dump}.gz" | cut -f1))"

# optional offsite upload (set BACKUP_S3=s3://bucket/prefix and have awscli/rclone configured)
if [ -n "${BACKUP_S3:-}" ]; then
  if command -v aws >/dev/null; then aws s3 cp "${dump}.gz" "${BACKUP_S3}/";
  elif command -v rclone >/dev/null; then rclone copy "${dump}.gz" "${BACKUP_S3#s3://}";
  else echo "[backup] WARN: BACKUP_S3 set but no aws/rclone found"; fi
fi

# optional offsite upload to Alibaba Cloud OSS via a preconfigured rclone remote
# (BACKUP_OSS=remote:bucket/prefix, e.g. oss:ierp-backups/prod — see tools/ops/alibaba/)
if [ -n "${BACKUP_OSS:-}" ]; then
  if command -v rclone >/dev/null; then rclone copy "${dump}.gz" "${BACKUP_OSS}";
  else echo "[backup] WARN: BACKUP_OSS set but rclone not found"; fi
fi

# retention
find "$OUT_DIR" -name 'ierp-*.dump.gz' -type f -mtime "+${RETAIN_DAYS}" -print -delete
echo "[backup] done; retained last ${RETAIN_DAYS}d"
