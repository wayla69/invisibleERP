// Continuous controls monitoring (Platform Phase 19 — B5). Detective controls that scan the books for
// red flags — duplicate vendor invoices, split POs under an approval threshold, ghost/duplicate vendors,
// and AP-over-PO margin leakage. Findings are surfaced for human review; the monitor is read-only and
// posts NOTHING to the GL. RLS-scoped to each tenant.
import { pgTable, bigserial, bigint, text, numeric, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const controlFindings = pgTable('control_findings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  controlKey: text('control_key').notNull(),           // duplicate_invoice | split_po | ghost_vendor | margin_leakage
  severity: text('severity').notNull().default('warning'), // info | warning | critical
  entityRef: text('entity_ref'),                        // the offending key (vendor/invoice/po group)
  detail: text('detail'),                               // human-readable description
  amount: numeric('amount', { precision: 18, scale: 2 }),
  status: text('status').notNull().default('open'),     // open | reviewed | dismissed
  fingerprint: text('fingerprint').notNull(),           // stable hash so re-scans don't duplicate findings
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

export type ControlFinding = typeof controlFindings.$inferSelect;
