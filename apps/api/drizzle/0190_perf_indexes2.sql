-- 0190_perf_indexes2 — composite indexes for hot GL aggregation paths (perf hardening; follow-on to 0114).
-- (tenant_id, status, entry_date): the exact AND-predicate of the finance-trend / trial-balance /
--   consolidation scans ("Posted entries, this tenant, in this period"). 0114 indexed (tenant_id, entry_date)
--   and (status, entry_date) separately; this 3-column index covers the combined filter so Postgres can
--   range-scan one index instead of intersecting two.
-- journal_lines(account_code): supports the journal_lines→accounts JOIN (the finance-trend N+1 fix) and the
--   group-by-account trial-balance / income-statement aggregation. 0114 indexed entry_id + tenant_id only.
-- Idempotent (IF NOT EXISTS); index-only DDL, so no RLS loop is needed.
CREATE INDEX IF NOT EXISTS idx_je_tenant_status_date ON journal_entries (tenant_id, status, entry_date);
CREATE INDEX IF NOT EXISTS idx_jl_account_code ON journal_lines (account_code);
