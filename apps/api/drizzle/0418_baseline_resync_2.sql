-- 0418_baseline_resync_2: snapshot-baseline resync #2 (docs/ops/drizzle-migration-debt.md §3/§4).
-- The schema is already fully created by 0000-0417; this migration exists ONLY to advance the
-- drizzle-kit generate snapshot baseline (meta/0418_snapshot.json). Deliberately a no-op, exactly
-- like 0129_baseline_resync. Snapshots are read by generate (dev tooling) only - never by
-- drizzle-kit migrate or the PGlite harnesses - so this has zero runtime/prod effect.
SELECT 1;
