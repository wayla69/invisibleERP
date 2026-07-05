import { pgTable, bigserial, bigint, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// God-facing platform event feed (migration 0247). Platform-level (no tenant_id scoping ⇒ the RLS loop never
// treats this as a tenant table); only platform owners read it via the @PlatformAdmin bypass. `tenant_id` is
// which company the event is ABOUT (nullable), not a scoping column.
export const platformNotifications = pgTable('platform_notifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  type: text('type').notNull(), // signup_request | company_provisioned | tenant_suspended | tenant_reactivated
  title: text('title').notNull(),
  body: text('body'),
  tenantId: bigint('tenant_id', { mode: 'number' }),
  refType: text('ref_type'),
  refId: text('ref_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byCreated: index('platform_notifications_created_idx').on(t.createdAt) }));

// Per-god read state (a notification is broadcast to all gods; each marks its own read).
export const platformNotificationReads = pgTable('platform_notification_reads', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  notificationId: bigint('notification_id', { mode: 'number' }).notNull().references(() => platformNotifications.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex('platform_notification_reads_uq').on(t.notificationId, t.username) }));
