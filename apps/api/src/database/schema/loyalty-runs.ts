// CRM Phase 1.5 — loyalty points-liability GL posting runs (watermarked accrual).
// Each run reconciles GL control account 2250 (Loyalty Points Liability) to the outstanding points
// sub-ledger × fair value, cursoring on pos_member_ledger.id (watermark) so each movement posts once.
// Mirrors depreciation_runs (apps/api/src/database/schema/assets.ts) but watermarked, not period-keyed.
import { pgTable, bigserial, bigint, text, numeric, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const loyaltyPostingRuns = pgTable('loyalty_posting_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runNo: text('run_no').notNull(),
  watermarkId: bigint('watermark_id', { mode: 'number' }).notNull(), // MAX(pos_member_ledger.id) processed (inclusive)
  outstandingPoints: numeric('outstanding_points').default('0'),
  fairValuePerPoint: numeric('fair_value_per_point', { precision: 14, scale: 6 }).default('0'),
  targetLiability: numeric('target_liability', { precision: 18, scale: 4 }).default('0'),
  priorLiability: numeric('prior_liability', { precision: 18, scale: 4 }).default('0'),
  liabilityDelta: numeric('liability_delta', { precision: 18, scale: 4 }).default('0'),
  earnedPoints: numeric('earned_points').default('0'),
  redeemedPoints: numeric('redeemed_points').default('0'),
  journalNo: text('journal_no'),                                    // back-ref to the posted JE (null = no-change run)
  createdBy: text('created_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqWatermark: uniqueIndex('loyalty_posting_runs_tenant_wm').on(t.tenantId, t.watermarkId),
  idxTenant: index('idx_loyalty_posting_runs_tenant').on(t.tenantId),
}));

export type LoyaltyPostingRun = typeof loyaltyPostingRuns.$inferSelect;
