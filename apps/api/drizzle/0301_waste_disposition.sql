-- 0301_waste_disposition — Waste ledger: reason/disposition taxonomy + void-fired-item capture (POS-5a, INV-15).
-- Extends the existing waste_log (migration 0149, control INV-10) — this is NOT a parallel ledger.
--  (1) `disposition` — WHAT happened to the wasted stock (discard | compost | donate | staff_meal |
--      rework | return_supplier), distinct from `reason_code` (WHY it was wasted). FA-style reason coding.
--  (2) `source` — HOW the waste was captured: manual (kitchen log), void_fire (a cancelled/voided fired
--      KDS ticket line — its recipe ingredients are written off), or spoilage.
--  (3) `ref_doc` — the originating document (e.g. the voided sale/ticket no) for the audit trail.
-- waste_log already carries tenant_id and RLS (0149 + the canonical 0232 loop re-applied by later
-- migrations), so a COLUMN add needs no new RLS loop. Nullable — existing rows keep NULL (legacy = discard).
ALTER TABLE waste_log ADD COLUMN IF NOT EXISTS disposition text;
--> statement-breakpoint
ALTER TABLE waste_log ADD COLUMN IF NOT EXISTS source text;
--> statement-breakpoint
ALTER TABLE waste_log ADD COLUMN IF NOT EXISTS ref_doc text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_waste_log_disposition ON waste_log (tenant_id, disposition);
