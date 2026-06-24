// Alert/notification rules engine (Phase 3). Tenant-defined rules over a catalog of built-in metrics; a
// sweep evaluates them against live data and fires a notification (and optionally a LINE/SMS/email message)
// when the threshold is breached, with a per-rule cooldown. alert_events logs every fire.
import { pgTable, bigserial, bigint, text, numeric, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const alertRules = pgTable('alert_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  metric: text('metric').notNull(),                  // catalog key
  operator: text('operator').notNull().default('gte'), // gt | gte | lt | lte | eq
  threshold: numeric('threshold', { precision: 18, scale: 4 }).notNull().default('0'),
  channel: text('channel').notNull().default('notification'), // notification | line | sms | email
  targetRole: text('target_role'),
  targetTo: text('target_to'),
  severity: text('severity').notNull().default('warning'), // info | warning | critical
  cooldownHours: integer('cooldown_hours').notNull().default(12),
  active: boolean('active').notNull().default(true),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const alertEvents = pgTable('alert_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  ruleId: bigint('rule_id', { mode: 'number' }),
  name: text('name'),
  metric: text('metric'),
  value: numeric('value', { precision: 18, scale: 4 }),
  threshold: numeric('threshold', { precision: 18, scale: 4 }),
  severity: text('severity'),
  channel: text('channel'),
  message: text('message'),
  firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow(),
});

export type AlertRule = typeof alertRules.$inferSelect;
export type AlertEvent = typeof alertEvents.$inferSelect;
