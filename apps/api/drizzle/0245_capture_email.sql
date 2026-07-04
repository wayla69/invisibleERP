-- Email-to-Capture (docs/34 Phase 4). A staffer's verified "send-from" address so a bill forwarded to the
-- tenant capture inbox is attributed to them (created_by) and gated on the low-risk pr_raise duty — draft
-- only, no GL. Mirrors the LINE identity-link columns (line_user_id / line_link_code / line_link_expires_at).
-- Convention: capture_email set + capture_email_code NULL ⇒ verified; code present ⇒ pending a mailed code.
ALTER TABLE users ADD COLUMN IF NOT EXISTS capture_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS capture_email_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS capture_email_expires_at timestamptz;
