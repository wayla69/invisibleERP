// Track D — Wave 2 (control REV-25): variable consideration + the constraint under TFRS 15 / IFRS 15 /
// ASC 606 §50-59. The REV-19 engine holds a FIXED transaction price (rev_contracts.total_price). A contract
// with variable consideration (rebates, refunds, performance bonuses/penalties, price concessions, usage
// tiers) must (1) ESTIMATE the variable amount — expected value (Σ prob×amount) OR most-likely amount — then
// (2) CONSTRAIN it to the portion that is highly probable NOT to reverse (the "constraint"), (3) re-estimate
// each reporting period, and (4) TRUE-UP already-recognized revenue via a cumulative catch-up when the
// estimate changes. Each estimate is a management judgement: it is a maker-checker artifact (estimator ≠
// approver) and only the CONSTRAINED amount (never the gross estimate) is added to the recognizable
// transaction price. tenant_id → RLS (0232-form). Table lives outside the src/modules/tax coverage glob.
import { pgTable, bigserial, bigint, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { revContracts } from './revrec-contracts';

export const revVariableEstimates = pgTable('rev_variable_estimates', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => revContracts.id),
  asOf: text('as_of').notNull(),                                    // 'YYYY-MM-DD' — the reporting date of the estimate
  method: text('method').notNull(),                                 // 'expected_value' | 'most_likely'
  grossEstimate: numeric('gross_estimate', { precision: 18, scale: 4 }).notNull(),          // the raw estimate of variable consideration
  constrainedAmount: numeric('constrained_amount', { precision: 18, scale: 4 }).notNull(),  // capped to the highly-probable-not-to-reverse portion (≤ gross)
  postedDelta: numeric('posted_delta', { precision: 18, scale: 4 }).notNull().default('0'), // the true-up catch-up posted to GL when applied
  status: text('status').notNull().default('Pending'),             // Pending | Approved | Rejected — maker-checker
  note: text('note'),
  createdBy: text('created_by'),                                   // the ESTIMATOR (maker)
  approvedBy: text('approved_by'),                                 // the APPROVER (checker ≠ maker)
  appliedAt: timestamp('applied_at', { withTimezone: true }),     // set by /reestimate when the approved estimate drives revenue
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byContract: index('idx_rev_var_est_tenant').on(t.tenantId, t.contractId),
  byStatus: index('idx_rev_var_est_status').on(t.tenantId, t.status),
}));

export type RevVariableEstimate = typeof revVariableEstimates.$inferSelect;
