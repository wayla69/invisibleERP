-- 0346 (docs/43 PR-8): a NEW balance-sheet account self-declares its indirect-SCF bucket and
-- current/non-current classification, so the hardcoded CF_CLASSIFY map / metrics account lists become
-- FALLBACKS instead of the only source (a fresh account no longer lands "unclassified" until a code
-- change). `accounts` is the shared canonical universe + per-tenant overlay — ADD COLUMN only, no RLS
-- change. cf_bucket: operating | investing | financing | addback (matches ledger-constants CfBucket).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cf_bucket text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cf_label text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_current boolean;
