import { pgTable, bigserial, bigint, text, numeric, date, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Investment & Securities register (Track C Wave 2) — control TRE-03 (classification + valuation maker-checker;
// MTM only from Approved prices). A security is BOUGHT under maker-checker (create → PendingApproval; a DIFFERENT
// user approves → the buy posts Dr 1350|1360|1370 per classification / Cr 1010 Bank; self-approve →
// SOD_SELF_APPROVAL). Classification is one of:
//   • AMORTIZED_COST — held-to-collect debt (1350); interest income accretes on the effective-interest (EIR)
//     amortized-cost carrying (Dr 1350 / Cr 4700 Investment Income), reusing the Wave-1 EIR periodic-cursor.
//   • FVOCI          — fair-value-through-OCI (1360); mark-to-market moves through the OCI equity RESERVE 3500
//     (the reusable OCI-reserve primitive Wave-3 hedge accounting builds on), NOT P&L.
//   • FVTPL          — fair-value-through-P&L (1370); mark-to-market moves through P&L 5430 fair-value gain/loss.
// A maker-checker PRICE register (investment_prices, mirroring fx_rates / FX-04) drives MTM — an unapproved price
// can never revalue. ECL impairment books Dr 5440 Investment Impairment / Cr 1355 Allowance (contra-asset).
// ALL tenant-scoped with a leading (tenant_id, …) index + the canonical 0232-form RLS policy (migration DO-loop).

export const investments = pgTable(
  'investments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    investmentNo: text('investment_no').notNull().unique(),        // INVS-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    instrument: text('instrument').notNull(),                      // human name, e.g. 'BBL 5Y Bond 2031'
    instrumentType: text('instrument_type').notNull().default('bond'), // 'bond' | 'equity' | 'fund'
    symbol: text('symbol'),                                        // price-register key (drives MTM)
    classification: text('classification').notNull().default('AMORTIZED_COST'), // AMORTIZED_COST | FVOCI | FVTPL
    currency: text('currency').notNull().default('THB'),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('1'), // units held (MTM = price × qty)
    cost: numeric('cost', { precision: 18, scale: 2 }).notNull().default('0'),       // acquisition cost (buy consideration)
    eirPct: numeric('eir_pct', { precision: 9, scale: 6 }).notNull().default('0'),   // effective annual interest rate % (amortized-cost accretion)
    tradeDate: date('trade_date'),
    maturityDate: date('maturity_date'),
    carryingValue: numeric('carrying_value', { precision: 18, scale: 2 }).notNull().default('0'), // running carrying amount
    allowance: numeric('allowance', { precision: 18, scale: 2 }).notNull().default('0'),          // accumulated ECL allowance (contra-asset)
    fvociReserve: numeric('fvoci_reserve', { precision: 18, scale: 2 }).notNull().default('0'),    // accumulated OCI reserve (FVOCI cumulative MTM)
    accruedIncome: numeric('accrued_income', { precision: 18, scale: 2 }).notNull().default('0'),  // cumulative interest/dividend income recognised
    periodsPosted: integer('periods_posted').notNull().default(0),
    nextRunDate: date('next_run_date'),                           // EIR accrual cursor (amortized-cost only)
    status: text('status').notNull().default('PendingApproval'),  // PendingApproval | Approved | Rejected | Disposed
    entryNo: text('entry_no'),                                    // buy JE entry_no
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_investments_tenant').on(t.tenantId, t.classification, t.status) }),
);

// Maker-checker market-price register — a price must be Approved before it can drive MTM (mirrors FX-04). A
// MANUAL price lands PendingApproval; an explicit non-manual source (a feed) is auto-approved. Re-setting a
// price for the same (tenant, symbol, price_date) replaces it (delete-then-insert).
export const investmentPrices = pgTable(
  'investment_prices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    symbol: text('symbol').notNull(),
    priceDate: date('price_date').notNull(),
    price: numeric('price', { precision: 18, scale: 6 }).notNull().default('0'),
    source: text('source').notNull().default('manual'),          // 'manual' (→ PendingApproval) | feed name (→ Approved)
    status: text('status').notNull().default('PendingApproval'),  // PendingApproval | Approved | Rejected
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_investment_prices_tenant').on(t.tenantId, t.symbol, t.priceDate) }),
);

// MTM / ECL valuation ledger — one row per revaluation (fair-value MTM) or impairment (ECL) event, recording the
// prior/new carrying, the delta and how it split between OCI (FVOCI) / P&L (FVTPL) / allowance (ECL).
export const investmentValuations = pgTable(
  'investment_valuations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    investmentId: bigint('investment_id', { mode: 'number' }).references(() => investments.id),
    asOf: date('as_of'),
    valType: text('val_type').notNull().default('MTM'),          // MTM | ECL
    price: numeric('price', { precision: 18, scale: 6 }),        // the approved price used for MTM
    priorCarrying: numeric('prior_carrying', { precision: 18, scale: 2 }).notNull().default('0'),
    newCarrying: numeric('new_carrying', { precision: 18, scale: 2 }).notNull().default('0'),
    delta: numeric('delta', { precision: 18, scale: 2 }).notNull().default('0'),          // new − prior carrying
    ociDelta: numeric('oci_delta', { precision: 18, scale: 2 }).notNull().default('0'),   // portion parked in OCI reserve 3500 (FVOCI)
    plDelta: numeric('pl_delta', { precision: 18, scale: 2 }).notNull().default('0'),     // portion through P&L 5430 (FVTPL)
    allowanceDelta: numeric('allowance_delta', { precision: 18, scale: 2 }).notNull().default('0'), // ECL allowance movement (1355)
    entryNo: text('entry_no'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_investment_valuations_tenant').on(t.tenantId, t.investmentId, t.asOf) }),
);

export type Investment = typeof investments.$inferSelect;
export type InvestmentPrice = typeof investmentPrices.$inferSelect;
export type InvestmentValuation = typeof investmentValuations.$inferSelect;
