-- 0052 — POS world-class P1: pricing engine, fiscal (hash-chained journal + e-Tax submissions),
-- audit & control (reason-code masters; audit_log already exists). All tenant-scoped → RLS loop.

-- P1a — pricing
CREATE TABLE IF NOT EXISTS price_rules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  scope text DEFAULT 'all',          -- all | item | category
  target_id text,                     -- item sku / category id when scope != all
  channel text DEFAULT 'any',         -- any | dine_in | takeaway | delivery
  location text,
  dow text,                           -- comma list of ISO weekdays 1..7 (null = every day)
  time_start text,                    -- 'HH:MM' (null = all day)
  time_end text,
  type text NOT NULL,                 -- percent | amount | fixed | bogo | qty_break
  value numeric(14,4) DEFAULT '0',
  min_qty integer DEFAULT 1,
  priority integer DEFAULT 100,
  stackable boolean DEFAULT false,
  active boolean DEFAULT true,
  valid_from date,
  valid_to date,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS combo_components (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  combo_sku text NOT NULL,
  component_sku text NOT NULL,
  qty numeric(14,2) DEFAULT '1',
  unit_price_override numeric(14,2),
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- P1c — reason-code masters (audit_log itself already exists)
CREATE TABLE IF NOT EXISTS reason_codes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  label text NOT NULL,
  applies_to text DEFAULT 'all',     -- all | void | discount | price_override | no_sale | return | refund | paid_out
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- P1b — hash-chained electronic journal (append-only; tamper-evident)
CREATE TABLE IF NOT EXISTS pos_journal (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  seq bigint NOT NULL,                -- per-tenant monotonic
  doc_type text NOT NULL,            -- SALE | VOID | REFUND | TAXINV | NOSALE | ...
  doc_no text,
  action text,
  payload jsonb NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_journal_seq ON pos_journal (tenant_id, seq);
--> statement-breakpoint

-- P1b — RD/ETDA e-Tax submissions (provider abstraction; mock + real SP)
CREATE TABLE IF NOT EXISTS etax_submissions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  doc_no text NOT NULL,
  provider text DEFAULT 'mock',      -- mock | inet | frank | ...
  status text DEFAULT 'Pending',     -- Pending | Accepted | Rejected
  provider_ref text,
  rd_response jsonb,
  submitted_by text,
  submitted_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- Re-run the RLS loop for the new tenant_id tables.
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
