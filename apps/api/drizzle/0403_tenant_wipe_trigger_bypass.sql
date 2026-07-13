-- 0403 — Let the god-only factory-reset / purge tenant-wipe delete append-only rows that immutability
-- triggers otherwise block. The wipe (tenant-wipe.ts) sets a transaction-local `app.tenant_wipe='on'`
-- GUC; these two DELETE-blocking triggers skip their RAISE only while it is set. Every other code path is
-- unchanged (GUC unset → full immutability, ITGC-AC-16 / append-only approval trail holds).
--
-- WHY a GUC and not DISABLE TRIGGER: the wipe runs under `SET ROLE app_user` (RLS), and app_user is
-- neither the table owner (so `ALTER TABLE … DISABLE TRIGGER` is denied) nor a superuser (so
-- `session_replication_role='replica'` is denied) — a GUC gate inside the trigger is the only mechanism
-- available to the request-scoped role. Modelled on the existing GUC-checking data-change-log triggers.
-- The other DELETE-blocking trigger, audit_log_immutable, needs no change: audit_log is in every wipe's
-- preserve-set and is never deleted. CREATE OR REPLACE FUNCTION keeps each existing trigger binding.

CREATE OR REPLACE FUNCTION gl_block_posted_mutation() RETURNS trigger AS $func$
BEGIN
  IF coalesce(current_setting('app.tenant_wipe', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
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
$func$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION approval_actions_immutable() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.tenant_wipe', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'approval_actions is append-only';
END;
$$ LANGUAGE plpgsql;
