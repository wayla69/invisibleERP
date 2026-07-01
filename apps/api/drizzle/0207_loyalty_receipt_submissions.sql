-- 0207_loyalty_receipt_submissions — LYL-17 receipt-upload-for-points. A member submits a photo of a
-- purchase made outside our POS + the claimed amount; staff review & approve/reject (crm_points_adjust)
-- before points post through the existing earnInTx path (member.service.ts) — no separate GL logic here,
-- this table is only the review queue. Tenant-scoped → re-run the RLS loop. Mirrors 0206_project_close_review.
CREATE TABLE IF NOT EXISTS loyalty_receipt_submissions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint REFERENCES pos_members(id),
  receipt_image text NOT NULL,
  purchase_amount numeric NOT NULL,
  store_name text,
  purchase_date date,
  note text,
  claimed_points_preview numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'Pending',
  submitted_at timestamptz DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  reject_reason text,
  ref_doc text,
  created_by text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_receipt_submissions_tenant_status ON loyalty_receipt_submissions (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_receipt_submissions_dup_guard ON loyalty_receipt_submissions (tenant_id, member_id, purchase_date, purchase_amount) WHERE status <> 'Rejected';
--> statement-breakpoint
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
