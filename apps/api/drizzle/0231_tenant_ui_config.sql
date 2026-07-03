-- 0231_tenant_ui_config — per-tenant menu & module customization (SaaS: each tenant configures its OWN
-- sidebar + module on/off). Supersedes the global module_configs (module on/off + nav:<href> visibility)
-- and nav_group_order (category/item order) for these purposes; those tables are kept for the backfill only.
--
-- A GLOBAL table (no RLS) that is logically tenant-scoped — like `notifications`, every query filters by
-- `tenant_id` EXPLICITLY. This is deliberate and load-bearing: ModuleEnabledGuard reads the disabled-module
-- set OUTSIDE the per-request RLS transaction (guards run before the tenant-tx interceptor), so an RLS
-- policy would return zero rows there and silently break API enforcement. Explicit filtering is the same
-- pattern the notification inbox uses for exactly this reason.
--
-- One JSON blob per tenant: { modulesOff:string[], hidden:string[], groupOrder:string[], itemOrder:{scope:href[]} }.
CREATE TABLE IF NOT EXISTS tenant_ui_config (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);

-- Backfill: replicate the current GLOBAL settings to EVERY tenant so nothing resets on cutover (in
-- particular the already-disabled modules). After this, each tenant owns an independent copy it can diverge.
-- (itemOrder shipped same-day and is left empty here — negligible/no prod data — rather than parse it in SQL.)
INSERT INTO tenant_ui_config (tenant_id, config)
SELECT t.id, jsonb_build_object(
  'modulesOff', COALESCE((SELECT jsonb_agg(module_key) FROM module_configs WHERE enabled = false AND module_key NOT LIKE 'nav:%'), '[]'::jsonb),
  'hidden',     COALESCE((SELECT jsonb_agg(substr(module_key, 5)) FROM module_configs WHERE enabled = false AND module_key LIKE 'nav:%'), '[]'::jsonb),
  'groupOrder', COALESCE((SELECT jsonb_agg(group_key ORDER BY sort_order) FROM nav_group_order WHERE group_key NOT LIKE 'item:%'), '[]'::jsonb),
  'itemOrder',  '{}'::jsonb
)
FROM tenants t
ON CONFLICT (tenant_id) DO NOTHING;
