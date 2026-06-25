-- 0116 — ITGC-AC-14: field-level before/after change log for financially-significant tables.
-- The central audit_log (0062) records WHO/WHEN/IP/action/status for every mutating request, but not the
-- field-level OLD→NEW values. This adds a DB-trigger-driven change log that captures the actual row images
-- (old_value / new_value jsonb + changed_columns) on every INSERT/UPDATE/DELETE of the core financial tables —
-- at the database layer, so it cannot be bypassed by application code — and is append-only (no UPDATE/DELETE).
-- Tenant is captured as `tenant_ref` (NOT `tenant_id`) so the table is intentionally excluded from the RLS
-- loop; reads are admin-gated (`users`) and tenant-scoped in the audit-viewer service.

CREATE TABLE IF NOT EXISTS data_change_log (
  id bigserial PRIMARY KEY,
  ts timestamptz DEFAULT now(),
  table_name text NOT NULL,
  op text NOT NULL,                 -- INSERT | UPDATE | DELETE
  row_pk text,                      -- the row's id
  tenant_ref bigint,                -- the row's tenant_id (named tenant_ref to opt out of the RLS loop)
  actor text,                       -- from current_setting('app.actor') set per request by TenantTxInterceptor
  old_value jsonb,                  -- row image before (NULL on INSERT)
  new_value jsonb,                  -- row image after (NULL on DELETE)
  changed_columns text[]            -- columns whose value changed (UPDATE only)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dcl_row ON data_change_log (table_name, row_pk);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dcl_tenant_ts ON data_change_log (tenant_ref, ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dcl_actor ON data_change_log (actor);
--> statement-breakpoint

-- Generic capture trigger. Runs as invoker (app_user under RLS); data_change_log has no tenant_id column so
-- RLS does not apply to it and the insert always succeeds. actor comes from the per-request GUC.
CREATE OR REPLACE FUNCTION log_data_change() RETURNS trigger AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_tenant bigint;
  v_pk text;
  v_cols text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD); v_new := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old := NULL; v_new := to_jsonb(NEW);
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW);
    SELECT array_agg(k) INTO v_cols
      FROM jsonb_object_keys(v_new) AS k
      WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k);
  END IF;
  v_tenant := NULLIF(COALESCE(v_new, v_old) ->> 'tenant_id', '')::bigint;
  v_pk := COALESCE(v_new, v_old) ->> 'id';
  INSERT INTO data_change_log(table_name, op, row_pk, tenant_ref, actor, old_value, new_value, changed_columns)
  VALUES (TG_TABLE_NAME, TG_OP, v_pk, v_tenant, NULLIF(current_setting('app.actor', true), ''), v_old, v_new, v_cols);
  RETURN NULL; -- AFTER trigger
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Attach to the core financial transaction / control tables (GL header, AP/AR sub-ledgers, tenders, AP payments).
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['journal_entries','ap_transactions','ap_payments','ar_invoices','ar_receipts','payments','payment_refunds'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_dcl_%I ON public.%I', r, r);
    EXECUTE format('CREATE TRIGGER trg_dcl_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION log_data_change()', r, r);
  END LOOP;
END $$;
--> statement-breakpoint

-- Append-only: block any UPDATE/DELETE on the change log itself (defence in depth, mirrors audit_log 0062).
CREATE OR REPLACE FUNCTION data_change_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'data_change_log is append-only'; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS data_change_log_no_mutate ON data_change_log;
--> statement-breakpoint
CREATE TRIGGER data_change_log_no_mutate BEFORE UPDATE OR DELETE ON data_change_log
  FOR EACH ROW EXECUTE FUNCTION data_change_log_immutable();
--> statement-breakpoint

-- app_user (RLS principal) needs INSERT (via triggers) + SELECT (audit-viewer reads). Created after the
-- earlier GRANT-ALL loop migrations, so grant explicitly.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT ON data_change_log TO app_user';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE data_change_log_id_seq TO app_user';
  END IF;
END $$;
