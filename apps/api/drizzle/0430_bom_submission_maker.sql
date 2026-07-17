-- 0430_bom_submission_maker — SOX-ICFR audit finding #6 (maker-checker coverage). The BoM approval surface
-- `PATCH /api/bom/submissions/:id/approve` recorded no submitter identity, so a user holding both `cust_bom`
-- (submit) and `bom_master` (approve) — e.g. an Admin — could approve their own BoM submission, self-approving
-- product-costing master data with no SoD block. Record who submitted each BoM so the approve path can enforce
-- maker ≠ checker (assertMakerChecker, event bom.submission.approve). Plain column add on the tenant-scoped
-- table; no RLS change.
ALTER TABLE "bom_submissions" ADD COLUMN IF NOT EXISTS "submitted_by" text;
