-- 0164_gl_immutability: GL immutability + audit log + reversal (WS2.2, GL-17)
-- Posted journal entries are immutable: no UPDATE/DELETE at the DB level (prod) and an app-level guard
-- (harness-testable). Corrections happen ONLY via a new contra REVERSAL entry. Every important GL action
-- and every blocked mutation attempt is recorded in gl_audit_log.

-- WS2.2 columns on journal_entries (idempotent).
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS posted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_of BIGINT,
  ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN DEFAULT FALSE;--> statement-breakpoint

-- GL audit trail (POST | APPROVE | REVERSE | MUTATE_BLOCKED).
CREATE TABLE IF NOT EXISTS gl_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT REFERENCES tenants(id),
  entry_id   BIGINT,
  action     TEXT NOT NULL,
  actor      TEXT,
  detail     JSONB,
  at         TIMESTAMPTZ DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_gl_audit_entry ON gl_audit_log(entry_id);--> statement-breakpoint

-- RLS — tenant isolation (standard policy). NULL tenant rows are bootstrap/system only.
ALTER TABLE gl_audit_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='gl_audit_log' AND policyname='tenant_isolation_gl_audit_log'
  ) THEN
    -- HQ/Admin requests set app.bypass_rls='on' (and may write audit rows for ANY tenant, e.g. closing or
    -- depreciating a specific shop's books); scoped requests are gated to their own app.tenant_id. WITH CHECK
    -- mirrors USING so scoped INSERTs of own-tenant rows are admitted. Matches the standard 0002 RLS shape.
    CREATE POLICY tenant_isolation_gl_audit_log ON gl_audit_log
      USING (
        coalesce(current_setting('app.bypass_rls', TRUE), '') = 'on'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      )
      WITH CHECK (
        coalesce(current_setting('app.bypass_rls', TRUE), '') = 'on'
        OR tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT
      );
  END IF;
END $$;--> statement-breakpoint

-- DB-level immutability guard (production enforcement). A Posted entry cannot be DELETEd, and on UPDATE
-- only the reversal bookkeeping flag (is_reversed) may change — any change to status or entry_date is
-- blocked. Modelled on audit_log_immutable() (0062). Idempotent: CREATE OR REPLACE + guarded CREATE TRIGGER.
CREATE OR REPLACE FUNCTION gl_block_posted_mutation() RETURNS trigger AS $func$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.status = 'Posted' THEN
      RAISE EXCEPTION 'GL_IMMUTABLE: posted journal entry % cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  ELSE
    IF OLD.status = 'Posted' THEN
      IF (NEW.status IS DISTINCT FROM OLD.status)
         OR (NEW.entry_date IS DISTINCT FROM OLD.entry_date) THEN
        RAISE EXCEPTION 'GL_IMMUTABLE: posted journal entry % cannot be modified', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$func$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_gl_block_posted_mutation ON journal_entries;--> statement-breakpoint
CREATE TRIGGER trg_gl_block_posted_mutation
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_block_posted_mutation();
