-- 0423_project_tagged_waste.sql — A5 (docs/50 Wave 5): project-tagged wastage.
-- waste_log gains an OPTIONAL project dimension (project_id / boq_line_id): a project-tagged, costed waste
-- relieves PROJECT WIP (Dr 5810 waste loss / Cr 1260 with the project_id line dimension) instead of
-- inventory (Cr 1200), and feeds the per-BoQ-line "wasted" figure in the material control tower + the
-- EVM-by-category material lens. Columns only — the table already carries tenant_id + RLS from 0150, so
-- no policy change is needed. Untagged waste is byte-identical to before.
ALTER TABLE "waste_log" ADD COLUMN IF NOT EXISTS "project_id" bigint;
ALTER TABLE "waste_log" ADD COLUMN IF NOT EXISTS "boq_line_id" bigint;
CREATE INDEX IF NOT EXISTS "idx_waste_log_project" ON "waste_log" ("tenant_id", "project_id");
