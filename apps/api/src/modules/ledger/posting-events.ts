// ───────────────────────── Posting-event REGISTRY (docs/43 PR-1 — the single source of truth) ─────────────────────────
// Catalogue of every business event that posts to the GL, each leg's semantic ROLE, its REAL default
// account (the literal the posting site ships with — NOT the aspirational 0158 demo rows, some of which
// drift from the code), and the role's override TIER:
//
//   • 'free'   — a tenant posting-rule override applies (override ?? default), docs/43 Tier A.
//   • 'widen'  — overridable ONLY once the reconciliation that reads this account sums a widened account
//                SET (docs/43 Tier B; flipped per-role by PR-7). Until then upsert is rejected like pinned.
//   • 'pinned' — never overridable (sub-ledger control accounts, equity plugs, the cash set — docs/43
//                Tier C, incl. the five REC-04 accounts pinned PERMANENTLY per the §8 owner decision).
//
// INVARIANTS (boot-asserted from seedChartOfAccounts via assertPostingEventDefaults):
//   1. every role default exists in the canonical COA;
//   2. tiers are valid; no event declares zero roles.
// The posting_event_types seed migration is derived from this registry (0331); consuming services import
// their fallback literal from here so code and catalogue can never drift. Maintained ON /setup/posting-rules;
// governance (validation + maker-checker + audit) = control GL-24 in posting.service.ts.

export type PostingSide = 'DR' | 'CR';
export type RoleTier = 'free' | 'widen' | 'pinned';

export interface PostingRoleDef {
  side: PostingSide;
  /** The real literal the posting site falls back to (kept in lock-step by importing THIS constant). */
  default: string;
  tier: RoleTier;
  description: string;
}

export interface PostingEventDef {
  name: string;
  description: string;
  /** Delivered = a real posting path consumes overrides for this event today; catalog = visibility/roadmap. */
  wired: boolean;
  roles: Record<string, PostingRoleDef>;
}

const DR = 'DR' as const, CR = 'CR' as const;
const r = (side: PostingSide, def: string, tier: RoleTier, description: string): PostingRoleDef => ({ side, default: def, tier, description });

// prettier-ignore
export const POSTING_EVENTS: Record<string, PostingEventDef> = {
  // ── Sales / POS / restaurant ──
  'SALE.FOOD':        { name: 'Sale — revenue',                description: 'POS/AR sale revenue leg (composes UNDER item-determination when the flag is on)', wired: true, roles: {
    revenue: r(CR, '4000', 'free', 'Sales revenue'), cash: r(DR, '1000', 'pinned', 'Cash (CASH set)'), ar_control: r(DR, '1100', 'pinned', 'AR control (REC-04 permanent)') } },
  'SALE.VAT':         { name: 'Sale — output VAT',             description: 'Output-VAT leg of a sale/CN/DN', wired: true, roles: {
    vat_output: r(CR, '2100', 'widen', 'Output VAT — PP30 tie sums the VAT-account set') } },
  'SALE.DELIVERY':    { name: 'Sale — delivery income',        description: 'Delivery-fee income on channel orders', wired: false, roles: {
    delivery_income: r(CR, '4100', 'free', 'Delivery income') } },
  'SVC.CHARGE':       { name: 'Sale — service charge',         description: 'Auto service-charge income (large parties)', wired: false, roles: {
    service_charge_income: r(CR, '4400', 'free', 'Service-charge income') } },
  'POS.ROUNDING':     { name: 'Sale — satang rounding',        description: 'Cash rounding adjustment (sign-conditional legs)', wired: false, roles: {
    rounding: r(CR, '4900', 'free', 'Rounding adjustment (gain=credit, loss=debit)') } },
  'SURCHARGE.INCOME': { name: 'Card surcharge income',         description: 'Card surcharge collected at settlement', wired: true, roles: {
    surcharge_income: r(CR, '4500', 'free', 'Card surcharge income') } },
  'TIP.COLLECT':      { name: 'Tip collected',                 description: 'Tip pass-through collected with a payment', wired: false, roles: {
    tips_payable: r(CR, '2300', 'pinned', 'Tips payable — TIP-01 reconciles GL 2300 outstanding') } },
  'TIP.PAYOUT':       { name: 'Tip paid out',                  description: 'Tip pool distribution to staff', wired: false, roles: {
    tips_payable: r(DR, '2300', 'pinned', 'Tips payable — TIP-01'), payout: r(CR, '1000', 'pinned', 'Cash/pay account (per-distribution account already supported)') } },
  'TILL.VARIANCE':    { name: 'Till close over/short',         description: 'Z-close cash variance (payments + hub replay share this key)', wired: true, roles: {
    cash_over_short: r(DR, '5830', 'free', 'Cash over/short (short=debit, over=credit)') } },
  'TILL.CASHMOV':     { name: 'Till paid-in/out',              description: 'Drawer paid-in / paid-out movement', wired: true, roles: {
    expense: r(DR, '5100', 'free', 'Paid-out expense') } },
  'DEPOSIT.TAKE':     { name: 'Customer deposit taken',        description: 'Booking/tab prepayment received', wired: true, roles: {
    deposit_liability: r(CR, '2210', 'free', 'Customer deposits — prepaid') } },
  'DEPOSIT.APPLY':    { name: 'Customer deposit applied',      description: 'Deposit recognised into a sale', wired: true, roles: {
    deposit_liability: r(DR, '2210', 'free', 'Customer deposits — prepaid'), revenue: r(CR, '4000', 'free', 'Revenue on application') } },
  'DEPOSIT.REFUND':   { name: 'Customer deposit refunded',     description: 'Deposit returned to the customer', wired: true, roles: {
    deposit_liability: r(DR, '2210', 'free', 'Customer deposits — prepaid') } },
  'GIFTCARD.ISSUE':   { name: 'Gift card issued',              description: 'Gift card / store credit sold', wired: false, roles: {
    giftcard_liability: r(CR, '2200', 'pinned', 'Gift-card liability (REC-04 permanent)') } },
  'GIFTCARD.REDEEM':  { name: 'Gift card redeemed',            description: 'Gift-card value applied to a sale', wired: false, roles: {
    giftcard_liability: r(DR, '2200', 'pinned', 'Gift-card liability (REC-04 permanent)') } },
  'RETURN.AR':        { name: 'Customer return — refund',      description: 'Revenue/VAT reversal on a return', wired: true, roles: {
    revenue_reversal: r(DR, '4000', 'free', 'Revenue reversal'), vat_reversal: r(DR, '2100', 'widen', 'Output-VAT reversal (PP30 set)') } },
  'RETURN.STOCK':     { name: 'Customer return — stock',       description: 'COGS reversal when stock returns', wired: true, roles: {
    cogs_reversal: r(CR, '5300', 'free', 'COGS reversal'), inventory: r(DR, '1200', 'pinned', 'Inventory control (REC-04 permanent)') } },

  // ── Procurement / inventory / costing / manufacturing ──
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

  // ── Payroll / HR ──
  'PAYROLL.GROSS':    { name: 'Payroll — gross wages',         description: 'Salaries + OT − unpaid (net-pay cash leg is pinned)', wired: true, roles: {
    wages_expense: r(DR, '5600', 'free', 'Salaries & wages'), net_pay_cash: r(CR, '1000', 'pinned', 'Net pay (CASH set)') } },
  'PAYROLL.SSO':      { name: 'Payroll — social security',     description: 'Employer SSO expense + combined payable', wired: true, roles: {
    sso_expense: r(DR, '5610', 'free', 'Employer SSO expense'), sso_payable: r(CR, '2350', 'widen', 'SSO payable — PAY-02 schedule widens in PR-7') } },
  'PAYROLL.WHT':      { name: 'Payroll — income WHT',          description: 'ภ.ง.ด.1 payroll withholding payable', wired: true, roles: {
    wht_payable: r(CR, '2360', 'widen', 'Payroll WHT payable — PAY-02 schedule widens in PR-7') } },
  'PAYROLL.PF':       { name: 'Payroll — provident fund',      description: 'Employer PF expense + combined payable', wired: true, roles: {
    pf_expense: r(DR, '5620', 'free', 'Employer PF expense'), pf_payable: r(CR, '2370', 'widen', 'PF payable — PAY-02 schedule widens in PR-7') } },
  'PAYROLL.REMIT':    { name: 'Payroll liability remittance',  description: 'Statutory liability remitted to RD/SSO', wired: false, roles: {
    liability: r(DR, '2350', 'widen', 'Remitted liability (2350/2360/2370 — PAY-02 set)'), cash: r(CR, '1000', 'pinned', 'Cash (CASH set)') } },

  // ── Fixed assets / CIP ──
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

  // ── Leases (lessee + lessor) ──
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

  // ── Finance / treasury / AR / AP ──
  'ADVANCE.ISSUE':    { name: 'Employee advance issued',       description: 'Cash advance to an employee (EXP-07)', wired: false, roles: {
    advance_asset: r(DR, '1180', 'pinned', 'Employee-advances control'), cash: r(CR, '1000', 'pinned', 'Cash (CASH set)') } },
  'ADVANCE.SETTLE':   { name: 'Employee advance settled',      description: 'Expense + returned cash clear the advance', wired: true, roles: {
    expense: r(DR, '5100', 'free', 'Settlement expense (already dto-overridable; registry default)'), advance_asset: r(CR, '1180', 'pinned', 'Employee-advances control') } },
  'BADDEBT.WRITEOFF': { name: 'Bad-debt write-off',            description: 'Uncollectible AR written off (REV-14)', wired: true, roles: {
    bad_debt_exp: r(DR, '5720', 'free', 'Bad-debt expense'), ar_control: r(CR, '1100', 'pinned', 'AR control (REC-04 permanent)') } },
  'APPAY.WHT':        { name: 'AP payment — vendor WHT',       description: 'ภ.ง.ด.3/53 withholding at AP payment (shared by AP pay + subcontract valuations)', wired: true, roles: {
    wht_payable: r(CR, '2361', 'widen', 'Vendor WHT payable — PND3/53 report set widens in PR-7') } },
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
  'REVENUE.DEFER':    { name: 'Revenue deferred',              description: 'Cash received into deferred revenue', wired: false, roles: {
    deferred_revenue: r(CR, '2400', 'pinned', 'Unearned revenue (REC-04 permanent — §8 Q3)') } },
  'REVENUE.RECOGNIZE': { name: 'Revenue recognized',           description: 'Deferred → earned per schedule (per-schedule accounts already supported)', wired: false, roles: {
    revenue: r(CR, '4300', 'free', 'Recognized revenue') } },
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
  'SBT.TAX':          { name: 'Specific business tax',         description: 'ภ.ธ.40 SBT accrued at RE ownership transfer (TAX-09)', wired: false, roles: {
    sbt_expense: r(DR, '5840', 'free', 'SBT expense'), sbt_payable: r(CR, '2130', 'widen', 'SBT payable — ภ.ธ.40 report set widens in PR-7') } },

  // ── Intercompany / projects / construction / real estate ──
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

// ── Introspection helpers ──
export const POSTING_EVENT_KEYS = Object.keys(POSTING_EVENTS);

export function postingRole(eventType: string, role: string): PostingRoleDef | undefined {
  return POSTING_EVENTS[eventType]?.roles[role];
}

/** Boot fail-fast (called from seedChartOfAccounts, like assertTemplatesSubsetOf): every registry
 *  default must exist in the canonical COA and every event must declare at least one role. */
export function assertPostingEventDefaults(canonicalCodes: Iterable<string>): void {
  const canon = new Set(canonicalCodes);
  for (const [key, ev] of Object.entries(POSTING_EVENTS)) {
    const roles = Object.entries(ev.roles);
    if (!roles.length) throw new Error(`posting-events registry: event ${key} declares no roles`);
    for (const [role, def] of roles) {
      if (!canon.has(def.default)) {
        throw new Error(`posting-events registry: ${key}.${role} default account ${def.default} is not in the canonical COA`);
      }
    }
  }
}

/** The registry default for an event role — posting sites use `override ?? postingDefault(...)` so the
 *  literal can never drift from the catalogue (docs/43 PR-2+). Throws at module-eval time via the boot
 *  assert rather than here; an unknown pair is a programming error surfaced by tests. */
export function postingDefault(eventType: string, role: string): string {
  const def = POSTING_EVENTS[eventType]?.roles[role];
  if (!def) throw new Error(`posting-events registry: unknown ${eventType}.${role}`);
  return def.default;
}
