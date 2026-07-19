-- 0447_pos_price_books — customer-tier & per-branch price books (docs/52 Phase 4a).
-- A governed, approved base-price list the POS draws from, so a till/quote price has an auditable basis
-- instead of being typed freely per line (cf. CRM-15). A book serves a customer TIER and/or a BRANCH, holds
-- a per-item unit price, and is MAKER-CHECKER (staged PendingApproval + inactive; a DIFFERENT user activates
-- it — mirrors the price-rule G6 gate). The sale path reads only active/approved books; absent a matching
-- book the client price stands (byte-identical). Both tables are TENANT-SCOPED (a book belongs to one shop),
-- so they get the CANONICAL 0232-form tenant_isolation RLS, leading (tenant_id,…) indexes + app_user grants.
CREATE TABLE IF NOT EXISTS price_books (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  tier text,                                   -- customer price tier served (retail|wholesale|vip|member…); NULL = any tier
  branch_id bigint,                            -- outlet served; NULL = any branch
  currency text NOT NULL DEFAULT 'THB',
  priority integer NOT NULL DEFAULT 100,       -- lower = higher precedence when several books match
  active boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PendingApproval', -- Active | PendingApproval | Rejected
  valid_from date,
  valid_to date,
  created_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS price_book_entries (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  price_book_id bigint NOT NULL REFERENCES price_books(id),
  item_id text NOT NULL,
  unit_price numeric(14,4) NOT NULL,
  min_qty integer NOT NULL DEFAULT 1,          -- book-local qty break; the highest min_qty ≤ sold qty wins
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_price_books_tenant ON price_books (tenant_id, status, priority);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_price_book_entries_tenant ON price_book_entries (tenant_id, price_book_id, item_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_entry ON price_book_entries (tenant_id, price_book_id, item_id, min_qty);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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
