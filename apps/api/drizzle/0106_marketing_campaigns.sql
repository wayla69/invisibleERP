-- LINE marketing automation: closed-loop campaigns + per-member coupon sends (redemption tracked to sale).
CREATE TABLE IF NOT EXISTS automation_campaigns (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  trigger text NOT NULL,
  channel text NOT NULL DEFAULT 'line',
  coupon_prefix text,
  discount_type text,
  discount_value numeric(14,2) DEFAULT '0',
  status text NOT NULL DEFAULT 'sent',
  created_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  campaign_id bigint REFERENCES automation_campaigns(id),
  member_id bigint REFERENCES pos_members(id),
  coupon_code text,
  channel text,
  recipient text,
  status text NOT NULL,
  error text,
  sent_at timestamptz DEFAULT now(),
  redeemed_at timestamptz,
  redeemed_sale_no text,
  redeemed_value numeric(14,2),
  created_by text
);
-- one coupon code per tenant — the redemption key
CREATE UNIQUE INDEX IF NOT EXISTS campaign_sends_tenant_coupon ON campaign_sends (tenant_id, coupon_code);
