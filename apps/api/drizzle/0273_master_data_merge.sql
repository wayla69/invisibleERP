-- 0273_master_data_merge — master-data audit Phase 5 (DQM: match-merge duplicate resolution). Oracle-grade
-- master data lets a steward MERGE a duplicate customer/vendor into a surviving record: the duplicate's
-- child rows (addresses, contacts, invoices, POs, AP txns, …) are repointed to the survivor and the
-- duplicate is soft-retired (status='merged') with a pointer back to the survivor + who/when, so the merge
-- is fully traceable and the historical record is never destroyed. Adds the merge-tracking columns and a
-- generic child-row repoint function.
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS merged_into bigint;
--> statement-breakpoint
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS merged_by text;
--> statement-breakpoint
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS merged_at timestamptz;
--> statement-breakpoint
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS merged_into bigint;
--> statement-breakpoint
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS merged_by text;
--> statement-breakpoint
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS merged_at timestamptz;
--> statement-breakpoint
-- Generic repoint: move every child row whose <p_id_col> equals the duplicate id onto the survivor id.
-- Discovers child tables by column name (same catalogue-driven pattern as the RLS loop, which PGlite runs),
-- so a newly-added child table is covered automatically as long as it uses the conventional customer_id /
-- vendor_id column. Runs SECURITY INVOKER, so RLS still scopes the UPDATEs to the caller's tenant. A unique-
-- constraint collision (both survivor and duplicate own a row with the same natural key) aborts the enclosing
-- transaction — the caller surfaces MERGE_CONFLICT for the steward to resolve rather than silently mangling.
CREATE OR REPLACE FUNCTION md_merge_repoint(p_id_col text, p_master text, p_survivor bigint, p_duplicate bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = p_id_col AND data_type = 'bigint' AND table_name <> p_master
  LOOP
    EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I = $2', r.table_name, p_id_col, p_id_col)
      USING p_survivor, p_duplicate;
  END LOOP;
END $$;
