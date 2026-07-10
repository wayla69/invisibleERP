-- 0312_dine_in_seat — seat-level ordering (POS-9). Add a nullable `seat` column to the tenant-scoped
-- dine_in_order_items so each fired kitchen line can be attributed to a guest seat within the table/order
-- (NULL = shared/table). Enables order/fire/course per seat and split-by-seat at settlement (reuses the
-- split-bill spine). The existing tenant_isolation RLS policy already covers the table → a new column needs
-- no RLS loop. Index-light: seat filters always ride the existing order_id-scoped scans.
ALTER TABLE dine_in_order_items ADD COLUMN IF NOT EXISTS seat integer;
