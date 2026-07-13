import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — finance / AR / AP / bank / petty-cash / FX / SBT slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const FINANCE_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'ADVANCE.ISSUE':    { name: 'Employee advance issued',       description: 'Cash advance to an employee (EXP-07)', wired: false, roles: {
    advance_asset: r(DR, '1180', 'pinned', 'Employee-advances control'), cash: r(CR, '1000', 'pinned', 'Cash (CASH set)') } },
  'ADVANCE.SETTLE':   { name: 'Employee advance settled',      description: 'Expense + returned cash clear the advance', wired: true, roles: {
    expense: r(DR, '5100', 'free', 'Settlement expense (already dto-overridable; registry default)'), advance_asset: r(CR, '1180', 'pinned', 'Employee-advances control') } },
  'BADDEBT.WRITEOFF': { name: 'Bad-debt write-off',            description: 'Uncollectible AR written off (REV-14)', wired: true, roles: {
    bad_debt_exp: r(DR, '5720', 'free', 'Bad-debt expense'), ar_control: r(CR, '1100', 'pinned', 'AR control (REC-04 permanent)') } },
  'APPAY.WHT':        { name: 'AP payment — vendor WHT',       description: 'ภ.ง.ด.3/53 withholding at AP payment (shared by AP pay + subcontract valuations)', wired: true, roles: {
    wht_payable: r(CR, '2361', 'free', 'Vendor WHT payable — the PND3/53 tie-out reads the widened set (PR-7)') } },
  'APPAY.DISCOUNT':   { name: 'AP early-payment discount',     description: 'Prompt-payment discount captured on a run (EXP-14)', wired: true, roles: {
    discount_income: r(CR, '4600', 'free', 'Early-payment discount income (per-policy account already supported)') } },
  'TAX.PROVISION':    { name: 'Current income-tax provision',   description: 'Current CIT provision (ASC 740 / IAS 12) — Dr 5960 expense / Cr 2110 payable (TAX-11, maker-checker)', wired: true, roles: {
    cit_expense: r(DR, '5960', 'free', 'Corporate income-tax expense (current)'), cit_payable: r(CR, '2110', 'free', 'CIT payable — Revenue Department') } },
  'RCVAT.SELF':       { name: 'Reverse-charge self VAT',       description: 'ภ.พ.36 self-assessed VAT on imported services', wired: true, roles: {
    input_vat: r(DR, '1300', 'widen', 'Input VAT (PP30/36 set)'), pp36_payable: r(CR, '2120', 'widen', 'PP36 VAT payable (separate return set)') } },
  'FX.UNREALIZED':    { name: 'FX revaluation (unrealized)',   description: 'Month-end open-item revaluation (control deltas pinned)', wired: true, roles: {
    fx_gain_loss: r(DR, '5400', 'free', 'Unrealized FX gain/loss') } },
  'FX.REALIZED':      { name: 'FX settlement (realized)',      description: 'Realized FX difference at settlement', wired: true, roles: {
    fx_gain_loss: r(DR, '5410', 'free', 'Realized FX gain/loss') } },
  'BANK.INTEREST':    { name: 'Bank interest income',          description: 'Bank-rec adjustment: interest earned', wired: true, roles: {
    interest_income: r(CR, '4000', 'free', 'Interest income') } },
  'BANK.FEE':         { name: 'Bank fee expense',              description: 'Bank-rec adjustment: charges', wired: true, roles: {
    fee_expense: r(DR, '5100', 'free', 'Bank fees') } },
  'PETTY.TOPUP':      { name: 'Petty-cash replenishment',      description: 'Imprest float top-up (fund GL per-fund)', wired: false, roles: {
    cash: r(CR, '1000', 'pinned', 'Cash (CASH set)') } },
  'PETTY.EXPENSE':    { name: 'Petty-cash expense',            description: 'Expense paid from the float', wired: true, roles: {
    expense: r(DR, '5100', 'free', 'Petty-cash expense (already caller-set; registry default)') } },
  'SBT.TAX':          { name: 'Specific business tax',         description: 'ภ.ธ.40 SBT accrued at RE ownership transfer (TAX-09)', wired: false, roles: {
    sbt_expense: r(DR, '5840', 'free', 'SBT expense'), sbt_payable: r(CR, '2130', 'free', 'SBT payable — the ภ.ธ.40 tie-out reads the widened set (PR-7)') } },
};
