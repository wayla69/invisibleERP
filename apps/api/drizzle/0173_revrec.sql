-- WS3.4 — Revenue recognition under TFRS 15 / IFRS 15 (REV-19).
-- The "real ERP" deferred-revenue engine (distinct from the legacy straight-line DEFREV schedule in
-- migration 0018 / rev_rec_schedules, which stays for prepaid cash-in-advance). This models the TFRS 15
-- five-step process for service/subscription/project contracts:
--   1. identify the contract (rev_contracts)
--   2. identify the performance obligations (performance_obligations)
--   3. determine the transaction price (rev_contracts.total_price)
--   4. allocate the price across POs by standalone selling price (allocateBySSP → allocated_price)
--   5. recognize revenue as each PO is satisfied (revrec_schedules → REVREC-15 JE)
-- A contract liability (2410 Deferred Revenue) is raised on invoice/activation (Dr 1100 AR / Cr 2410) and
-- released to revenue (4300) as POs are satisfied; a refund liability (2420) provides for expected returns.
-- All tables carry tenant_id → the RLS loop isolates them (HQ/Admin bypass per app.bypass_rls).
INSERT INTO accounts (code, name, type)
  VALUES ('2410', 'Contract Liability / Deferred Revenue', 'Liability')
  ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO accounts (code, name, type)
  VALUES ('2420', 'Refund Liability', 'Liability')
  ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rev_contracts (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint REFERENCES tenants(id),
  customer_id   bigint,
  contract_no   text NOT NULL,
  contract_date text NOT NULL,                         -- 'YYYY-MM-DD' (business day)
  currency      text DEFAULT 'THB',
  total_price   numeric(18,4) NOT NULL,
  status        text NOT NULL DEFAULT 'Draft',         -- Draft | Active | Completed | Cancelled
  description   text,
  invoice_entry_id bigint,                             -- GL entry id of the activation/invoice posting
  created_by    text,
  created_at    timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_rev_contract_no ON rev_contracts (tenant_id, contract_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_contract_tenant ON rev_contracts (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS performance_obligations (
  id             bigserial PRIMARY KEY,
  tenant_id      bigint REFERENCES tenants(id),
  contract_id    bigint NOT NULL REFERENCES rev_contracts(id),
  name           text NOT NULL,
  ssp            numeric(18,4) NOT NULL,                -- standalone selling price
  allocated_price numeric(18,4) NOT NULL DEFAULT 0,    -- computed by SSP allocation (step 4)
  method         text NOT NULL DEFAULT 'point_in_time',-- point_in_time | over_time
  start_date     text,                                 -- 'YYYY-MM-DD' (over_time straight-line / pit satisfaction)
  end_date       text,                                 -- 'YYYY-MM-DD' (over_time)
  satisfied_pct  numeric(9,4) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'Pending',      -- Pending | InProgress | Satisfied
  created_at     timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_po_contract ON performance_obligations (contract_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS revrec_schedules (
  id                  bigserial PRIMARY KEY,
  tenant_id           bigint REFERENCES tenants(id),
  contract_id         bigint NOT NULL REFERENCES rev_contracts(id),
  obligation_id       bigint NOT NULL REFERENCES performance_obligations(id),
  period              text NOT NULL,                   -- 'YYYY-MM'
  planned_amount      numeric(18,4) NOT NULL,
  recognized_amount   numeric(18,4) NOT NULL DEFAULT 0,
  recognized          boolean NOT NULL DEFAULT false,
  recognized_entry_id bigint,
  created_at          timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_revrec_sched_contract ON revrec_schedules (contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_revrec_sched_period ON revrec_schedules (tenant_id, period, recognized);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS refund_liability (
  id                     bigserial PRIMARY KEY,
  tenant_id              bigint REFERENCES tenants(id),
  contract_id            bigint NOT NULL REFERENCES rev_contracts(id),
  as_of_date             text NOT NULL,                -- 'YYYY-MM-DD'
  expected_refund_rate   numeric(9,4) NOT NULL,
  expected_refund_amount numeric(18,4) NOT NULL,
  posted                 boolean NOT NULL DEFAULT false,
  posted_entry_id        bigint,
  posted_amount          numeric(18,4),                -- the DELTA actually journaled vs prior
  created_by             text,
  created_at             timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_refund_liab_contract ON refund_liability (contract_id);
--> statement-breakpoint
-- Re-run the RLS loop so the four new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
-- WITH CHECK + the app.bypass_rls escape mirror 0167/0169/0171 so an HQ/Admin (bypass) run/post can write these
-- rows while reading across member tenants.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;
