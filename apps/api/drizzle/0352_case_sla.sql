-- 0352_case_sla — SVC-5 (Service Cloud): per-case Entitlements / SLA policy (SVC-05 control). Extends the SVC-4
-- service_cases object with service-level commitments so a support case's first-response and resolution due
-- times are computed from its entitlement tier, breaches are flagged, and a breach worklist surfaces cases that
-- are slipping. Additive nullable/defaulted columns on the existing (already RLS-scoped) service_cases table —
-- no new table, so no RLS DO-loop or new index is needed; existing inserts are unaffected. Idempotent.
ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS sla_tier text NOT NULL DEFAULT 'Standard';
--> statement-breakpoint
ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS first_response_due_at timestamptz;
--> statement-breakpoint
ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS resolution_due_at timestamptz;
--> statement-breakpoint
ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS first_responded_at timestamptz;
--> statement-breakpoint
ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS response_breached boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS resolution_breached boolean NOT NULL DEFAULT false;
