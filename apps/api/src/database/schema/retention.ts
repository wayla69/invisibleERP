import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Shared retention sub-ledger (docs/35 Phase 0). A construction/real-estate contract withholds retention
// (เงินประกันผลงาน) on each certified progress claim (customer / AR side, Track A) or subcontract valuation
// (subcontractor / AP side, Track B) and releases it in tranches. This ledger tracks withheld vs released per
// party/document (outstanding = withheld − released); the GL journal touching the retention receivable (1170)
// / payable (2440) account is posted by the certifying service in the same transaction — the ledger records
// balances only, like the commitment ledger (docs/32) records encumbrance without posting GL.
export const retentionLedger = pgTable(
  'retention_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    partyType: text('party_type').notNull(),                 // customer | subcontractor
    projectId: bigint('project_id', { mode: 'number' }),     // the project this retention relates to (nullable)
    partyRef: text('party_ref'),                             // customer name / subcontract no
    sourceDocType: text('source_doc_type').notNull().default('MANUAL'), // CLAIM | SUBVAL | MANUAL
    sourceDocNo: text('source_doc_no').notNull(),
    glAccount: text('gl_account').notNull(),                 // 1170 (receivable) | 2440 (payable)
    withheldAmount: numeric('withheld_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    releasedAmount: numeric('released_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('held'),        // held | partially_released | released
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_retention_project').on(t.tenantId, t.projectId), bySource: index('idx_retention_source').on(t.sourceDocType, t.sourceDocNo) }),
);

// Release schedule — the tranches by which the withheld amount becomes due (a fixed date, practical
// completion, or defect-liability-period end). A pending tranche whose due_date has passed feeds the
// retention "due" worklist (later: the action-center `retention_due` exception).
export const retentionReleaseSchedule = pgTable(
  'retention_release_schedule',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    retentionId: bigint('retention_id', { mode: 'number' }).notNull().references(() => retentionLedger.id),
    trancheNo: integer('tranche_no').notNull().default(1),
    dueBasis: text('due_basis').notNull().default('date'),   // date | practical_completion | dlp_end
    pct: numeric('pct', { precision: 9, scale: 4 }),         // % of withheld for this tranche (nullable if amount given)
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull().default('0'),
    dueDate: date('due_date'),
    status: text('status').notNull().default('pending'),     // pending | released
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byRet: index('idx_retention_sched_ret').on(t.retentionId), byDue: index('idx_retention_sched_due').on(t.tenantId, t.status, t.dueDate) }),
);

export type RetentionLedgerRow = typeof retentionLedger.$inferSelect;
export type RetentionReleaseTranche = typeof retentionReleaseSchedule.$inferSelect;
