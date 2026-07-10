#!/usr/bin/env sh
# Store Hub — nightly local backup (docs/41 Phase 4b; DR/BCP `docs/ops/dr-bcp-plan.md` scenario 6).
#
# The hub DB is the store's operational state between pushes: table/KDS state, the open till, and —
# critically — any sale that has NOT yet replayed to the cloud (see hub_push_log). Losing the box
# before a push therefore loses revenue evidence, so the box keeps its own dumps.
#
# Runs inside the `db` container network via the hub-backup compose service:
#   docker compose --profile backup run --rm hub-backup
# Cron it nightly (after close), keep BACKUP_KEEP_DAYS of dumps, and copy them OFF the box.
set -eu

: "${HUB_DB_PASSWORD:?set HUB_DB_PASSWORD}"
DIR="${BACKUP_DIR:-/backup}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/hub-$STAMP.dump.gz"

mkdir -p "$DIR"
echo "→ dumping ierp_hub to $OUT"
PGPASSWORD="$HUB_DB_PASSWORD" pg_dump -h db -U ierp -d ierp_hub -Fc | gzip -9 > "$OUT.part"
mv "$OUT.part" "$OUT"

# Verify the dump is readable before trusting it (a silently-truncated dump is worse than none).
if ! gzip -t "$OUT"; then echo "❌ dump failed gzip integrity check"; rm -f "$OUT"; exit 1; fi
SIZE=$(wc -c < "$OUT")
if [ "$SIZE" -lt 1024 ]; then echo "❌ dump suspiciously small ($SIZE bytes)"; exit 1; fi
echo "✅ dump ok ($SIZE bytes)"

# Report the un-replayed backlog this dump protects — the number that matters if the box dies.
PENDING=$(PGPASSWORD="$HUB_DB_PASSWORD" psql -h db -U ierp -d ierp_hub -tAc \
  "SELECT count(*) FROM cust_pos_sales s LEFT JOIN hub_push_log l
     ON l.tenant_id = s.tenant_id AND l.hub_sale_no = s.sale_no AND l.status <> 'failed'
   WHERE s.status = 'Completed' AND l.id IS NULL" 2>/dev/null || echo '?')
echo "   un-replayed sales protected by this dump: $PENDING"

echo "→ pruning dumps older than ${KEEP}d"
find "$DIR" -name 'hub-*.dump.gz' -type f -mtime "+$KEEP" -print -delete || true

# Optional offsite copy: any rsync/scp target reachable when the internet is up.
if [ -n "${BACKUP_OFFSITE_TARGET:-}" ]; then
  echo "→ copying offsite: $BACKUP_OFFSITE_TARGET"
  scp -o StrictHostKeyChecking=accept-new "$OUT" "$BACKUP_OFFSITE_TARGET" && echo "✅ offsite copy ok" \
    || echo "⚠ offsite copy failed — the local dump is retained"
fi
