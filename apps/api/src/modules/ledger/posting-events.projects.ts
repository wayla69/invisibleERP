import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — intercompany / projects / construction / real estate slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const PROJECTS_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'IC.TRANSACTION':   { name: 'Intercompany transaction',      description: 'Due-from/due-to pair; the category MAP resolves the P&L legs (shared-cost/transfer legs overridable; loan = cash pinned, loyalty-clearing = LYL-03 tie)', wired: true, roles: {
    ic_receivable: r(DR, '1150', 'pinned', 'IC due-from (elimination pair)'), ic_payable: r(CR, '2150', 'pinned', 'IC due-to (elimination pair)'),
    recovery_shared_cost: r(CR, '5100', 'free', 'Creditor recovery — shared-cost'), expense_shared_cost: r(DR, '5100', 'free', 'Debtor expense — shared-cost'),
    recovery_transfer: r(CR, '4000', 'free', 'Creditor recovery — transfer'), expense_transfer: r(DR, '5100', 'free', 'Debtor expense — transfer') } },
  'IC.SETTLE':        { name: 'Intercompany settlement',       description: 'Cash settlement of the IC pair', wired: false, roles: {
    ic_receivable: r(CR, '1150', 'pinned', 'IC due-from'), ic_payable: r(DR, '2150', 'pinned', 'IC due-to'), cash: r(DR, '1000', 'pinned', 'Cash (CASH set)') } },
  'PROJECT.COST':     { name: 'Project cost accrual',          description: 'WIP capitalise / non-billable expense', wired: true, roles: {
    project_wip: r(DR, '1260', 'pinned', 'Project-WIP control (cost_to_date tie)'), proj_applied: r(CR, '2390', 'free', 'Project costs applied (clearing)'), project_cogs: r(DR, '5800', 'free', 'Non-billable project cost') } },
  'PROJECT.REVENUE':  { name: 'Project revenue',               description: 'Billing / POC revenue recognition', wired: true, roles: {
    project_revenue: r(CR, '4200', 'free', 'Project revenue'), project_cogs: r(DR, '5800', 'free', 'Project cost of services'), ar_control: r(DR, '1100', 'pinned', 'AR control (REC-04 permanent)') } },
  'PROJECT.BILLING':  { name: 'POC progress invoice',          description: 'Contract asset relief / billings in excess', wired: false, roles: {
    contract_asset: r(CR, '1265', 'pinned', 'Contract-asset control'), billings_in_excess: r(CR, '2410', 'widen', 'Billings in excess (progress-billing tie)') } },
  'REALESTATE.BOOK':  { name: 'RE booking deposit',            description: 'Unit booking deposit received', wired: true, roles: {
    deposit_liability: r(CR, '2210', 'free', 'Customer deposits — prepaid') } },
  'REALESTATE.CONTRACT': { name: 'RE contract down payment',   description: 'Contract signing: deposit reclass + down payment', wired: false, roles: {
    contract_liability: r(CR, '2410', 'widen', 'Contract liability (progress tie)') } },
  'REALESTATE.INSTALL': { name: 'RE installment received',     description: 'Installment into the contract liability', wired: false, roles: {
    contract_liability: r(CR, '2410', 'widen', 'Contract liability') } },
};
