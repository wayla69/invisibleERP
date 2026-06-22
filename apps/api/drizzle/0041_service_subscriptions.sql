-- 0041_service_subscriptions: Phase 20 Batch 2C — Service Contracts + Subscriptions
-- service_contracts, sla_events, subscriptions, subscription_invoices

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_contracts (
  id               bigserial PRIMARY KEY,
  tenant_id        bigint REFERENCES tenants(id),
  contract_no      text NOT NULL UNIQUE,
  customer_name    text NOT NULL,
  sla_tier         text NOT NULL DEFAULT 'Silver',
  response_hours   int  NOT NULL DEFAULT 4,
  resolution_hours int  NOT NULL DEFAULT 24,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'Active',
  monthly_value    numeric(18,4) NOT NULL DEFAULT 0,
  currency         text NOT NULL DEFAULT 'THB',
  created_by       text,
  created_at       timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sc_tenant ON service_contracts(tenant_id, status);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sla_events (
  id                  bigserial PRIMARY KEY,
  contract_id         bigint NOT NULL REFERENCES service_contracts(id),
  event_no            text NOT NULL UNIQUE,
  title               text NOT NULL,
  priority            text NOT NULL DEFAULT 'P3',
  opened_at           timestamptz NOT NULL DEFAULT now(),
  response_due_at     timestamptz,
  responded_at        timestamptz,
  resolved_at         timestamptz,
  resolution_due_at   timestamptz,
  response_breached   boolean DEFAULT false,
  resolution_breached boolean DEFAULT false,
  status              text NOT NULL DEFAULT 'Open',
  notes               text,
  created_by          text
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sla_contract ON sla_events(contract_id, status);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_subscriptions (
  id                bigserial PRIMARY KEY,
  tenant_id         bigint REFERENCES tenants(id),
  sub_no            text NOT NULL UNIQUE,
  customer_name     text NOT NULL,
  product_code      text NOT NULL,
  description       text,
  billing_cycle     text NOT NULL DEFAULT 'monthly',
  unit_price        numeric(18,4) NOT NULL,
  qty               int  NOT NULL DEFAULT 1,
  currency          text NOT NULL DEFAULT 'THB',
  start_date        date NOT NULL,
  next_billing_date date NOT NULL,
  status            text NOT NULL DEFAULT 'Active',
  created_by        text,
  created_at        timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_svc_sub_tenant  ON service_subscriptions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_svc_sub_billing ON service_subscriptions(next_billing_date);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_subscription_invoices (
  id              bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES service_subscriptions(id),
  invoice_no      text NOT NULL UNIQUE,
  billing_period  text NOT NULL,
  amount          numeric(18,4) NOT NULL,
  currency        text NOT NULL DEFAULT 'THB',
  status          text NOT NULL DEFAULT 'Draft',
  generated_at    timestamptz DEFAULT now(),
  due_date        date
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_svc_si_sub ON service_subscription_invoices(subscription_id);

--> statement-breakpoint
-- RLS for service_contracts and service_subscriptions
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name IN ('service_contracts','service_subscriptions')
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
