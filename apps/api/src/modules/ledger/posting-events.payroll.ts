import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — payroll / HR slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const PAYROLL_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'PAYROLL.GROSS':    { name: 'Payroll — gross wages',         description: 'Salaries + OT − unpaid (net-pay cash leg is pinned)', wired: true, roles: {
    wages_expense: r(DR, '5600', 'free', 'Salaries & wages'), net_pay_cash: r(CR, '1000', 'pinned', 'Net pay (CASH set)') } },
  'PAYROLL.SSO':      { name: 'Payroll — social security',     description: 'Employer SSO expense + combined payable', wired: true, roles: {
    sso_expense: r(DR, '5610', 'free', 'Employer SSO expense'), sso_payable: r(CR, '2350', 'free', 'SSO payable — the PAY-02 schedule reads the widened set (PR-7)') } },
  'PAYROLL.WHT':      { name: 'Payroll — income WHT',          description: 'ภ.ง.ด.1 payroll withholding payable', wired: true, roles: {
    wht_payable: r(CR, '2360', 'free', 'Payroll WHT payable — the PAY-02 schedule reads the widened set (PR-7)') } },
  'PAYROLL.PF':       { name: 'Payroll — provident fund',      description: 'Employer PF expense + combined payable', wired: true, roles: {
    pf_expense: r(DR, '5620', 'free', 'Employer PF expense'), pf_payable: r(CR, '2370', 'free', 'PF payable — the PAY-02 schedule reads the widened set (PR-7)') } },
  'PAYROLL.REMIT':    { name: 'Payroll liability remittance',  description: 'Statutory liability remitted to RD/SSO', wired: false, roles: {
    liability: r(DR, '2350', 'widen', 'Remitted liability — the remit endpoint accepts any account in the PAY-02 widened sets (PR-7); this role itself stays catalog-only'), cash: r(CR, '1000', 'pinned', 'Cash (CASH set)') } },
};
