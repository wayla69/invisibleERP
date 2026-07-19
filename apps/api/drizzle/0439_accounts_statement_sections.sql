-- 0439: each account can be BOUND to a section/line of the Balance Sheet (bs_group) and the Income
-- Statement (is_group), mirroring cf_bucket (0346) for the Cash-Flow statement. The report generators
-- resolve the account's OWN column first, then a canonical default map, then a type-based fallback
-- (ledger-statement-sections.ts) — so statements group nicely out of the box and a company can re-bind any
-- account from the Chart-of-Accounts dialog (GL-11). `accounts` is the shared canonical universe + per-tenant
-- overlay — ADD COLUMN only, no RLS change (mirror 0346).
-- bs_group: current_asset | noncurrent_asset | current_liability | noncurrent_liability | equity
-- is_group: revenue | cogs | selling_admin | other_income | other_expense | finance_cost | tax
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bs_group text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_group text;
