-- 0361_revrec_financing_schedules — Track D Wave 4 (control REV-27, FINAL): significant financing component +
-- revenue disclosure pack under TFRS 15 / IFRS 15 / ASC 606 §60-65 (financing) + §120 (disclosure).
--
-- (A) Significant financing component (§60-65): when the TIMING of payment gives a MATERIAL financing benefit,
--     the promised consideration is adjusted to its cash-selling-price PRESENT VALUE and the difference
--     (face − PV) is recognized as interest, UNWOUND over the contract by the effective-interest method (the
--     same EIR primitive the lease engine uses). Two directions:
--       • advance (customer PREPAYS)  — the entity BORROWS from the customer; the charge accretes the contract
--                                       liability from PV toward face as interest EXPENSE (5900): Dr 5900 / Cr 2410.
--       • arrears (deferred payment)  — the entity LENDS to the customer; the charge accretes the contract
--                                       asset/receivable from PV toward face as interest INCOME (4650): Dr 1265 / Cr 4650.
--     The DISCOUNT RATE is a management JUDGEMENT → maker-checker (REV-27): the maker records+rates the
--     component (rows land 'Pending', drive NOTHING), a DIFFERENT user approves it, and only an APPROVED
--     component may post its interest unwind. All GL routes through LedgerService.postEntry so the period lock
--     (PERIOD_LOCKED) + GL-17 audit bind; idempotent via alreadyPosted.
-- (B) Disclosure pack (§120): the contract-liability rollforward + the RPO (remaining-performance-obligation)
--     report are READ-ONLY aggregators over the GL (2410/1265) + the recognition schedule — NO new table.
--
-- New COA 4650 (Significant Financing Component Interest Income) is seeded from the canonical COA in
-- ledger-constants.ts (seedChartOfAccounts), not here. rev_financing_schedules is the per-contract interest
-- schedule (tenant-scoped, leading (tenant_id, contract_id) index + the CANONICAL 0232-form tenant_isolation
-- RLS policy + app_user grants).

CREATE TABLE IF NOT EXISTS rev_financing_schedules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  contract_id bigint NOT NULL REFERENCES rev_contracts(id),
  seq integer NOT NULL,
  period text NOT NULL,
  direction text NOT NULL,
  discount_rate_pct numeric(9,4) NOT NULL,
  nominal numeric(18,4) NOT NULL,
  present_value numeric(18,4) NOT NULL,
  opening_balance numeric(18,4) NOT NULL,
  interest_amount numeric(18,4) NOT NULL,
  closing_balance numeric(18,4) NOT NULL,
  status text NOT NULL DEFAULT 'Pending',
  posted boolean NOT NULL DEFAULT false,
  entry_no text,
  note text,
  created_by text,
  approved_by text,
  approved_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_financing_sched_tenant ON rev_financing_schedules (tenant_id, contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_financing_sched_status ON rev_financing_schedules (tenant_id, status);
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
