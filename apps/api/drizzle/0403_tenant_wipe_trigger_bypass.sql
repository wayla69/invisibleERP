-- 0403 — Let the god-only factory-reset / purge tenant-wipe delete append-only rows that immutability
-- triggers otherwise block. The wipe (tenant-wipe.ts) sets a transaction-local `app.tenant_wipe='on'`
-- GUC; the two DELETE-blocking triggers skip their RAISE only while it is set. Every other code path is
-- unchanged (GUC unset → full immutability, ITGC-AC-16 / append-only approval trail holds).
--
-- WHY new functions + re-pointed triggers (not CREATE OR REPLACE of the originals): the original trigger
-- functions (gl_block_posted_mutation @0165, approval_actions_immutable @0030) were created by the postgres
-- superuser before the ierp_app hardening, so they are OWNED BY postgres — and CREATE OR REPLACE FUNCTION
-- requires ownership, which prod migrations (run as the non-superuser ierp_app) don't have (42501 "must be
-- owner of function"; PGlite has no ownership so CI missed it — same CI-vs-prod class as 0387/enum-TYPE).
-- ierp_app DOES own the two tables (provisioning transferred table ownership), so we instead create
-- freshly-owned *_wipe_aware functions and re-point each trigger to them via DROP/CREATE TRIGGER (a table-
-- owner op). The old postgres-owned functions are left as harmless orphans.
--
-- WHY a GUC and not DISABLE TRIGGER: the wipe runs under `SET ROLE app_user`, which can disable neither
-- the triggers (not owner) nor session_replication_role (not superuser). audit_log_immutable needs no
-- change — audit_log is in every wipe's preserve-set and is never deleted.

CREATE OR REPLACE FUNCTION gl_block_posted_mutation_wipe_aware() RETURNS trigger AS $func$
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
DROP TRIGGER IF EXISTS trg_gl_block_posted_mutation ON journal_entries;
--> statement-breakpoint
CREATE TRIGGER trg_gl_block_posted_mutation
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_block_posted_mutation_wipe_aware();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION approval_actions_immutable_wipe_aware() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.tenant_wipe', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'approval_actions is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS approval_actions_no_mutate ON approval_actions;
--> statement-breakpoint
CREATE TRIGGER approval_actions_no_mutate
  BEFORE UPDATE OR DELETE ON approval_actions
  FOR EACH ROW EXECUTE FUNCTION approval_actions_immutable_wipe_aware();
