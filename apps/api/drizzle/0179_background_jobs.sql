-- 0179 — Async job queue for long-running financial operations (perf / availability hardening).
-- background_jobs: a tenant-scoped, at-least-once work queue. A request enqueues a job and returns 202
--   immediately; an in-process worker claims queued rows with FOR UPDATE SKIP LOCKED (so multiple workers
--   never grab the same row) and runs the handler inside the job's own tenant transaction. Idempotent
--   handlers (the GL recurring/prepaid, lease, payroll runs already are) make retries safe.
-- RLS: tenant-scoped like every other tenant table (the API status read sees only the caller's jobs); the
--   worker claims across tenants by setting app.bypass_rls=on in its claim transaction.
CREATE TABLE IF NOT EXISTS background_jobs (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),         -- the tenant the job runs for (NULL = HQ/global)
  job_type     text NOT NULL,                          -- registered handler key (e.g. 'payroll_run')
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued',         -- queued | running | done | failed
  actor        text,                                   -- username that enqueued (worker runs as this actor)
  bypass_rls   boolean NOT NULL DEFAULT false,         -- run the handler with HQ/admin RLS bypass
  result       jsonb,
  error        text,
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),     -- earliest claim time (retry backoff)
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- partial index for the hot claim path (only queued, due rows)
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim ON background_jobs (run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_background_jobs_tenant ON background_jobs (tenant_id, created_at DESC);

ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON background_jobs;
CREATE POLICY tenant_isolation ON background_jobs
  USING (coalesce(current_setting('app.bypass_rls', true), '') = 'on'
     OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (coalesce(current_setting('app.bypass_rls', true), '') = 'on'
     OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
