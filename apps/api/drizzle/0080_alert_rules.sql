-- 0080 — Alert/notification rules engine (Platform Phase 3). A tenant defines no-code rules over a catalog
-- of built-in metrics (low stock, overdue approvals, overdue AR, …); a cron-callable sweep evaluates each
-- active rule against live tenant data and fires a notification (and optionally a LINE/SMS/email message)
-- when the threshold is breached, with a cooldown so it can't spam. New tenant_id tables → RLS loop re-run.

CREATE TABLE IF NOT EXISTS alert_rules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  metric text NOT NULL,                  -- catalog key, e.g. low_stock_count | approvals_overdue | ar_overdue_total
  operator text NOT NULL DEFAULT 'gte',  -- gt | gte | lt | lte | eq
  threshold numeric(18,4) NOT NULL DEFAULT 0,
  channel text NOT NULL DEFAULT 'notification', -- notification | line | sms | email
  target_role text,                      -- notification target role
  target_to text,                        -- line/sms/email recipient
  severity text NOT NULL DEFAULT 'warning', -- info | warning | critical
  cooldown_hours integer NOT NULL DEFAULT 12,
  active boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_alert_rules_scope ON alert_rules (tenant_id, active);
--> statement-breakpoint

-- log of every fire (audit + dashboard feed)
CREATE TABLE IF NOT EXISTS alert_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rule_id bigint,
  name text,
  metric text,
  value numeric(18,4),
  threshold numeric(18,4),
  severity text,
  channel text,
  message text,
  fired_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_alert_events_scope ON alert_events (tenant_id, fired_at);
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
