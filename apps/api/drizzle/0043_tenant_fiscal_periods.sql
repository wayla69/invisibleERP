-- A1: tenant-scope fiscal_periods. It was GLOBAL (code unique) so any one tenant closing a
-- period / year-end locked the calendar for EVERY tenant. Add tenant_id, make uniqueness
-- per (tenant_id, code), backfill existing rows to HQ, index GL idempotency by tenant, and
-- re-apply the dynamic RLS so the now-tenant-scoped fiscal_periods gets tenant_isolation.

ALTER TABLE fiscal_periods ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);

-- backfill existing global periods to the HQ tenant so historical rows stay visible to HQ
UPDATE fiscal_periods
   SET tenant_id = (SELECT id FROM tenants WHERE code = 'HQ' ORDER BY id LIMIT 1)
 WHERE tenant_id IS NULL;

-- uniqueness is now per tenant, not global. Drop ANY unique constraint whose columns are exactly
-- (code) — name-independent so it works regardless of how the original was named (constraint vs index).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'fiscal_periods'::regclass AND contype = 'u'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'fiscal_periods'::regclass AND attname = 'code' AND NOT attisdropped)]
  LOOP
    EXECUTE format('ALTER TABLE fiscal_periods DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
-- also drop a bare unique index on (code) if one exists instead of a constraint
DROP INDEX IF EXISTS fiscal_periods_code_unique;
DROP INDEX IF EXISTS fiscal_periods_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_periods_tenant_code ON fiscal_periods (tenant_id, code);

-- GL idempotency was GLOBAL (uq_je_source_ref on (source, source_ref)) — that blocked two tenants from
-- sharing a ref like 'FY2026' (year-end close) or any per-tenant doc ref. Make it TENANT-SCOPED.
-- Safe: the old global unique guaranteed (source, source_ref) unique, so (tenant_id, source, source_ref)
-- has no existing duplicates.
DROP INDEX IF EXISTS uq_je_source_ref;
CREATE UNIQUE INDEX IF NOT EXISTS uq_je_tenant_source_ref ON journal_entries (tenant_id, source, source_ref) WHERE source_ref IS NOT NULL;

-- re-apply dynamic RLS (idempotent): every table with a tenant_id column gets tenant_isolation,
-- which now includes fiscal_periods.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)',
      r.table_name);
  END LOOP;
END $$;
