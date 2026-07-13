import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — leases (lessee + lessor) slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const LEASES_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'LEASE.COMMENCE':   { name: 'Lease commencement',            description: 'ROU + liability at PV (LSE-01 schedule ties both)', wired: false, roles: {
    rou_asset: r(DR, '1600', 'pinned', 'ROU control'), lease_liability: r(CR, '2600', 'pinned', 'Lease-liability control (LSE-01)') } },
  'LEASE.INTEREST':   { name: 'Lease interest unwinding',      description: 'Periodic interest on the liability', wired: true, roles: {
    interest_exp: r(DR, '5900', 'free', 'Interest expense') } },
  'LEASE.PRINCIPAL':  { name: 'Lease principal payment',       description: 'Cash payment reducing the liability', wired: true, roles: {
    lease_liab: r(DR, '2600', 'pinned', 'Lease-liability control (LSE-01)'), cash: r(CR, '1000', 'pinned', 'Cash (CASH set)') } },
  'DEPRECIATION.ROU': { name: 'ROU depreciation',              description: 'Right-of-use asset depreciation', wired: true, roles: {
    dep_expense: r(DR, '5210', 'free', 'ROU depreciation expense'), accum_dep_rou: r(CR, '1690', 'pinned', 'Accum ROU dep control') } },
  'LEASE.MODIFY':     { name: 'Lease remeasurement',           description: 'Modification/termination remeasurement', wired: true, roles: {
    remeasure_gain: r(CR, '1510', 'free', 'Remeasurement gain (ROU floored at zero)') } },
  'LEASE.LESSOR_COMMENCE': { name: 'Lessor finance-lease commencement', description: 'Derecognise asset → net investment (LSE-02)', wired: true, roles: {
    selling_pl: r(CR, '1510', 'free', 'Selling profit/loss'), net_investment: r(DR, '1610', 'pinned', 'Net-investment control (LSE-02)') } },
  'LEASE.LESSOR_FINANCE': { name: 'Lessor finance-lease receipt', description: 'Collection: interest income + principal', wired: true, roles: {
    interest_income: r(CR, '4600', 'free', 'Finance-lease interest income'), net_investment: r(CR, '1610', 'pinned', 'Net-investment control (LSE-02)') } },
  'LEASE.LESSOR_OPERATING': { name: 'Lessor operating-lease receipt', description: 'Straight-line rental + continued depreciation', wired: true, roles: {
    rental_income: r(CR, '4610', 'free', 'Operating-lease rental income'), dep_expense: r(DR, '5200', 'free', 'Depreciation expense') } },
};
