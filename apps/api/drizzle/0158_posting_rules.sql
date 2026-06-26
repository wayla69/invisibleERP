-- 0156_posting_rules: Posting / account-determination engine (WS1.2)
-- Creates posting_event_types and posting_rules tables + seeds all current event types.

CREATE TABLE IF NOT EXISTS posting_event_types (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS posting_rules (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  event_type      TEXT NOT NULL REFERENCES posting_event_types(key),
  leg_order       SMALLINT NOT NULL,
  role            TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('DR','CR')),
  account_code    TEXT NOT NULL,
  dimension_source TEXT,
  condition       JSONB,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_posting_rules
  ON posting_rules (COALESCE(tenant_id,0), event_type, leg_order);

-- RLS on posting_rules (tenant_id nullable — NULL = global default, visible to all)
ALTER TABLE posting_rules ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='posting_rules' AND policyname='tenant_isolation_posting_rules'
  ) THEN
    CREATE POLICY tenant_isolation_posting_rules ON posting_rules
      USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT);
  END IF;
END $$;

-- Seed event types (catalogue of all business events that post to the GL)
INSERT INTO posting_event_types (key, name, description) VALUES
  ('SALE.FOOD',         'Food & beverage sale',        'POS / restaurant sale — revenue + VAT + cash/AR'),
  ('SALE.VAT',          'Output VAT on sale',           'VAT output leg of a sale'),
  ('GR.INVENTORY',      'Goods receipt — inventory',    'Dr Inventory / Cr AP on purchase receipt'),
  ('GR.AP',             'Goods receipt — AP',           'AP control leg of goods receipt'),
  ('PAYROLL.GROSS',     'Payroll — gross wages',        'Dr Wages / Cr AP-Payroll'),
  ('PAYROLL.SSO',       'Payroll — social security',    'Employer SSO Dr Expense / Cr Payable'),
  ('PAYROLL.WHT',       'Payroll — income WHT',         'Dr Payroll-WHT-Payable'),
  ('PAYROLL.PF',        'Payroll — provident fund',     'Employer PF Dr Expense / Cr Payable'),
  ('DEPRECIATION.FA',   'Fixed-asset depreciation',     'Dr Dep.Exp 5200 / Cr Accum.Dep 1590'),
  ('DEPRECIATION.ROU',  'ROU asset depreciation',       'Dr Dep.Exp 5210 / Cr Accum.Dep-ROU 1690'),
  ('LEASE.INTEREST',    'Lease liability interest',     'Dr Interest Exp 5900 / Cr Lease Liability 2600'),
  ('ADVANCE.ISSUE',     'Cash advance issued',          'Dr Employee Advances 1180 / Cr Cash 1000'),
  ('ADVANCE.SETTLE',    'Cash advance settled',         'Dr Expense / Dr Cash (returned) / Cr 1180'),
  ('BADDEBT.WRITEOFF',  'Bad debt write-off',           'Dr Bad Debt Exp 5720 / Cr AR 1100'),
  ('FX.UNREALIZED',     'FX unrealized gain/loss',      'Dr/Cr 5400 FX Gain/Loss (Unrealized)'),
  ('FX.REALIZED',       'FX realized gain/loss',        'Dr/Cr 5410 FX Gain/Loss (Realized)'),
  ('RETURN.STOCK',      'Customer return — stock',      'Dr Inventory / Cr COGS on return'),
  ('RETURN.AR',         'Customer return — AR reversal','Dr Revenue / Dr VAT / Cr AR on return'),
  ('COSTING.RECEIPT',   'Inventory receipt (costing)',  'Dr Inventory 1200 / Cr AP 2000 at cost'),
  ('COSTING.ISSUE',     'Inventory issue (costing)',    'Dr COGS 5000 / Cr Inventory 1200'),
  ('COSTING.PPV',       'Purchase price variance (STD)','Dr/Cr PPV 5500'),
  ('LEASE.PRINCIPAL',   'Lease principal payment',      'Dr Lease Liability 2600 / Cr Cash 1000'),
  ('GIFTCARD.ISSUE',    'Gift card / store credit',     'Dr Cash 1000 / Cr Customer Deposits 2200'),
  ('GIFTCARD.REDEEM',   'Gift card redemption',         'Dr Customer Deposits 2200 / Cr Revenue 4000'),
  ('IC.TRANSACTION',    'Intercompany transaction',     'Dr IC Receivable 1150 / Cr IC Payable 2150'),
  ('PROJECT.COST',      'Project cost accrual',         'Dr Project WIP 1260 / Cr Project Costs Applied 2390'),
  ('PROJECT.REVENUE',   'Project revenue recognition',  'Dr AR 1100 / Cr Project Revenue 4200'),
  ('SERVICE.ACCRUAL',   'Service subscription billing', 'Dr AR / Cr Subscription Revenue 4300')
ON CONFLICT (key) DO NOTHING;

-- Seed global default posting rules (match existing inline account_code literals exactly)
INSERT INTO posting_rules (tenant_id, event_type, leg_order, role, side, account_code) VALUES
  -- SALE.FOOD: Dr Cash/AR, Cr Revenue, Cr VAT Payable
  (NULL, 'SALE.FOOD',        1, 'cash_or_ar',   'DR', '1000'),
  (NULL, 'SALE.FOOD',        2, 'revenue',       'CR', '4000'),
  (NULL, 'SALE.FOOD',        3, 'vat_output',    'CR', '2100'),
  -- GR.INVENTORY + GR.AP (goods receipt)
  (NULL, 'GR.INVENTORY',     1, 'inventory',     'DR', '1200'),
  (NULL, 'GR.INVENTORY',     2, 'ap_control',    'CR', '2000'),
  -- PAYROLL legs
  (NULL, 'PAYROLL.GROSS',    1, 'wages_expense', 'DR', '5600'),
  (NULL, 'PAYROLL.GROSS',    2, 'ap_payroll',    'CR', '2000'),
  (NULL, 'PAYROLL.SSO',      1, 'sso_expense',   'DR', '5610'),
  (NULL, 'PAYROLL.SSO',      2, 'sso_payable',   'CR', '2350'),
  (NULL, 'PAYROLL.WHT',      1, 'wht_payable',   'CR', '2360'),
  (NULL, 'PAYROLL.PF',       1, 'pf_expense',    'DR', '5620'),
  (NULL, 'PAYROLL.PF',       2, 'pf_payable',    'CR', '2370'),
  -- DEPRECIATION
  (NULL, 'DEPRECIATION.FA',  1, 'dep_expense',   'DR', '5200'),
  (NULL, 'DEPRECIATION.FA',  2, 'accum_dep',     'CR', '1590'),
  (NULL, 'DEPRECIATION.ROU', 1, 'dep_expense',   'DR', '5210'),
  (NULL, 'DEPRECIATION.ROU', 2, 'accum_dep_rou', 'CR', '1690'),
  -- LEASE
  (NULL, 'LEASE.INTEREST',   1, 'interest_exp',  'DR', '5900'),
  (NULL, 'LEASE.INTEREST',   2, 'lease_liab',    'CR', '2600'),
  (NULL, 'LEASE.PRINCIPAL',  1, 'lease_liab',    'DR', '2600'),
  (NULL, 'LEASE.PRINCIPAL',  2, 'cash',          'CR', '1000'),
  -- ADVANCE
  (NULL, 'ADVANCE.ISSUE',    1, 'advance_asset', 'DR', '1180'),
  (NULL, 'ADVANCE.ISSUE',    2, 'cash',          'CR', '1000'),
  -- BADDEBT
  (NULL, 'BADDEBT.WRITEOFF', 1, 'bad_debt_exp',  'DR', '5720'),
  (NULL, 'BADDEBT.WRITEOFF', 2, 'ar_control',    'CR', '1100'),
  -- FX
  (NULL, 'FX.UNREALIZED',    1, 'fx_gain_loss',  'DR', '5400'),
  (NULL, 'FX.REALIZED',      1, 'fx_gain_loss',  'DR', '5410'),
  -- COSTING
  (NULL, 'COSTING.RECEIPT',  1, 'inventory',     'DR', '1200'),
  (NULL, 'COSTING.RECEIPT',  2, 'ap_control',    'CR', '2000'),
  (NULL, 'COSTING.ISSUE',    1, 'cogs',          'DR', '5000'),
  (NULL, 'COSTING.ISSUE',    2, 'inventory',     'CR', '1200'),
  (NULL, 'COSTING.PPV',      1, 'ppv',           'DR', '5500'),
  -- GIFTCARD
  (NULL, 'GIFTCARD.ISSUE',   1, 'cash',          'DR', '1000'),
  (NULL, 'GIFTCARD.ISSUE',   2, 'customer_dep',  'CR', '2200'),
  (NULL, 'GIFTCARD.REDEEM',  1, 'customer_dep',  'DR', '2200'),
  (NULL, 'GIFTCARD.REDEEM',  2, 'revenue',       'CR', '4000'),
  -- IC
  (NULL, 'IC.TRANSACTION',   1, 'ic_receivable', 'DR', '1150'),
  (NULL, 'IC.TRANSACTION',   2, 'ic_payable',    'CR', '2150'),
  -- PROJECT
  (NULL, 'PROJECT.COST',     1, 'project_wip',   'DR', '1260'),
  (NULL, 'PROJECT.COST',     2, 'proj_applied',  'CR', '2390'),
  (NULL, 'PROJECT.REVENUE',  1, 'ar_control',    'DR', '1100'),
  (NULL, 'PROJECT.REVENUE',  2, 'proj_revenue',  'CR', '4200'),
  -- SERVICE
  (NULL, 'SERVICE.ACCRUAL',  1, 'ar_control',    'DR', '1100'),
  (NULL, 'SERVICE.ACCRUAL',  2, 'service_rev',   'CR', '4300')
ON CONFLICT DO NOTHING;
