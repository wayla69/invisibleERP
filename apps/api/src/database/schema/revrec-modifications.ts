// Track D — Wave 3 (control REV-26): contract modifications under TFRS 15 / IFRS 15 / ASC 606 §18-21.
// When a contract changes (added/changed goods or services, or a price change), the change must be CLASSIFIED
// and accounted for as exactly one of three:
//   • separate_contract (§20)   — added goods are DISTINCT AND priced at their STANDALONE SELLING PRICE (SSP)
//                                 ⇒ account as a NEW independent contract; the original is untouched.
//   • prospective (§21a)        — added goods are distinct but NOT at SSP ⇒ terminate the old + create new:
//                                 RE-ALLOCATE the remaining (unrecognized) transaction price over the
//                                 remaining POs; NO catch-up on already-recognized revenue.
//   • cumulative_catchup (§21b) — added/changed goods are NOT distinct (part of a single performance
//                                 obligation) ⇒ adjust revenue at the modification date via a CATCH-UP JE.
// The classification is a management JUDGEMENT and IS the control — a wrong "separate_contract" call hides a
// required catch-up — so each modification is a maker-checker artifact (the maker records+classifies, a
// DIFFERENT user approves it, and only an approved modification may drive revenue). Extends the REV-19 engine
// (reuses allocateBySSP / buildSchedule / sumRecognized); no new COA (2410/1265/4300 already exist).
// tenant_id → RLS (canonical 0232 form). Table lives outside the src/modules coverage glob.
import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { revContracts } from './revrec-contracts';

export const revContractModifications = pgTable('rev_contract_modifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => revContracts.id),
  asOf: text('as_of').notNull(),                                      // 'YYYY-MM-DD' — the modification date
  type: text('type').notNull(),                                       // separate_contract | prospective | cumulative_catchup
  addedPrice: numeric('added_price', { precision: 18, scale: 4 }).notNull(),            // incremental consideration from the modification
  distinctFlag: boolean('distinct_flag').notNull(),                   // management judgement: are the added goods DISTINCT (§27)?
  atSspFlag: boolean('at_ssp_flag').notNull(),                        // management judgement: are they priced at their SSP (§20)?
  effectAmount: numeric('effect_amount', { precision: 18, scale: 4 }).notNull().default('0'), // applied effect (see note below)
  addedPos: text('added_pos'),                                        // JSON of the added performance-obligation dtos
  newContractId: bigint('new_contract_id', { mode: 'number' }),       // separate_contract → the linked new contract
  status: text('status').notNull().default('Pending'),               // Pending | Applied | Rejected — maker-checker
  note: text('note'),
  createdBy: text('created_by'),                                      // the MAKER (records + classifies)
  approvedBy: text('approved_by'),                                    // the CHECKER (≠ maker) who applied it
  appliedAt: timestamp('applied_at', { withTimezone: true }),        // set on approve when the modification drives revenue
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byContract: index('idx_rev_contract_mod_tenant').on(t.tenantId, t.contractId),
  byStatus: index('idx_rev_contract_mod_status').on(t.tenantId, t.status),
}));
// effect_amount semantics by type:
//   • separate_contract   — the new independent contract's total price (= added_price).
//   • prospective         — the re-allocated remaining consideration = (unrecognized old price) + added_price.
//   • cumulative_catchup  — the cumulative catch-up delta posted to GL on already-recognized revenue.

export type RevContractModification = typeof revContractModifications.$inferSelect;
