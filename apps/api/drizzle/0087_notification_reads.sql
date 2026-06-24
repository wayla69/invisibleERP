-- 0087_notification_reads — per-user read state for the notification inbox.
-- The notifications table carries only a single shared is_read boolean, which is
-- wrong for the inbox: a notification is targeted at a (tenant, role) pair and may
-- have many recipients, so one person marking it read must not flip it for everyone.
-- This table records read state PER USER. No tenant_id column → not RLS-scoped here;
-- the inbox query already scopes rows by joining to notifications (target_tenant_id +
-- target_role) and filters reads by the caller's own username, so a user can only ever
-- see/insert their own read markers.
CREATE TABLE IF NOT EXISTS notification_reads (
  id bigserial PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  username text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, username)
);
CREATE INDEX IF NOT EXISTS idx_notification_reads_username ON notification_reads (username);
CREATE INDEX IF NOT EXISTS idx_notification_reads_notif ON notification_reads (notification_id);
