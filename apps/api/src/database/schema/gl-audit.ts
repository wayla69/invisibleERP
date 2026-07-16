import { pgTable, bigserial, bigint, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// WS2.2 (GL-17) — GL audit trail. Every important GL action (POST, APPROVE, REVERSE) and every blocked
// mutation attempt (MUTATE_BLOCKED) against a posted entry is recorded here for the SOX/ICFR audit trail.
// Append-only by intent (the prod DB also guards the primary audit_log table, ITGC-AC-10).
export const glAuditLog = pgTable('gl_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  entryId: bigint('entry_id', { mode: 'number' }),
  action: text('action').notNull(),     // 'POST' | 'APPROVE' | 'REVERSE' | 'MUTATE_BLOCKED' | 'EXCEPTION_DISMISSED'
  actor: text('actor'),
  detail: jsonb('detail'),
  at: timestamp('at', { withTimezone: true }).defaultNow(),
});
export type GlAuditLog = typeof glAuditLog.$inferSelect;

// B5 (docs/50 Wave 5, GL-28) — the JE anomaly/exception register. One row per tenant × rule × entry
// (idempotent re-scan via the coalesce unique index in 0424); dismiss-with-reason is audit-logged to
// gl_audit_log (action EXCEPTION_DISMISSED) — the periodic-review evidence.
export const jeExceptions = pgTable('je_exceptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  ruleKey: text('rule_key').notNull(),  // duplicate_je | round_amount | backdated | after_hours | unusual_pair
  entryId: bigint('entry_id', { mode: 'number' }).notNull(),
  entryNo: text('entry_no'),
  severity: text('severity').notNull().default('medium'), // high | medium | low
  detail: jsonb('detail'),
  status: text('status').notNull().default('open'),       // open | dismissed
  dismissedBy: text('dismissed_by'),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  dismissReason: text('dismiss_reason'),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow(),
});
export type JeException = typeof jeExceptions.$inferSelect;
