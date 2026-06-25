-- 0121 — Lease modifications (IFRS 16 remeasurement). Track the ROU net book value explicitly so a
-- modification can remeasure the liability and adjust the ROU asset, then depreciate over the remaining
-- term. Backfill existing rows from initial_liability − accumulated_dep.
ALTER TABLE leases ADD COLUMN IF NOT EXISTS rou_nbv numeric(14,2) DEFAULT 0;
--> statement-breakpoint
UPDATE leases SET rou_nbv = coalesce(initial_liability,0) - coalesce(accumulated_dep,0) WHERE rou_nbv = 0 OR rou_nbv IS NULL;
