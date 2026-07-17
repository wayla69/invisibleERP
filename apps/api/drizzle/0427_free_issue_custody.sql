-- 0427_free_issue_custody — subcontractor FREE-ISSUE material custody (docs/50 Track A parked item,
-- unblocked by A1's return mechanics; NEW control PROJ-28). Company-owned material issued to a
-- SUBCONTRACTOR for use in their contracted scope rides the existing reservation spine (reserve →
-- issue-to-project Dr 1260/Cr 1200 → A1 governed return), now stamped with the subcontract so the
-- material is TRACKED IN THE SUBCONTRACTOR'S CUSTODY until returned (MRET) or its consumption is
-- acknowledged; final subcontract certification is blocked while custody is uncleared
-- (FREE_ISSUE_CUSTODY_OPEN). Columns only — stock_reservations already carries tenant_id + RLS.
ALTER TABLE "stock_reservations" ADD COLUMN IF NOT EXISTS "subcontract_id" bigint;
--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD COLUMN IF NOT EXISTS "custody_ack_qty" numeric(18,4) DEFAULT '0';
--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD COLUMN IF NOT EXISTS "custody_ack_by" text;
--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD COLUMN IF NOT EXISTS "custody_ack_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stock_res_subcontract" ON "stock_reservations" ("tenant_id", "subcontract_id");
