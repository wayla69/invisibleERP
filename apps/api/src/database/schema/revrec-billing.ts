// Track D — Wave 1 (REV-24): independent billing schedule + contract-asset / contract-liability split under
// TFRS 15 / IFRS 15 / ASC 606 §105-107. Billing is DECOUPLED from recognition: a contract's revenue is
// recognized as performance obligations are satisfied (revrec_schedules, REV-19), while invoices are raised
// on their OWN milestone/period schedule here. When recognition runs AHEAD of billing the surplus is a
// contract ASSET (1265 unbilled receivable); when billing runs ahead of recognition the surplus is a
// contract LIABILITY (2410 deferred revenue). Billing reclasses the earned contract asset 1265 → 1100 AR.
// Maker-checker (REV-24): the user who DEFINES a billing milestone may not be the one who bills it (SoD).
// tenant_id → canonical 0232-form RLS. See docs/process-narratives/12-revenue-recognition-billing.md.
import { pgTable, bigserial, bigint, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { revContracts } from './revrec-contracts';

export const revBillingSchedules = pgTable('rev_billing_schedules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => revContracts.id),
  period: text('period').notNull(),                          // 'YYYY-MM' invoice milestone/period
  plannedAmount: numeric('planned_amount', { precision: 18, scale: 4 }).notNull(),
  billedAmount: numeric('billed_amount', { precision: 18, scale: 4 }).notNull().default('0'),
  invoiceRef: text('invoice_ref'),
  status: text('status').notNull().default('Planned'),       // Planned | Billed
  billedEntryId: bigint('billed_entry_id', { mode: 'number' }),
  createdBy: text('created_by'),                             // MAKER — defines the milestone (SoD principal)
  billedBy: text('billed_by'),                              // CHECKER — raises the invoice (must ≠ createdBy)
  billedAt: timestamp('billed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenantContract: index('idx_rev_billing_sched_tenant').on(t.tenantId, t.contractId),
  byStatus: index('idx_rev_billing_sched_status').on(t.tenantId, t.period, t.status),
}));

export type RevBillingSchedule = typeof revBillingSchedules.$inferSelect;
