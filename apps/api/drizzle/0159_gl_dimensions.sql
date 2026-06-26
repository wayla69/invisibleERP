-- 0157_gl_dimensions: Multi-dimensional GL postings (WS1.3)
-- Adds branch_id, project_id, department_id to journal_lines.
-- Adds departments master table.

ALTER TABLE journal_lines
  ADD COLUMN IF NOT EXISTS branch_id     BIGINT,
  ADD COLUMN IF NOT EXISTS project_id    BIGINT,
  ADD COLUMN IF NOT EXISTS department_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_jl_branch  ON journal_lines(branch_id);
CREATE INDEX IF NOT EXISTS idx_jl_project ON journal_lines(project_id);
CREATE INDEX IF NOT EXISTS idx_jl_dept    ON journal_lines(department_id);

CREATE TABLE IF NOT EXISTS departments (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dept ON departments(tenant_id, code);

-- RLS on departments
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='departments' AND policyname='tenant_isolation_departments'
  ) THEN
    CREATE POLICY tenant_isolation_departments ON departments
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT);
  END IF;
END $$;
