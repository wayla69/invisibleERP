-- Accounting Tier 3 batch 3 — Multi-ledger / Multi-GAAP (สมุดบัญชีหลายเล่ม / หลายมาตรฐาน).
-- ledgers is GLOBAL config (like accounts/COA) — no tenant_id, no RLS. Seeded in code (seedLedgers).
CREATE TABLE IF NOT EXISTS ledgers (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  gaap text NOT NULL,
  is_leading boolean DEFAULT false,
  currency text DEFAULT 'THB',
  description text,
  active boolean DEFAULT true
);

-- ledger_code on the journal header: NULL = shared across ALL ledgers (every existing posting stays
-- shared → backward compatible); a code = a GAAP-divergent adjustment posted to that ledger only.
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS ledger_code text;
CREATE INDEX IF NOT EXISTS idx_je_ledger ON journal_entries (ledger_code);
