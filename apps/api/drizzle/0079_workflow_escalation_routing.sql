-- 0079 — Approval-workflow enhancements (Phase 2): SLA + escalation, dimension-based step routing, and the
-- per-instance context/deadline the engine needs to evaluate them. All columns added to existing (already
-- RLS-scoped) workflow tables → no RLS loop needed.

-- per-definition default SLA (hours) for each step unless the step overrides it
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS sla_hours integer;
--> statement-breakpoint

-- step-level SLA override + escalation fallback + dimension condition (match_key=match_value vs instance context)
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS sla_hours integer;
--> statement-breakpoint
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS escalate_to_role text;
--> statement-breakpoint
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS escalate_to_user text;
--> statement-breakpoint
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS match_key text;
--> statement-breakpoint
ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS match_value text;
--> statement-breakpoint

-- per-instance dimension context (cost_center / category / branch / department …) + the current step's
-- SLA deadline and escalation state
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS context jsonb;
--> statement-breakpoint
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS due_at timestamptz;
--> statement-breakpoint
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS escalated boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE workflow_instances ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
