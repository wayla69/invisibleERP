-- 0480 — Statistical honesty on measured lift (docs/62 Phase 3): the 95% CI bounds + the weak-evidence
-- flag land next to every realized lift (MKT-19 experiments, MKT-22 journeys, MKT-24 save runs) so a
-- +900% from n=2 is visibly weaker evidence than +12% from n=2,000. All three tables already carry
-- tenant_id + the canonical org RLS policy + grants — adding nullable columns needs no RLS/GRANT change
-- (0467 pattern). The flag never alters any downstream math; it is a display/report property.

ALTER TABLE mi_campaign_experiments ADD COLUMN IF NOT EXISTS lift_ci_low_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_campaign_experiments ADD COLUMN IF NOT EXISTS lift_ci_high_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_campaign_experiments ADD COLUMN IF NOT EXISTS weak_evidence boolean;
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS lift_ci_low_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS lift_ci_high_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS weak_evidence boolean;
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS lift_ci_low_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS lift_ci_high_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS weak_evidence boolean;
