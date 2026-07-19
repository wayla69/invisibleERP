import { type PostingEventDef, r, DR, CR } from './posting-events.types';

// docs/46 Phase 5 — sales / POS / restaurant slice of the posting-event registry (docs/43 PR-1), split VERBATIM out of
// posting-events.ts and composed back into the single exported POSTING_EVENTS there. Semantics, tiers and
// the assertPostingEventDefaults boot invariants are unchanged; merge conflicts stay local to the domain.
// prettier-ignore
export const SALES_POSTING_EVENTS: Record<string, PostingEventDef> = {
  'SALE.FOOD':        { name: 'Sale — revenue',                description: 'POS/AR sale revenue leg (composes UNDER item-determination when the flag is on)', wired: true, roles: {
    revenue: r(CR, '4000', 'free', 'Sales revenue'), cash: r(DR, '1000', 'pinned', 'Cash (CASH set)'), ar_control: r(DR, '1100', 'pinned', 'AR control (REC-04 permanent)') } },
  // docs/52 Phase 1 — business-type-neutral revenue events for a UNIVERSAL POS. The generic (non-restaurant)
  // checkout posts revenue via the business-type profile's revenue_event (SALE.GOODS for retail, SALE.SERVICE
  // for services) instead of the restaurant-flavoured SALE.FOOD. Both DEFAULT to 4000 — byte-identical to the
  // current generic-sale GL — so a business can remap SALE.SERVICE to a distinct service-income account via a
  // GL-24 posting override (`free` tier) without a code change, and existing books never drift.
  'SALE.GOODS':       { name: 'Sale — goods revenue',          description: 'Generic retail-goods sale revenue leg (universal POS; profile revenue_event)', wired: true, roles: {
    revenue: r(CR, '4000', 'free', 'Sales revenue — goods') } },
  'SALE.SERVICE':     { name: 'Sale — service revenue',        description: 'Generic service sale revenue leg (universal POS; remap to a service-income account via override)', wired: true, roles: {
    revenue: r(CR, '4000', 'free', 'Sales revenue — services') } },
  'SALE.VAT':         { name: 'Sale — output VAT',             description: 'Output-VAT leg of a sale/CN/DN', wired: true, roles: {
    vat_output: r(CR, '2100', 'widen', 'Output VAT — PP30 tie sums the VAT-account set') } },
  'SALE.DELIVERY':    { name: 'Sale — delivery income',        description: 'Delivery-fee income on channel orders', wired: true, roles: {
    delivery_income: r(CR, '4100', 'free', 'Delivery income') } },
  'SVC.CHARGE':       { name: 'Sale — service charge',         description: 'Auto service-charge income (large parties)', wired: true, roles: {
    service_charge_income: r(CR, '4400', 'free', 'Service-charge income') } },
  'POS.ROUNDING':     { name: 'Sale — satang rounding',        description: 'Cash rounding adjustment (sign-conditional legs)', wired: true, roles: {
    rounding: r(CR, '4900', 'free', 'Rounding adjustment (gain=credit, loss=debit)') } },
  // docs/52 Phase 6a — split payment: the asset (cash) debit leg per tender METHOD. A split sale posts one Dr
  // per resolved tender account; ALL default to 1000 (Cash), so an all-default split collapses to the same
  // single Dr 1000 = total as the legacy single-tender path (net GL byte-identical). A shop that banks card /
  // QR proceeds into a clearing account (or draws a gift-card redemption down its 2200 liability) remaps the
  // relevant event via a GL-24 override — no code change (mirrors SALE.GOODS/SERVICE all defaulting to 4000).
  'TENDER.CASH':      { name: 'Tender — cash',                 description: 'Split-payment cash leg (asset debit)', wired: true, roles: {
    tender_asset: r(DR, '1000', 'pinned', 'Cash (CASH set)') } },
  'TENDER.CARD':      { name: 'Tender — card',                 description: 'Split-payment card leg (remap to a card-clearing/bank account via GL-24)', wired: true, roles: {
    tender_asset: r(DR, '1000', 'free', 'Cash/clearing for card proceeds') } },
  'TENDER.QR':        { name: 'Tender — QR / e-wallet',        description: 'Split-payment QR/PromptPay/e-wallet leg (remap to a clearing account via GL-24)', wired: true, roles: {
    tender_asset: r(DR, '1000', 'free', 'Cash/clearing for QR/e-wallet proceeds') } },
  'TENDER.VOUCHER':   { name: 'Tender — voucher / gift card',  description: 'Split-payment voucher/gift-card leg (remap to the 2200 gift-card liability via GL-24)', wired: true, roles: {
    tender_asset: r(DR, '1000', 'free', 'Cash/liability drawdown for voucher redemption') } },
  'TENDER.OTHER':     { name: 'Tender — other',                description: 'Split-payment fallback leg for any other method (asset debit)', wired: true, roles: {
    tender_asset: r(DR, '1000', 'free', 'Cash/clearing for other tender') } },
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
};
