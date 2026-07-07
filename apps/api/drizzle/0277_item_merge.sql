-- 0277_item_merge — master-data audit Phase 11 (DQM for the ITEM master: match-merge duplicate resolution).
-- `items` is a SHARED master (no tenant_id; natural key is the TEXT `item_id`, referenced by ~17 child tables
-- via their own text `item_id` column — NOT the bigint pk). Merging a duplicate item into a survivor therefore
-- repoints the duplicate's child rows by the TEXT key and soft-retires the duplicate (status='merged' + a
-- pointer back to the survivor + who/when), so the merge is fully traceable and the history is never destroyed.
-- Because a merge rewrites transactions across EVERY tenant, the service gates it to the platform owner (god).
ALTER TABLE items ADD COLUMN IF NOT EXISTS merged_into bigint;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS merged_by text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS merged_at timestamptz;
--> statement-breakpoint
-- Text-key sibling of md_merge_repoint (0273): move every child row whose TEXT <p_id_col> equals the
-- duplicate's natural key onto the survivor's natural key. Discovers child tables by column name (same
-- catalogue-driven pattern as the RLS loop, which PGlite runs), so a newly-added child table is covered
-- automatically as long as it uses the conventional text `item_id` column. Excludes the master itself so the
-- duplicate's own identity row is untouched (it is soft-retired by the caller). A unique-constraint collision
-- (survivor and duplicate both own a row with the same natural key) aborts the enclosing transaction — the
-- caller surfaces MERGE_CONFLICT for manual resolution rather than silently mangling. SECURITY INVOKER; the
-- god caller carries the RLS bypass so the repoint reaches child rows in every tenant.
CREATE OR REPLACE FUNCTION md_merge_repoint_text(p_id_col text, p_master text, p_survivor text, p_duplicate text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = p_id_col AND data_type IN ('text', 'character varying') AND table_name <> p_master
  LOOP
    EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I = $2', r.table_name, p_id_col, p_id_col)
      USING p_survivor, p_duplicate;
  END LOOP;
END $$;
