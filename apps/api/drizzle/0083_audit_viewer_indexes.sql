-- 0083 — Audit-trail viewer (Platform Phase 6). Pure read-layer feature: no schema/columns change and the
-- append-only immutability trigger (0062) is untouched. This migration only adds composite indexes so the
-- new tenant-scoped, filtered audit queries (by time / actor / action / status) stay fast on a large log.
-- No RLS loop: audit_log already carries tenant_id and was isolation-scoped by the 0002 loop.

CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_log (tenant_id, ts DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_tenant_actor ON audit_log (tenant_id, actor);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_tenant_action ON audit_log (tenant_id, action);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_tenant_status ON audit_log (tenant_id, status);
