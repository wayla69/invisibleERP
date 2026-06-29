-- 0178_ai_token_usage: per-tenant daily AI token budget tracking (ITGC-SEC-AI-01)
-- Written by the AUTOCOMMIT pg client so usage survives request rollbacks.

CREATE TABLE IF NOT EXISTS ai_token_usage (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  usage_date    DATE NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, usage_date)
);

-- Add daily token budget to plan features.
-- Pro: 50 000 tokens/day (~50 Opus turns or ~200 Sonnet turns).
-- Enterprise: -1 = unlimited.
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"ai_tokens_daily": 50000}'::jsonb WHERE code = 'pro';
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"ai_tokens_daily": -1}'::jsonb WHERE code = 'enterprise';
