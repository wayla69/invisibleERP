import { pgTable, bigserial, bigint, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// WS2.2 (GL-17) — GL audit trail. Every important GL action (POST, APPROVE, REVERSE) and every blocked
// mutation attempt (MUTATE_BLOCKED) against a posted entry is recorded here for the SOX/ICFR audit trail.
// Append-only by intent (the prod DB also guards the primary audit_log table, ITGC-AC-10).
export const glAuditLog = pgTable('gl_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  entryId: bigint('entry_id', { mode: 'number' }),
  action: text('action').notNull(),     // 'POST' | 'APPROVE' | 'REVERSE' | 'MUTATE_BLOCKED'
  actor: text('actor'),
  detail: jsonb('detail'),
  at: timestamp('at', { withTimezone: true }).defaultNow(),
});
export type GlAuditLog = typeof glAuditLog.$inferSelect;
