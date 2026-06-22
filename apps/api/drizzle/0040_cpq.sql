-- 0040_cpq: Phase 20 Batch 2B — Configure-Price-Quote
-- product_configs, config_options, pricing_rules, quotes, quote_lines

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS product_configs (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  code        text NOT NULL,
  name        text NOT NULL,
  base_price  numeric(18,4) NOT NULL DEFAULT 0,
  currency    text NOT NULL DEFAULT 'THB',
  description text,
  is_active   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  UNIQUE(tenant_id, code)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS config_options (
  id           bigserial PRIMARY KEY,
  config_id    bigint NOT NULL REFERENCES product_configs(id),
  group_name   text NOT NULL,
  option_code  text NOT NULL,
  option_name  text NOT NULL,
  price_delta  numeric(18,4) NOT NULL DEFAULT 0,
  is_default   boolean DEFAULT false,
  is_active    boolean DEFAULT true,
  UNIQUE(config_id, group_name, option_code)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_co_config ON config_options(config_id, group_name);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pricing_rules (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),
  config_id    bigint REFERENCES product_configs(id),
  name         text NOT NULL,
  rule_type    text NOT NULL DEFAULT 'volume',
  discount_pct numeric(7,4) NOT NULL DEFAULT 0,
  min_qty      int  NOT NULL DEFAULT 1,
  is_active    boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pr_config ON pricing_rules(config_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS quotes (
  id              bigserial PRIMARY KEY,
  tenant_id       bigint REFERENCES tenants(id),
  quote_no        text NOT NULL UNIQUE,
  opportunity_id  bigint REFERENCES opportunities(id),
  config_id       bigint REFERENCES product_configs(id),
  customer_name   text NOT NULL,
  status          text NOT NULL DEFAULT 'Draft',
  validity_days   int  NOT NULL DEFAULT 30,
  issued_date     date,
  expires_date    date,
  currency        text NOT NULL DEFAULT 'THB',
  subtotal        numeric(18,4) NOT NULL DEFAULT 0,
  discount_total  numeric(18,4) NOT NULL DEFAULT 0,
  total           numeric(18,4) NOT NULL DEFAULT 0,
  notes           text,
  created_by      text,
  created_at      timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qt_tenant ON quotes(tenant_id, status);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS quote_lines (
  id           bigserial PRIMARY KEY,
  quote_id     bigint NOT NULL REFERENCES quotes(id),
  line_no      int    NOT NULL,
  item_code    text,
  description  text NOT NULL,
  qty          numeric(10,2) NOT NULL DEFAULT 1,
  unit_price   numeric(18,4) NOT NULL DEFAULT 0,
  discount_pct numeric(7,4)  NOT NULL DEFAULT 0,
  line_total   numeric(18,4) NOT NULL DEFAULT 0
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ql_quote ON quote_lines(quote_id);

--> statement-breakpoint
-- RLS for product_configs, pricing_rules, quotes
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name IN ('product_configs','pricing_rules','quotes')
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
