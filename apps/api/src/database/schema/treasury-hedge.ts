import { pgTable, bigserial, bigint, text, numeric, date, timestamp, boolean, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Hedge accounting register (Track C Wave 3) — control TRE-04 (IFRS 9 / TFRS 9 · ASC 815). A HEDGE RELATIONSHIP
// is DESIGNATED under maker-checker (create → PendingApproval carrying the hedged item, the hedging instrument
// (derivative), the hedge TYPE (CASH_FLOW | FAIR_VALUE), the hedge ratio and the formal documentation; a
// DIFFERENT user approves → Approved; self-approve → SOD_SELF_APPROVAL, mirroring TRE-03 / FX-04). NO hedge/OCI
// accounting happens until the relationship is Approved (designation) AND its LATEST effectiveness test is
// effective=true — this two-part gate IS the control:
//   • CASH_FLOW hedge — the EFFECTIVE portion of the derivative fair-value change is deferred in the Cash-Flow
//     Hedge Reserve 3550 (OCI equity — mirrors the reusable OCI-reserve primitive Wave 2 built at 3500), and
//     the INEFFECTIVE portion goes straight to P&L 5450. When the relationship is not Approved+effective the OCI
//     path is refused (HEDGE_NOT_EFFECTIVE) and the whole remeasurement is routed to P&L. When the hedged cash
//     flow occurs the deferred OCI is RECLASSIFIED to P&L (Dr 3550 / Cr the hedged-item revenue/P&L line).
//   • FAIR_VALUE hedge — the derivative fair-value change hits P&L 5450 and the hedged item is BASIS-ADJUSTED
//     (its carrying account) with an offsetting P&L leg; the net P&L is the ineffectiveness.
// The derivative fair-value change posts Dr 1380 Derivative Asset (gain) / Cr 2460 Derivative Liability (loss).
// Every posting routes through LedgerService.postEntry (GL-05 balanced + period lock). ALL tenant-scoped with a
// leading (tenant_id, …) index + the canonical 0232-form RLS policy (migration DO-loop).

export const hedgeRelationships = pgTable(
  'hedge_relationships',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    hedgeNo: text('hedge_no').notNull().unique(),                    // HEDG-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    hedgedItem: text('hedged_item').notNull(),                       // e.g. 'Forecast USD sale 2026-Q4' | 'Fixed-rate bond 2550'
    hedgingInstrument: text('hedging_instrument').notNull(),         // the derivative, e.g. 'USD/THB forward 2026-12'
    hedgeType: text('hedge_type').notNull().default('CASH_FLOW'),    // CASH_FLOW | FAIR_VALUE
    hedgeRatio: numeric('hedge_ratio', { precision: 9, scale: 4 }).notNull().default('1'), // hedged:hedging (e.g. 1:1)
    notional: numeric('notional', { precision: 18, scale: 2 }).notNull().default('0'),     // hedging-instrument notional
    documentation: text('documentation').notNull(),                 // formal designation documentation (IFRS 9 6.4.1) — required
    hedgedItemAccount: text('hedged_item_account'),                  // GL account basis-adjusted (FAIR_VALUE hedge)
    reclassAccount: text('reclass_account'),                         // P&L/revenue line the deferred OCI reclassifies to (CASH_FLOW)
    currency: text('currency').notNull().default('THB'),
    derivativeFv: numeric('derivative_fv', { precision: 18, scale: 2 }).notNull().default('0'), // running derivative fair value
    ociReserve: numeric('oci_reserve', { precision: 18, scale: 2 }).notNull().default('0'),     // running Cash-Flow Hedge Reserve (3550) balance
    basisAdjustment: numeric('basis_adjustment', { precision: 18, scale: 2 }).notNull().default('0'), // cumulative hedged-item basis adjustment (FV hedge)
    rebalances: integer('rebalances').notNull().default(0),
    status: text('status').notNull().default('PendingApproval'),    // PendingApproval | Approved | Rejected | Discontinued
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_hedge_relationships_tenant').on(t.tenantId, t.hedgeType, t.status) }),
);

// The hedging instrument's derivative state — one row per relationship, its notional + current fair value
// (updated on each remeasurement). Split out so the derivative can carry its own attributes independently.
export const hedgeDerivatives = pgTable(
  'hedge_derivatives',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    relationshipId: bigint('relationship_id', { mode: 'number' }).references(() => hedgeRelationships.id),
    instrument: text('instrument'),                                 // derivative label (mirror of hedging_instrument)
    notional: numeric('notional', { precision: 18, scale: 2 }).notNull().default('0'),
    fairValue: numeric('fair_value', { precision: 18, scale: 2 }).notNull().default('0'), // current derivative fair value
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_hedge_derivatives_tenant').on(t.tenantId, t.relationshipId) }),
);

// Effectiveness tests (prospective/retrospective) — the LATEST effective=true test unlocks hedge accounting.
export const hedgeEffectivenessTests = pgTable(
  'hedge_effectiveness_tests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    relationshipId: bigint('relationship_id', { mode: 'number' }).references(() => hedgeRelationships.id),
    testType: text('test_type').notNull().default('prospective'),  // prospective | retrospective
    method: text('method').notNull().default('dollar_offset'),     // dollar_offset | regression | critical_terms
    ratioPct: numeric('ratio_pct', { precision: 9, scale: 4 }).notNull().default('0'), // offset ratio % (IFRS 9 range 80–125 historically)
    effective: boolean('effective').notNull().default(false),
    asOf: date('as_of'),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_hedge_effectiveness_tests_tenant').on(t.tenantId, t.relationshipId, t.asOf) }),
);

// OCI movement ledger — one row per remeasurement (effective portion deferred to 3550) or reclassification
// (deferred OCI recycled to P&L). `reclassified` marks the recycling rows.
export const hedgeOciMovements = pgTable(
  'hedge_oci_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    relationshipId: bigint('relationship_id', { mode: 'number' }).references(() => hedgeRelationships.id),
    asOf: date('as_of'),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull().default('0'),        // effective portion → OCI reserve 3550 (signed); negative on reclassification
    plAmount: numeric('pl_amount', { precision: 18, scale: 2 }).notNull().default('0'),   // ineffective portion (or full delta when not hedge-eligible) → P&L 5450 (signed)
    reclassified: boolean('reclassified').notNull().default(false),
    entryNo: text('entry_no'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_hedge_oci_movements_tenant').on(t.tenantId, t.relationshipId, t.asOf) }),
);

export type HedgeRelationship = typeof hedgeRelationships.$inferSelect;
export type HedgeDerivative = typeof hedgeDerivatives.$inferSelect;
export type HedgeEffectivenessTest = typeof hedgeEffectivenessTests.$inferSelect;
export type HedgeOciMovement = typeof hedgeOciMovements.$inferSelect;
