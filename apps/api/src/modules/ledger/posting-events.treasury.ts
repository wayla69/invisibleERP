import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — treasury (borrowings TRE-01, investments TRE-03, hedge accounting TRE-04, cash pooling / IC loans TRE-05) slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const TREASURY_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'DEBT.DRAWDOWN':    { name: 'Borrowing drawdown',            description: 'Facility drawdown — cash in, borrowings up (TRE-01; short-/long-term control pinned)', wired: true, roles: {
    bank: r(DR, '1010', 'pinned', 'Bank (CASH set)'), borrowings: r(CR, '2500', 'pinned', 'Borrowings control (TRE-01 register tie; long-term drawdowns post 2550)') } },
  'DEBT.INTEREST':    { name: 'Borrowing EIR interest accrual', description: 'Effective-interest accrual on the amortized cost (TRE-01)', wired: true, roles: {
    interest_exp: r(DR, '5900', 'free', 'Interest expense'), accrued_interest: r(CR, '2450', 'pinned', 'Accrued interest payable (TRE-01 schedule tie)') } },
  'DEBT.REPAY':       { name: 'Borrowing repayment',           description: 'Repay principal + accrued interest against cash (TRE-01)', wired: true, roles: {
    borrowings: r(DR, '2500', 'pinned', 'Borrowings control (TRE-01; long-term posts 2550)'), accrued_interest: r(DR, '2450', 'pinned', 'Accrued interest payable (TRE-01)'), bank: r(CR, '1010', 'pinned', 'Bank (CASH set)') } },
  'INVEST.BUY':       { name: 'Investment purchase',           description: 'Buy a security — Dr the class asset (amortized cost / FVOCI / FVTPL) / Cr 1010 Bank (TRE-03; posted at maker-checker approval)', wired: true, roles: {
    investment_ac: r(DR, '1350', 'pinned', 'Investments — amortized cost (register tie)'), investment_fvoci: r(DR, '1360', 'pinned', 'Investments — FVOCI (register tie)'), investment_fvtpl: r(DR, '1370', 'pinned', 'Investments — FVTPL (register tie)'), bank: r(CR, '1010', 'pinned', 'Bank (CASH set)') } },
  'INVEST.INCOME':    { name: 'Investment income',             description: 'Interest (amortized-cost EIR accretion, Dr class asset) or cash dividend (Dr bank) / Cr 4700 Investment Income (TRE-03)', wired: true, roles: {
    income: r(CR, '4700', 'free', 'Investment income — interest/dividend'), bank: r(DR, '1010', 'pinned', 'Bank (CASH set) — cash dividend received') } },
  'INVEST.MTM.PL':    { name: 'Investment MTM — FVTPL (P&L)',  description: 'Mark-to-market a FVTPL holding through P&L using the latest APPROVED price (TRE-03)', wired: true, roles: {
    fv_gain_loss: r(DR, '5430', 'free', 'Fair-value gain/loss — FVTPL (gain=credit, loss=debit)'), investment_fvtpl: r(DR, '1370', 'pinned', 'Investments — FVTPL (register tie)') } },
  'INVEST.MTM.OCI':   { name: 'Investment MTM — FVOCI (OCI)',  description: 'Mark-to-market a FVOCI holding through the OCI equity reserve (the reusable OCI-reserve primitive) using the latest APPROVED price (TRE-03)', wired: true, roles: {
    oci_reserve: r(CR, '3500', 'pinned', 'FVOCI reserve (OCI equity) — reusable OCI-reserve primitive; Wave 3 hedge accounting reuses it'), investment_fvoci: r(DR, '1360', 'pinned', 'Investments — FVOCI (register tie)') } },
  'INVEST.IMPAIR':    { name: 'Investment ECL impairment',     description: 'Expected-credit-loss impairment — Dr 5440 / Cr 1355 allowance (contra-asset) (TRE-03)', wired: true, roles: {
    impairment_loss: r(DR, '5440', 'free', 'Investment impairment (ECL)'), allowance: r(CR, '1355', 'pinned', 'Allowance for investment ECL (contra-asset)') } },
  // ── Hedge accounting (TRE-04, IFRS 9 / ASC 815) ──
  'HEDGE.DERIVATIVE.MTM': { name: 'Hedging derivative remeasurement', description: 'Derivative fair-value change — Dr 1380 Derivative Asset (gain) / Cr 2460 Derivative Liability (loss); the offset routes to OCI 3550 (CF-hedge effective portion) or P&L 5450 (ineffective / FV-hedge) (TRE-04)', wired: true, roles: {
    derivative_asset: r(DR, '1380', 'pinned', 'Derivative asset — hedging instrument positive fair value (register tie)'), derivative_liab: r(CR, '2460', 'pinned', 'Derivative liability — hedging instrument negative fair value (register tie)'), hedge_pl: r(DR, '5450', 'free', 'Hedge ineffectiveness / FV-hedge P&L (gain=credit, loss=debit)') } },
  'HEDGE.CF.OCI':     { name: 'Cash-flow hedge — effective portion to OCI', description: 'Effective portion of a CASH_FLOW hedge deferred in the Cash-Flow Hedge Reserve 3550 (OCI equity), only once the relationship is Approved AND its latest effectiveness test is effective (TRE-04)', wired: true, roles: {
    cf_hedge_reserve: r(CR, '3550', 'pinned', 'Cash-flow hedge reserve (OCI equity) — deferred effective portion; recycled to P&L when the hedged cash flow occurs'), derivative_asset: r(DR, '1380', 'pinned', 'Derivative asset — hedging instrument (register tie)') } },
  'HEDGE.RECLASSIFY': { name: 'Cash-flow hedge — OCI reclassification', description: 'When the hedged cash flow occurs the deferred OCI is recycled to earnings — Dr 3550 Cash-Flow Hedge Reserve / Cr the hedged-item revenue/P&L line (TRE-04)', wired: true, roles: {
    cf_hedge_reserve: r(DR, '3550', 'pinned', 'Cash-flow hedge reserve (OCI equity) — recycled out on the hedged cash flow'), reclass_target: r(CR, '4000', 'free', 'Hedged-item revenue/P&L line the deferred OCI recycles into (per-relationship account already supported)') } },
  'HEDGE.FV.BASIS':   { name: 'Fair-value hedge — hedged-item basis adjustment', description: 'FAIR_VALUE hedge — the hedged risk fair-value change adjusts the hedged item\'s carrying account with an offsetting P&L leg (Dr/Cr hedged item ↔ Cr/Dr 5450) (TRE-04)', wired: true, roles: {
    hedged_item: r(DR, '1200', 'pinned', 'Hedged item carrying account (per-relationship account already supported — the item being fair-value hedged)'), hedge_pl: r(CR, '5450', 'free', 'Fair-value hedge P&L on the hedged item (gain=credit, loss=debit)') } },
  // ── Cash pooling / in-house bank / intercompany loans (TRE-05) ──
  'ICLOAN.DRAWDOWN':  { name: 'Intercompany loan drawdown',    description: 'Mirrored IC-loan drawdown — creditor Dr 1155 IC-Loan Receivable / Cr 1010 Bank; debtor Dr 1010 Bank / Cr 2155 IC-Loan Payable (the 1155/2155 pair eliminates on consolidation) (TRE-05)', wired: true, roles: {
    ic_loan_receivable: r(DR, '1155', 'pinned', 'IC-loan receivable — creditor side (elimination pair with 2155)'), ic_loan_payable: r(CR, '2155', 'pinned', 'IC-loan payable — debtor side (elimination pair with 1155)'), bank: r(DR, '1010', 'pinned', 'Bank (CASH set)') } },
  'ICLOAN.INTEREST':  { name: 'Intercompany loan EIR interest', description: 'Mirrored EIR interest accrual on the amortized cost — creditor Dr 1155 / Cr 4700 Investment/Interest Income; debtor Dr 5900 Interest Expense / Cr 2155 (the 4700/5900 IC interest eliminates on consolidation) (TRE-05)', wired: true, roles: {
    ic_loan_receivable: r(DR, '1155', 'pinned', 'IC-loan receivable — creditor accretion (elimination pair)'), interest_income: r(CR, '4700', 'free', 'Intercompany interest income — creditor (eliminates against the debtor 5900)'), interest_exp: r(DR, '5900', 'free', 'Intercompany interest expense — debtor (eliminates against the creditor 4700)'), ic_loan_payable: r(CR, '2155', 'pinned', 'IC-loan payable — debtor accretion (elimination pair)') } },
  'POOL.SWEEP':       { name: 'Cash pool physical sweep',       description: 'Physical cash-pool sweep member→header — Dr header-bank / Cr member-bank (in-house-bank concentration) (TRE-05)', wired: true, roles: {
    header_bank: r(DR, '1010', 'pinned', 'Pool header (master) bank account (CASH set)'), member_bank: r(CR, '1020', 'pinned', 'Pool member sub-account bank account (CASH set)') } },
  'POOL.INTEREST':    { name: 'Cash pool notional interest',    description: 'Notional cash-pool interest allocation across members — a zero-sum redistribution (surplus members Cr 4700 income, deficit members Dr 5900 expense; Σ = 0) (TRE-05)', wired: true, roles: {
    interest_income: r(CR, '4700', 'free', 'Member interest income (surplus member benefit)'), interest_exp: r(DR, '5900', 'free', 'Member interest expense (deficit member cost)') } },
};
