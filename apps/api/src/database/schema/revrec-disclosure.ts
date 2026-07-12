// Track D — Wave 4 (control REV-27, FINAL): significant financing component + revenue disclosure pack under
// TFRS 15 / IFRS 15 / ASC 606 §60-65 (financing) + §120 (disclosure).
//
// (A) Significant financing component (§60-65): when the TIMING of payment gives the customer or the entity a
//     MATERIAL financing benefit, the promised consideration is adjusted to its cash-selling-price PRESENT
//     VALUE and the difference (face − PV) is recognized as interest, UNWOUND over the contract using the
//     effective-interest method (the same EIR primitive the lease engine uses, LSE-01). Two directions:
//       • advance (customer PREPAYS)   — the financing benefit unwinds as financing interest INCOME (4650),
//                                        releasing a slice of the contract liability: Dr 2410 / Cr 4650.
//       • arrears (deferred payment)   — the entity finances the customer; the financing charge accretes the
//                                        contract asset / receivable against the net interest line: Dr 1265 / Cr 5900.
//     The DISCOUNT RATE is a management judgement → maker-checker (REV-27): the maker records+rates the
//     component (rows land 'Pending', drive NOTHING), a DIFFERENT user approves it, and only an APPROVED
//     component may post its interest unwind. All GL routes through LedgerService.postEntry (PERIOD_LOCKED +
//     GL-17 audit), idempotent via alreadyPosted.
//
// (B) Disclosure pack (§120) — the contract-liability rollforward + the RPO (remaining-performance-obligation /
//     backlog) report — are READ-ONLY aggregators over the GL (2410/1265) and the recognition schedule; they
//     add NO table.
//
// rev_financing_schedules — the per-contract financing-component interest schedule (tenant-scoped, leading
// (tenant_id, contract_id) index + the CANONICAL 0232-form tenant_isolation RLS policy). Table lives outside
// the src/modules coverage glob (harness-tested).
import { pgTable, bigserial, bigint, integer, text, numeric, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { revContracts } from './revrec-contracts';

export const revFinancingSchedules = pgTable('rev_financing_schedules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => revContracts.id),
  seq: integer('seq').notNull(),                                      // 1..periods — the unwind period ordinal
  period: text('period').notNull(),                                  // 'YYYY-MM' the interest accrues in
  direction: text('direction').notNull(),                            // advance (prepay → 4650 income) | arrears (deferred → 5900)
  discountRatePct: numeric('discount_rate_pct', { precision: 9, scale: 4 }).notNull(), // annual discount rate (judgement)
  nominal: numeric('nominal', { precision: 18, scale: 4 }).notNull(),                    // the face/undiscounted amount
  presentValue: numeric('present_value', { precision: 18, scale: 4 }).notNull(),         // the discounted cash-selling price
  openingBalance: numeric('opening_balance', { precision: 18, scale: 4 }).notNull(),     // amortized-cost balance b/f
  interestAmount: numeric('interest_amount', { precision: 18, scale: 4 }).notNull(),     // EIR interest this period (Σ = face − PV)
  closingBalance: numeric('closing_balance', { precision: 18, scale: 4 }).notNull(),     // balance c/f (last = nominal)
  status: text('status').notNull().default('Pending'),               // Pending | Approved | Rejected — maker-checker
  posted: boolean('posted').notNull().default(false),                // has the interest unwind been posted to GL?
  entryNo: text('entry_no'),                                         // the REVFIN journal entry_no once posted
  note: text('note'),
  createdBy: text('created_by'),                                     // the MAKER (records + rates the component)
  approvedBy: text('approved_by'),                                   // the CHECKER (≠ maker) who approved the rate
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byContract: index('idx_rev_financing_sched_tenant').on(t.tenantId, t.contractId),
  byStatus: index('idx_rev_financing_sched_status').on(t.tenantId, t.status),
}));

export type RevFinancingSchedule = typeof revFinancingSchedules.$inferSelect;
