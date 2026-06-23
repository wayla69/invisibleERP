-- 0075 — POS hardware peripherals (Phase 5): device registry + cash-drawer audit + customer display +
-- weighing scale. The cash drawer is kicked via the printer (ESC/POS) so it reuses the 0074 print queue;
-- this migration adds the device registry, the drawer-open audit trail, the per-terminal customer-display
-- state, the scale-reading log, and weighed-item flags on the menu. New tenant_id tables → RLS loop re-run.

CREATE TABLE IF NOT EXISTS pos_devices (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  device_code text NOT NULL,             -- unique per tenant
  kind text NOT NULL,                    -- printer | cash_drawer | display | scale
  terminal text,                         -- POS terminal this device is attached to
  printer_id text,                       -- for a cash_drawer: the printer that kicks it
  config jsonb,
  status text NOT NULL DEFAULT 'active', -- active | inactive
  last_seen_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_device ON pos_devices (tenant_id, device_code);
--> statement-breakpoint

-- Cash-drawer open audit — every physical drawer open is logged with its reason + operator + till session.
CREATE TABLE IF NOT EXISTS drawer_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  terminal text,
  till_session_id bigint,
  reason text NOT NULL,                  -- sale | no_sale | refund | paid_in | paid_out | manual
  sale_no text,
  amount numeric(14,2),
  print_job_id bigint,                   -- the ESC/POS kick job (0074 print_jobs)
  opened_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_drawer_events_scope ON drawer_events (tenant_id, created_at);
--> statement-breakpoint

-- Customer-facing display state — one upserted row per (tenant, terminal); the pole/second screen polls it.
CREATE TABLE IF NOT EXISTS customer_displays (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  terminal text NOT NULL,
  state jsonb,                           -- {lines, subtotal, total, amount_due, change, message}
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_display ON customer_displays (tenant_id, terminal);
--> statement-breakpoint

-- Weighing-scale readings — captured net weight × catalog unit price (audit trail; server-side pricing).
CREATE TABLE IF NOT EXISTS scale_readings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  terminal text,
  device_code text,
  sku text,
  gross_weight numeric(14,3),
  tare_weight numeric(14,3) DEFAULT 0,
  net_weight numeric(14,3),
  weight_unit text DEFAULT 'kg',         -- kg | g
  unit_price numeric(14,2),              -- price per weight_unit (from the catalog)
  amount numeric(14,2),
  sale_no text,
  order_no text,
  captured_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scale_readings_scope ON scale_readings (tenant_id, created_at);
--> statement-breakpoint

-- Weighed-item flags on the catalog: when sold_by_weight, menu_items.price is the price per weight_unit.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sold_by_weight boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS weight_unit text DEFAULT 'kg';
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id tables are isolation-scoped.
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
