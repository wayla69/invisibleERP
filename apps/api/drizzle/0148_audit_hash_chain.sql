-- 0148 — Audit-trail tamper-EVIDENCE: hash-chain the request-level audit_log (ITGC-AC-16).
-- audit_log is already append-only (0062 immutability triggers), but immutability is enforced only at the
-- trigger layer it shares a trust boundary with — a superuser bypassing the trigger could alter history
-- undetectably. A per-(tenant) hash chain (seq + prev_hash + hash, each hash binding the previous one + the
-- row's content, exactly like pos_journal 0055) makes any edit/delete/insert of a past row break every later
-- hash, so tampering is DETECTABLE by re-walking the chain (GET /api/admin/audit/verify). Pre-existing rows
-- (no seq) are legacy-unchained; the chain covers every event written from this migration forward.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash text;
-- supports the per-tenant "latest row" FOR UPDATE lookup that serialises the chain append.
CREATE INDEX IF NOT EXISTS idx_audit_chain ON audit_log (tenant_id, seq);
