-- 0113 — dunning delivery. Record the outcome of the dunning notice sent to the customer on each action.
-- (Columns on an existing tenant-scoped table — RLS already applies, no policy loop needed.)
ALTER TABLE ar_dunning_log ADD COLUMN IF NOT EXISTS message_status text;
--> statement-breakpoint
ALTER TABLE ar_dunning_log ADD COLUMN IF NOT EXISTS message_recipient text;
