-- 0035_crm: Customer CRM profiles (RFM/360), personalized promo audience rules,
--           member_id on channel orders so online orders earn loyalty points.

--> statement-breakpoint
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS member_id bigint REFERENCES pos_members(id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS din_member_idx ON dine_in_orders(tenant_id, member_id)
  WHERE member_id IS NOT NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_profiles (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),
  member_id    bigint REFERENCES pos_members(id),
  total_orders int          NOT NULL DEFAULT 0,
  total_spend  numeric(14,2) NOT NULL DEFAULT 0,
  last_order_at  timestamptz,
  first_order_at timestamptz,
  rfm_recency    int,
  rfm_frequency  int,
  rfm_monetary   numeric(14,2),
  rfm_segment    text,
  preferred_channel text,
  favorite_item_ids jsonb,
  visit_count  int NOT NULL DEFAULT 0,
  avg_order_value numeric(14,2),
  refreshed_at timestamptz DEFAULT now(),
  UNIQUE(tenant_id, member_id)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS promo_audience_rules (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),
  promo_id     bigint REFERENCES promotions(id),
  rfm_segment      text,
  min_lifetime     numeric(14,2),
  min_frequency    int,
  preferred_channel text,
  active       boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);

--> statement-breakpoint
-- RLS for new scoped tables (same string-concat pattern as 0033_wms)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name IN ('customer_profiles','promo_audience_rules')
  LOOP
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
