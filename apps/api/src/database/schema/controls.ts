// Continuous controls monitoring (Platform Phase 19 — B5; GRC-4 disposition + KCI, migration 0336). Detective
// controls that scan the books for red flags — duplicate vendor invoices, duplicate payments, ghost/duplicate
// vendors, split POs under an approval threshold, weekend/after-hours manual JEs, and dormant-vendor
// reactivation. Findings are surfaced for a MANAGED disposition (accountable owner + due date + root cause,
// tracked to closure) and rolled up into KCIs (key-control-indicators). The monitor is read-only and posts
// NOTHING to the GL. RLS-scoped to each tenant.
import { pgTable, bigserial, bigint, text, numeric, timestamp, date } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const controlFindings = pgTable('control_findings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  controlKey: text('control_key').notNull(),           // duplicate_invoice | duplicate_amount | ghost_vendor | split_po | weekend_je | dormant_vendor
  severity: text('severity').notNull().default('warning'), // info | warning | critical
  entityRef: text('entity_ref'),                        // the offending key (vendor/invoice/po group)
  detail: text('detail'),                               // human-readable description
  amount: numeric('amount', { precision: 18, scale: 2 }),
  status: text('status').notNull().default('open'),     // open | reviewed | dismissed (legacy quick-review action)
  fingerprint: text('fingerprint').notNull(),           // stable hash so re-scans don't duplicate findings
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  // ── GRC-4 (GOV-02): managed disposition — an exception is owned, dated, root-caused and tracked to closure ──
  rcmRef: text('rcm_ref'),                              // the RCM control ID this exception relates to (e.g. EXP-10)
  disposition: text('disposition').notNull().default('open'), // open | investigating | remediated | accepted | false_positive
  owner: text('owner'),                                 // accountable remediation owner (username)
  dueDate: date('due_date'),                            // remediation due date (business day)
  rootCause: text('root_cause'),                        // documented root cause
  remediatedBy: text('remediated_by'),                  // who closed it (remediated / accepted / false_positive)
  remediatedAt: timestamp('remediated_at', { withTimezone: true }),
});

export type ControlFinding = typeof controlFindings.$inferSelect;
