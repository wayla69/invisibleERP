#!/usr/bin/env bash
# Idempotent bootstrap for an Alibaba Cloud ECS host (Ubuntu 22.04 LTS) → Invisible ERP "Tier 0".
# Installs Docker + compose plugin + postgresql-client + rclone, brings up the stack, and installs the
# hourly-backup + monthly-restore-drill cron jobs. Safe to re-run.
#
#   sudo bash tools/ops/alibaba/ecs-tier0-setup.sh
#
# Prereqs you do MANUALLY (see README.md): create tools/ops/alibaba/.env, configure the rclone "oss"
# remote (rclone config), open the security group (80/443/22 only), and point your domain at this host.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="$HERE/docker-compose.tier0.yml"
ENV_FILE="$HERE/.env"

[ "$(id -u)" = 0 ] || { echo "[setup] run as root (sudo)"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "[setup] create $ENV_FILE from .env.example first"; exit 1; }

# 1) Docker engine + compose plugin
if ! command -v docker >/dev/null 2>&1; then
  echo "[setup] installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "[setup] docker compose plugin missing"; exit 1; }

# 2) host tools: postgresql-client (host-side backups) + rclone (OSS offsite)
echo "[setup] installing postgresql-client + rclone…"
apt-get update -y
apt-get install -y postgresql-client rclone

# 3) load env (for BACKUP_DIR) and ensure backup dir exists
set -a; . "$ENV_FILE"; set +a
mkdir -p "${BACKUP_DIR:-/var/backups/ierp}"

# 4) build + start the stack (api applies migrations on boot via RUN_MIGRATIONS=1, single-node only)
echo "[setup] building & starting the Tier 0 stack…"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE" up -d --build

# 5) install cron jobs (replace any previous ierp entries)
CRON_BK="0 * * * * ENV_FILE=$ENV_FILE bash $HERE/backup-cron.sh >> /var/log/ierp-backup.log 2>&1"
CRON_DR="0 3 1 * * ENV_FILE=$ENV_FILE bash $HERE/restore-drill-cron.sh >> /var/log/ierp-restore-drill.log 2>&1"
( crontab -l 2>/dev/null | grep -vF 'ierp-backup.log' | grep -vF 'ierp-restore-drill.log'; \
  echo "$CRON_BK"; echo "$CRON_DR" ) | crontab -
echo "[setup] cron installed: hourly backup + monthly restore drill"

cat <<EOF

[setup] DONE. Verify:
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps
  curl -fsS http://127.0.0.1:8000/healthz && echo "  api ok"
  curl -fsSI https://\${CADDY_SITE_ADDRESS:-your-domain} | head -1   # after DNS + TLS

Still TODO (manual, one-time):
  - rclone config        → remote name "oss" (type=s3, provider=Alibaba, internal endpoint)
  - DNS A record         → this host's public IP (Caddy then auto-provisions HTTPS)
  - security group       → allow 80, 443, 22 inbound only (NOT 5432/8000)
  - back up APP_ENC_KEY  → store it somewhere safe & separate from the DB
EOF
