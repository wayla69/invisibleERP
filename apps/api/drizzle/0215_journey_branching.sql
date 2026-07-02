-- 0215_journey_branching — Phase H1 (docs/26): rule-based FORWARD-ONLY branch on journey steps. After a
-- step executes, if branch_rule (F1 whitelist) matches the member the enrollment jumps to branch_to_step
-- (> step_no, enforced at create — termination by construction). Additive nullable columns on an existing
-- tenant-scoped table (RLS already applies).
ALTER TABLE journey_steps ADD COLUMN IF NOT EXISTS branch_rule jsonb;
--> statement-breakpoint
ALTER TABLE journey_steps ADD COLUMN IF NOT EXISTS branch_to_step integer;
