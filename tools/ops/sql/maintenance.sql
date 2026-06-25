-- Production database maintenance plan — autovacuum / analyze / reindex (NASDAQ readiness, Pillar 2).
-- Run ONCE by a DBA/superuser against the managed Postgres to apply per-table autovacuum tuning, then
-- schedule the recurring jobs (pg_cron section) if the extension is available on the managed instance.
--
-- This is intentionally NOT a Drizzle migration (lives under tools/ops/sql, NOT apps/api/drizzle): it sets
-- storage parameters / cluster-level cadence that are environment-specific, require elevated privileges, and
-- must never run inside the PGlite test harnesses (which execute every apps/api/drizzle/*.sql file).
--
-- Rationale: the hot OLTP tables (POS sales, tenders, GL lines, stock movements) take heavy INSERT/UPDATE
-- traffic at peak load. Default autovacuum (scale_factor 0.2 = 20% of the table) lets large tables accumulate
-- dead tuples / stale stats between runs → bloat + bad plans. We make autovacuum fire FAR more often on these
-- tables with low scale factors + flat thresholds, and keep planner stats fresh.

-- ─────────────────────────── 1. Per-table autovacuum tuning ───────────────────────────
-- High-churn financial / inventory hot path: vacuum at ~2% dead tuples, analyze at ~1%.
ALTER TABLE cust_pos_sales  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000,
                                 autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 500);
ALTER TABLE cust_pos_items  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000,
                                 autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 500);
ALTER TABLE payments        SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000,
                                 autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 500);
ALTER TABLE journal_entries SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
ALTER TABLE journal_lines   SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 2000);
ALTER TABLE stock_movements SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
ALTER TABLE lot_ledger      SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);
ALTER TABLE location_stock  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 1000);

-- Append-only audit log: rows are never UPDATE/DELETE'd (enforced by 0062_audit_log_immutable.sql), so there
-- are no dead tuples to vacuum for space — but frequent INSERTs still need VACUUM to advance the visibility
-- map (index-only scans) and ANALYZE to keep stats current for the audit viewer's range queries.
ALTER TABLE audit_log SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_vacuum_insert_threshold = 5000,
                           autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 1000);

-- ─────────────────────────── 2. Scheduled maintenance (pg_cron) ───────────────────────────
-- Requires the pg_cron extension (available on most managed Postgres). If unavailable, run the equivalent
-- statements from an external scheduler (cron / k8s CronJob) connecting as a maintenance role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    -- Nightly cluster-wide ANALYZE (03:15 Asia/Bangkok = 20:15 UTC) — keep planner stats fresh.
    PERFORM cron.schedule('nightly-analyze', '15 20 * * *', 'ANALYZE');
    -- Weekly off-peak REINDEX CONCURRENTLY of the heaviest indexes (Sunday 04:00 ICT = 21:00 UTC Sat) to
    -- reclaim index bloat without blocking writers. CONCURRENTLY cannot run inside a txn, hence per-statement.
    PERFORM cron.schedule('weekly-reindex-jl', '0 21 * * 6', 'REINDEX INDEX CONCURRENTLY idx_jl_entry');
    PERFORM cron.schedule('weekly-reindex-cps', '5 21 * * 6', 'REINDEX INDEX CONCURRENTLY idx_cps_tenant_date');
    PERFORM cron.schedule('weekly-reindex-pay', '10 21 * * 6', 'REINDEX INDEX CONCURRENTLY ux_payments_idem');
  ELSE
    RAISE NOTICE 'pg_cron not available — schedule ANALYZE / REINDEX CONCURRENTLY from an external scheduler.';
  END IF;
END $$;

-- ─────────────────────────── 3. Bloat monitoring (run ad-hoc / alerting) ───────────────────────────
-- Surfaces tables whose dead-tuple ratio is climbing despite autovacuum — investigate long-running txns
-- (they pin the xmin horizon and block vacuum) before manually VACUUM (FULL) during a maintenance window.
--   SELECT relname,
--          n_live_tup, n_dead_tup,
--          round(n_dead_tup::numeric / nullif(n_live_tup + n_dead_tup, 0) * 100, 1) AS dead_pct,
--          last_autovacuum, last_autoanalyze
--   FROM pg_stat_user_tables
--   WHERE n_dead_tup > 1000
--   ORDER BY dead_pct DESC NULLS LAST;
