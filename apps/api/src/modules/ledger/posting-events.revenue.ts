import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — revenue recognition / deferred / financing component / membership / loyalty / prepaid slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const REVENUE_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'REVENUE.DEFER':    { name: 'Revenue deferred',              description: 'Cash received into deferred revenue', wired: false, roles: {
    deferred_revenue: r(CR, '2400', 'pinned', 'Unearned revenue (REC-04 permanent — §8 Q3)') } },
  'REVENUE.RECOGNIZE': { name: 'Revenue recognized',           description: 'Deferred → earned per schedule (per-schedule accounts already supported)', wired: false, roles: {
    revenue: r(CR, '4300', 'free', 'Recognized revenue') } },
  // ── TFRS 15 significant financing component (§60-65, REV-27) ──
  'REVFIN.INCOME':    { name: 'Financing component — interest income', description: 'Deferred payment (arrears): the entity finances the customer; interest income accretes the contract asset (Dr 1265 / Cr 4650) — REV-27 / TFRS 15 §60-65', wired: true, roles: {
    contract_asset: r(DR, '1265', 'pinned', 'Contract asset / unbilled receivable (REV-24 tie)'), interest_income: r(CR, '4650', 'free', 'Significant financing component interest income') } },
  'REVFIN.EXPENSE':   { name: 'Financing component — interest charge', description: 'Customer PREPAYS (advance): the significant-financing charge accretes the contract liability as interest expense (Dr 5900 / Cr 2410) — REV-27 / TFRS 15 §60-65', wired: true, roles: {
    interest_expense: r(DR, '5900', 'free', 'Interest expense — financing charge on the customer prepayment'), contract_liability: r(CR, '2410', 'pinned', 'Contract liability / deferred revenue (REV-19/24 tie)') } },
  'MEMBERSHIP.DEFER': { name: 'Membership sold (deferred)',    description: 'VIP membership fee into contract liability', wired: true, roles: {
    deferred: r(CR, '2410', 'free', 'Contract liability / deferred revenue') } },
  'MEMBERSHIP.RECOGNIZE': { name: 'Membership recognized',     description: 'Membership revenue earned over the term', wired: true, roles: {
    deferred: r(DR, '2410', 'free', 'Contract liability'), revenue: r(CR, '4300', 'free', 'Subscription & service revenue') } },
  'LOYALTY.ACCRUE':   { name: 'Loyalty points accrual',        description: 'Points liability provision (TFRS 15)', wired: true, roles: {
    loyalty_expense: r(DR, '5700', 'free', 'Loyalty points expense'), loyalty_liability: r(CR, '2250', 'pinned', 'Points-liability control (watermark tie)') } },
  'SERVICE.ACCRUAL':  { name: 'Subscription billing',          description: 'Recurring service invoice raised', wired: false, roles: {
    service_rev: r(CR, '4300', 'free', 'Subscription & service revenue'), ar_control: r(DR, '1100', 'pinned', 'AR control (REC-04 permanent)') } },
  'PREPAID.CAPITALIZE': { name: 'Prepaid capitalised',         description: 'Up-front payment into the prepaid asset', wired: true, roles: {
    prepaid: r(DR, '1280', 'free', 'Prepaid expenses (per-schedule account already supported)'), cash: r(CR, '1000', 'pinned', 'Cash (CASH set)') } },
  'PREPAID.AMORTIZE': { name: 'Prepaid amortised',             description: 'Monthly amortisation of the prepaid', wired: true, roles: {
    expense: r(DR, '5100', 'free', 'Amortisation expense (per-schedule account already supported)'), prepaid: r(CR, '1280', 'free', 'Prepaid expenses') } },
};
