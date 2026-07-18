-- 0437_session_member — link a loyalty member to a table session (F3, "ผูกสมาชิกที่โต๊ะ").
-- The diner enters/scans a member code or phone on the QR page; the session carries the member so the
-- QR-settled sale earns points (via buildSale's existing member earn). Nullable column on an existing
-- tenant-scoped table ⇒ no RLS loop / no index change needed.
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS member_id bigint REFERENCES pos_members(id);
