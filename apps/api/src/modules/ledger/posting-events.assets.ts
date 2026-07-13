import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — fixed assets / CIP slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const ASSETS_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'ASSET.ACQUIRE':    { name: 'Asset acquisition',             description: 'Capitalise an asset — under posting_determination the CATEGORY asset_account drives the debit (docs/43 Q2 grain); roles here are catalog visibility', wired: false, roles: {
    fixed_asset_gross: r(DR, '1500', 'pinned', 'FA register control'), funding: r(CR, '2000', 'pinned', 'AP/cash funding leg') } },
  'DEPRECIATION.FA':  { name: 'Fixed-asset depreciation',      description: 'Periodic depreciation run — under posting_determination the CATEGORY dep/accum accounts win (docs/43 Q2 grain), then the tenant posting-rule', wired: true, roles: {
    dep_expense: r(DR, '5200', 'free', 'Depreciation expense'), accum_dep: r(CR, '1590', 'pinned', 'Accumulated depreciation — FA register tie') } },
  'ASSET.DISPOSE':    { name: 'Asset disposal',                description: 'Derecognition with gain/loss', wired: true, roles: {
    gain_loss: r(CR, '1510', 'free', 'Gain/loss on disposal'), fixed_asset_gross: r(CR, '1500', 'pinned', 'FA register control'), accum_dep: r(DR, '1590', 'pinned', 'Accum-dep control') } },
  'ASSET.REVALUE':    { name: 'Asset revaluation / impairment', description: 'Revaluation surplus up / impairment down', wired: true, roles: {
    impairment_loss: r(DR, '5820', 'free', 'Impairment loss'), revaluation_surplus: r(CR, '3200', 'pinned', 'Revaluation reserve (equity)') } },
  'ASSET.CIP_COST':   { name: 'CIP cost accumulation',         description: 'Construction-in-progress cost (FA-13)', wired: false, roles: {
    cip: r(DR, '1520', 'pinned', 'CIP control'), funding: r(CR, '2000', 'pinned', 'AP/cash funding leg') } },
};
