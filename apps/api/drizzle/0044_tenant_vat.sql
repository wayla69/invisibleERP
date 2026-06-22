-- A3: per-tenant VAT configuration. VAT was hardcoded 7% (ThaiTaxProvider / tax-invoice literals).
-- Store the rate + country per tenant so multi-country / rate-change is data, not code. Defaults keep
-- every existing tenant at TH 7% → no behavioural change.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vat_rate numeric(6,4) DEFAULT '0.0700';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tax_country text DEFAULT 'TH';
