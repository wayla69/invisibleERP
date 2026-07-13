import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — procurement / inventory / costing / manufacturing slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const SCM_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'GR.INVENTORY':     { name: 'Goods receipt — inventory',     description: 'Dr inventory at receipt (item-determination resolves the inventory leg)', wired: false, roles: {
    inventory: r(DR, '1200', 'pinned', 'Inventory control (REC-04 permanent; item-grain override lives in GL-21 determination)') } },
  'GR.AP':            { name: 'Goods receipt — AP',            description: 'AP control leg of a receipt', wired: false, roles: {
    ap_control: r(CR, '2000', 'pinned', 'AP control (REC-04 permanent)') } },
  'COSTING.RECEIPT':  { name: 'Costed receipt',                description: 'Valued receipt at standard/moving cost', wired: false, roles: {
    inventory: r(DR, '1200', 'pinned', 'Inventory control'), ap_control: r(CR, '2000', 'pinned', 'AP control') } },
  'COSTING.ISSUE':    { name: 'Costed issue / COGS',           description: 'Issue at cost (POS COGS, stock issues; composes under item-determination)', wired: true, roles: {
    cogs: r(DR, '5000', 'free', 'COGS'), inventory: r(CR, '1200', 'pinned', 'Inventory control') } },
  'COSTING.PPV':      { name: 'Purchase price variance',       description: 'STD-costing PPV (sign-conditional)', wired: true, roles: {
    ppv: r(DR, '5500', 'free', 'Purchase price variance') } },
  'LANDEDCOST.CAPITALIZE': { name: 'Landed-cost capitalisation', description: 'Freight/duty/insurance/broker apportioned into inventory unit cost; issued-share residual to costing variance (COST-01)', wired: true, roles: {
    inventory: r(DR, '1200', 'pinned', 'Inventory control — on-hand capitalised share'), variance: r(DR, '5500', 'free', 'Costing variance — already-issued residual (mirrors PPV)'), accrual: r(CR, '2010', 'free', 'Landed-cost accrual liability (freight/duty/insurance/broker payable)') } },
  'INV.ADJUST':       { name: 'Inventory adjustment',          description: 'Count/valuation adjustment (direction-conditional)', wired: true, roles: {
    adjustment: r(DR, '5810', 'free', 'Adjustment expense (composes under warehouse determination)') } },
  'WASTE.WRITEOFF':   { name: 'Waste write-off',               description: 'Spoilage/waste written off stock', wired: true, roles: {
    waste_loss: r(DR, '5810', 'free', 'Waste loss'), inventory: r(CR, '1200', 'pinned', 'Inventory control') } },
  'MFG.WO_ISSUE':     { name: 'Work order — issue',            description: 'Materials + applied labour/OH into WIP', wired: true, roles: {
    wip: r(DR, '1250', 'pinned', 'WIP control'), labor_oh_applied: r(CR, '2380', 'free', 'Manufacturing costs applied (clearing)'), inventory: r(CR, '1200', 'pinned', 'Inventory control') } },
  'MFG.WO_COMPLETE':  { name: 'Work order — complete',         description: 'Finished goods in; yield variance out', wired: true, roles: {
    finished_goods: r(DR, '1210', 'pinned', 'FG control'), yield_variance: r(DR, '5810', 'free', 'Yield/material variance'), wip: r(CR, '1250', 'pinned', 'WIP control') } },
  'QA.SCRAP':         { name: 'QC scrap disposition',          description: 'Scrap loss written off (source credit resolved by ref type)', wired: true, roles: {
    scrap_loss: r(DR, '5810', 'free', 'Scrap / rework loss') } },
};
