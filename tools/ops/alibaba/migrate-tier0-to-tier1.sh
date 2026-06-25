#!/usr/bin/env bash
# One-time Tier 0 → Tier 1 cutover helper. Copies the single-host Postgres into ApsaraDB RDS, ensures
# the RLS roles/policies exist on RDS (so the policy restore won't fail), restores the data, verifies,
# then PRINTS the manual cutover steps (it does not edit your .env for you). Confirmation-gated.
#
#   TARGET_DATABASE_URL='postgresql://user:pw@<rds-host>:5432/invisible_erp_v2' \
#     bash tools/ops/alibaba/migrate-tier0-to-tier1.sh
#
# Reuses the shared tools/ops/pg-backup.sh + restore.sh and the api image's `db:migrate`. Untested
# against a live RDS in this repo — after it runs, ALWAYS confirm with a restore drill + /healthz.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OPS_DIR="$(cd "$HERE/.." && pwd)"                 # tools/ops
ENV_FILE="${ENV_FILE:-$HERE/.env}"
TIER1_COMPOSE="$HERE/docker-compose.tier1.yml"

: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL to the ApsaraDB RDS connection string}"
[ -f "$ENV_FILE" ] || { echo "[t0->t1] missing env file: $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${POSTGRES_USER:?}"; : "${POSTGRES_PASSWORD:?}"; : "${POSTGRES_DB:?}"

SRC_DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB}"
redact() { printf '%s' "$1" | sed -E 's#//[^@]*@#//***@#'; }

echo "[t0->t1] source (Tier 0): $(redact "$SRC_DB_URL")"
echo "[t0->t1] target (RDS):    $(redact "$TARGET_DATABASE_URL")"
if [ "${FORCE:-0}" != "1" ]; then
  printf "[t0->t1] this RESTORES Tier 0 data INTO the RDS target (destructive to target). Type 'yes': "
  read -r ans; [ "$ans" = "yes" ] || { echo "[t0->t1] aborted"; exit 1; }
fi

# 1) fresh logical dump of the running Tier 0 database (kept; not pruned)
BK_DIR="${BACKUP_DIR:-/var/backups/ierp}"; mkdir -p "$BK_DIR"
echo "[t0->t1] 1/5 dumping Tier 0…"
DATABASE_URL="$SRC_DB_URL" RETAIN_DAYS=9999 bash "$OPS_DIR/pg-backup.sh" "$BK_DIR"
DUMP="$(ls -t "$BK_DIR"/ierp-*.dump.gz | head -n1)"
echo "[t0->t1] dump: $DUMP"

# 2) create roles + RLS + schema baseline on RDS (idempotent) via the api image's drizzle migrations,
#    so the subsequent policy restore has app_user to reference.
echo "[t0->t1] 2/5 applying migrations on RDS (creates app_user role + RLS policies)…"
docker compose --env-file "$ENV_FILE" -f "$TIER1_COMPOSE" run --rm \
  -e DATABASE_URL="$TARGET_DATABASE_URL" -e RUN_MIGRATIONS=0 \
  --entrypoint sh api -c "pnpm --filter @ierp/api db:migrate"

# 3) restore the Tier 0 dump into RDS (app_user now exists from step 2)
echo "[t0->t1] 3/5 restoring data into RDS…"
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" FORCE=1 bash "$OPS_DIR/restore.sh" "$DUMP"

# 4) reconcile migration bookkeeping on RDS (idempotent no-op if the dump was already current)
echo "[t0->t1] 4/5 reconciling migrations on RDS…"
docker compose --env-file "$ENV_FILE" -f "$TIER1_COMPOSE" run --rm \
  -e DATABASE_URL="$TARGET_DATABASE_URL" -e RUN_MIGRATIONS=0 \
  --entrypoint sh api -c "pnpm --filter @ierp/api db:migrate"

# 5) sanity-check the core tables on RDS
echo "[t0->t1] 5/5 verifying core tables on RDS…"
for t in tenants users accounts journal_entries; do
  c="$(psql "$TARGET_DATABASE_URL" -tAc "SELECT count(*) FROM public.$t" 2>/dev/null || echo ERR)"
  printf "          %-18s rows=%s\n" "$t" "$c"
  [ "$c" = ERR ] && { echo "[t0->t1] FAIL: table $t missing on RDS" >&2; exit 1; }
done

cat <<EOF

[t0->t1] DATA COPIED + VERIFIED. Cutover steps (manual, reversible):
  1) edit $ENV_FILE — switch the app to RDS and re-point backups:
       DATABASE_URL=<the full RDS URL, with password>
       BACKUP_DB_URL=<the same RDS URL>                                   # backups now dump RDS
       DRILL_ADMIN_URL=postgresql://<rds-master>@<rds-host>:5432/postgres # restore-drill scratch on RDS
  2) start the Tier 1 stack (no local db container):
       docker compose --env-file $ENV_FILE -f $TIER1_COMPOSE up -d --build
  3) check health:  curl -fsS http://127.0.0.1:8000/healthz && echo ok
  4) run one restore drill against RDS, then stop the old Tier 0 db container:
       docker compose --env-file $ENV_FILE -f $HERE/docker-compose.tier0.yml stop db
     KEEP the 'pgdata' volume until the RDS drill has passed — that is your rollback.
EOF
