-- 0360_revrec_contract_modifications — Track D Wave 3 (control REV-26): contract modifications under
-- TFRS 15 / IFRS 15 / ASC 606 §18-21. When a contract changes (added/changed goods or services, or a price
-- change), the change is CLASSIFIED as exactly one of three and accounted for accordingly:
--   • separate_contract (§20)   — added goods DISTINCT AND at their standalone selling price (SSP) ⇒ a NEW
--                                 independent contract; the original is untouched.
--   • prospective (§21a)        — distinct but NOT at SSP ⇒ terminate old + create new: re-allocate the
--                                 remaining (unrecognized) transaction price over the remaining POs; NO catch-up.
--   • cumulative_catchup (§21b) — NOT distinct (single performance obligation) ⇒ catch-up JE at the
--                                 modification date on already-recognized revenue.
-- The classification is a management JUDGEMENT and IS the control (a wrong "separate_contract" call hides a
-- required catch-up), so each modification is maker-checker (maker records+classifies, a DIFFERENT user
-- approves — only an approved modification drives revenue). All GL routes through LedgerService.postEntry so
-- the period lock (PERIOD_LOCKED) + GL-17 audit bind. No new COA (2410/1265/4300 already exist + CF-classified).
--
-- rev_contract_modifications — the per-contract modification register (tenant-scoped, leading
-- (tenant_id, contract_id) index + the CANONICAL 0232-form tenant_isolation RLS policy + app_user grants).

CREATE TABLE IF NOT EXISTS rev_contract_modifications (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  contract_id bigint NOT NULL REFERENCES rev_contracts(id),
  as_of text NOT NULL,
  type text NOT NULL,
  added_price numeric(18,4) NOT NULL,
  distinct_flag boolean NOT NULL,
  at_ssp_flag boolean NOT NULL,
  effect_amount numeric(18,4) NOT NULL DEFAULT 0,
  added_pos text,
  new_contract_id bigint,
  status text NOT NULL DEFAULT 'Pending',
  note text,
  created_by text,
  approved_by text,
  applied_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_contract_mod_tenant ON rev_contract_modifications (tenant_id, contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_contract_mod_status ON rev_contract_modifications (tenant_id, status);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;
