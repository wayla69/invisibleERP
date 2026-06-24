// Automation rules (Platform Phase 13 — A4). A no-code "when EVENT [and CONDITION] then ACTION" engine over
// the events the app already emits (po.approved, po.rejected, alert.fired). A rule's ACTION is a non-GL,
// non-destructive side effect (in-app notification / LINE·SMS·email message / log). Generalizes the alert +
// workflow + webhook engines into one fabric. RLS-scoped, audited, never posts to the ledger.
import { pgTable, bigserial, bigint, text, jsonb, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const automationRules = pgTable('automation_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  eventType: text('event_type').notNull(),             // catalog key: po.approved | po.rejected | alert.fired
  condition: jsonb('condition'),                       // null = always; else { field, op (gt|gte|lt|lte|eq|ne|contains), value }
  action: jsonb('action').notNull(),                   // { type: 'notification'|'message'|'log', ... }
  active: boolean('active').notNull().default(true),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const automationExecutions = pgTable('automation_executions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  ruleId: bigint('rule_id', { mode: 'number' }),
  eventType: text('event_type'),
  status: text('status').notNull(),                    // executed | skipped | failed
  detail: text('detail'),
  firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow(),
});

export type AutomationRule = typeof automationRules.$inferSelect;
export type AutomationExecution = typeof automationExecutions.$inferSelect;
