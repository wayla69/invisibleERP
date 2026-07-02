-- 0227: LINE OA chat → raise Purchase Requisition (PR)
-- Staff link their LINE identity to their ERP account (one-time code shown on /requisitions, typed into
-- the shop's LINE OA chat). line_user_id is the stable LINE userId; the link code is short-lived.
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_user_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_link_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_link_expires_at timestamptz;
--> statement-breakpoint
-- One LINE account binds to at most one staff user (and vice versa); NULLs stay distinct.
CREATE UNIQUE INDEX IF NOT EXISTS users_line_user_id_uq ON users (line_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_line_link_code_uq ON users (line_link_code);
