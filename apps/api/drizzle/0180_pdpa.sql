-- 0180 — PDPA (Thailand Personal Data Protection Act) compliance: DSAR workflow + erasure ledger.
-- dsar_requests: a Data Subject Access Request lifecycle (access / rectification / erasure / portability /
--   objection). Statutory response clock is 30 days → due_date defaulted on insert by the service.
-- pdpa_erasures: an append-only ledger of erased data subjects. Because audit_log is immutable +
--   hash-chained (ITGC-AC-10/AC-16) it CANNOT be edited, so an erasure does NOT mutate past audit rows;
--   instead the subject's PII is redacted in the operational tables and this ledger drives READ-TIME
--   pseudonymisation in the audit viewer/exports (the stored bytes stay intact, the PII is never shown).
CREATE TABLE IF NOT EXISTS dsar_requests (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),
  subject_type text NOT NULL,                 -- member | customer | employee | user
  subject_ref  text NOT NULL,                 -- the subject identifier (member id/code, email, …)
  request_type text NOT NULL,                 -- access | rectification | erasure | portability | objection
  status       text NOT NULL DEFAULT 'received', -- received | in_progress | completed | rejected
  details      text,
  result       jsonb,
  requested_by text,
  handled_by   text,
  due_date     date,                          -- statutory 30-day clock
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dsar_tenant ON dsar_requests (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pdpa_erasures (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint REFERENCES tenants(id),
  subject_type  text NOT NULL,
  subject_id    bigint,                        -- operational PK erased (e.g. pos_members.id)
  pseudonym     text NOT NULL,                 -- stable replacement token shown in audit views
  erased_values jsonb NOT NULL DEFAULT '[]'::jsonb, -- PII strings to mask at read-time (name/phone/email/code)
  dsar_id       bigint REFERENCES dsar_requests(id),
  erased_by     text,
  erased_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdpa_erasures_tenant ON pdpa_erasures (tenant_id, erased_at DESC);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['dsar_requests','pdpa_erasures']) AS table_name LOOP
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
