-- 0274_master_data_change_log — master-data audit Phase 6 (universal change history + onboarding trail).
-- ITGC-AC-14 gave financially-significant tables a DB-trigger field-level before/after change log
-- (data_change_log, migration 0116) that app code cannot bypass. The master-data tables (customer + vendor
-- master and their address/contact children) were NOT covered — so a change to a customer's credit terms, a
-- vendor's payment terms, or a contact was invisible to the change-history viewer, and a record's ONBOARDING
-- (its INSERT) left no field-level trail. This attaches the SAME generic capture trigger (log_data_change(),
-- already defined in 0116 — reused verbatim) to the six master tables, so every create/update/delete on them
-- is captured append-only at the database layer, including who onboarded the record and when. No new table:
-- data_change_log (tenant_ref, not tenant_id → intentionally outside the RLS loop; admin-/steward-gated reads)
-- and its append-only guard already exist.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['customer_master','vendors','customer_addresses','customer_contacts','vendor_addresses','vendor_contacts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_dcl_%I ON public.%I', r, r);
    EXECUTE format('CREATE TRIGGER trg_dcl_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION log_data_change()', r, r);
  END LOOP;
END $$;
