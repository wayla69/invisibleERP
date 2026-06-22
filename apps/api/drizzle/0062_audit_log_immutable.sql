-- ITGC-AC-10 — make the primary audit trail tamper-evident.
-- audit_log is written INSERT-only by the AuditInterceptor; this DB-level guard blocks any UPDATE/DELETE
-- (defence in depth — even a DBA/app with table write access cannot rewrite history). Mirrors the
-- approval_actions_no_mutate guard (0030) and the hash-chained pos_journal (0055).
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_mutate ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_mutate BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
