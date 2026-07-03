-- 0230_nav_group_order — system-wide sidebar CATEGORY ordering (admin-curated, applies to everyone).
-- A global table (no tenant_id → no RLS), mirroring module_configs: an admin arranges the nav groups
-- (หมวด) by importance in Settings → Menu, and every user's sidebar renders groups by ascending
-- sort_order. Groups absent from this table (e.g. newly shipped ones) fall back to their code order.
-- Presentation-only chrome — posts nothing to the GL and changes no permission/data-access path.
CREATE TABLE IF NOT EXISTS nav_group_order (
  group_key text PRIMARY KEY,
  sort_order integer NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);
