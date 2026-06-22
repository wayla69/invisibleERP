-- C2: PromptPay merchant target per tenant — enables a real, scannable EMVCo QR at checkout.
-- The QR encodes this id (mobile or 13-digit national/tax id); no external credentials needed to generate it.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS promptpay_id text;
