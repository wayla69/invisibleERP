import { z } from 'zod';

const ItemInput = z.object({
  // menu-driven (resolved against the catalog — name/price/station/modifiers derived) — preferred
  sku: z.string().optional(),
  menu_item_id: z.number().int().optional(),
  modifier_option_ids: z.array(z.number().int()).optional(),
  // freeform / ad-hoc custom item — still supported
  item_id: z.string().optional(),
  name: z.string().min(1).optional(),
  unit_price: z.number().nonnegative().optional(),
  station_code: z.string().optional(),       // resolve to a kitchen station; else default
  modifiers: z.array(z.object({ label: z.string() })).optional(),
  // common
  qty: z.number().positive().default(1),
  notes: z.string().optional(),
  est_prep_minutes: z.number().int().positive().optional(),
  course: z.number().int().min(1).max(9).optional(),   // KDS course (default 1) — for course-by-course firing
  seat: z.number().int().min(1).max(99).optional(),    // seat-level ordering (POS-9): which guest seat ordered this line
}).refine((it) => it.sku != null || it.menu_item_id != null || (it.name != null && it.unit_price != null), {
  message: 'provide sku/menu_item_id (menu) or name+unit_price (custom item)',
});

export const CreateOrderBody = z.object({
  table_id: z.number().int().optional(),
  session_id: z.number().int().optional(),
  guest_count: z.number().int().positive().optional(),
  fulfillment_type: z.enum(['dine_in', 'takeaway', 'delivery', 'pickup']).optional(), // order type at the till (default dine_in)
  notes: z.string().optional(),
  items: z.array(ItemInput).min(1),
});
export type CreateOrderDto = z.infer<typeof CreateOrderBody>;

export const AddItemsBody = z.object({ items: z.array(ItemInput).min(1) });
export type AddItemsDto = z.infer<typeof AddItemsBody>;

// PUBLIC diner self-order (QR): menu-driven ONLY — the diner may never set a freeform name/price/station.
// Price/station/prep/86/modifier rules are resolved server-side from the catalog. Unknown keys are stripped
// by zod, so a tampered body cannot smuggle a unit_price or station_code.
const PublicItemInput = z.object({
  sku: z.string().optional(),
  menu_item_id: z.number().int().optional(),
  modifier_option_ids: z.array(z.number().int()).max(20).optional(),
  qty: z.number().int().positive().max(99).default(1),
  notes: z.string().max(200).optional(),
}).refine((it) => it.sku != null || it.menu_item_id != null, { message: 'menu item (sku or menu_item_id) required' });
export const PublicOrderBody = z.object({ items: z.array(PublicItemInput).min(1).max(50) });
export type PublicOrderDto = z.infer<typeof PublicOrderBody>;

// ── buffet packages / tiers (Phase 2) ──
export const BuffetPackageBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  name_en: z.string().optional(),
  price_per_pax: z.number().nonnegative(),
  time_limit_min: z.number().int().positive().optional(),
  overtime_fee_per_pax: z.number().nonnegative().optional(),
  item_skus: z.array(z.string()).optional(),       // menu items included in this tier
});
export type BuffetPackageDto = z.infer<typeof BuffetPackageBody>;

export const BuffetPackageUpdateBody = BuffetPackageBody.partial().extend({ active: z.boolean().optional() });
export type BuffetPackageUpdateDto = z.infer<typeof BuffetPackageUpdateBody>;

// PUBLIC diner: start a buffet on the table
export const StartBuffetBody = z.object({ package_id: z.number().int().positive(), pax: z.number().int().positive().max(99).optional() });
export type StartBuffetDto = z.infer<typeof StartBuffetBody>;

export const KdsActionBody = z.object({ action: z.enum(['start', 'ready', 'recall', 'serve', 'void']), reason: z.string().optional() });
export type KdsActionDto = z.infer<typeof KdsActionBody>;

export const CheckoutBody = z.object({
  method: z.string().optional(),
  discount: z.number().nonnegative().optional(),        // order-level FIXED amount (legacy)
  discount_pct: z.number().min(0).max(100).optional(),  // order-level PERCENT
  promo_code: z.string().optional(),
  voucher_code: z.string().optional(),                  // POS-3: campaign voucher OR loyalty member-coupon code (one redemption surface)
  line_discounts: z.record(z.string(), z.object({ discount_pct: z.number().min(0).max(100).optional(), discount_amt: z.number().nonnegative().optional() })).optional(), // { "<orderItemId>": {...} }
  member_id: z.number().int().positive().optional(),    // loyalty member earning/redeeming on this sale
  redeem_points: z.number().int().nonnegative().optional(),
  tip: z.number().nonnegative().optional(),             // staff tip (THB) — liability 2300, not in subtotal/VAT
  gift_card_no: z.string().optional(),                  // redeem this gift card as a tender against the sale
  gift_card_amount: z.number().positive().optional(),   // amount to draw (default = bill+tip)
  // B4 pricing rules at the till (opt-in). When set, time/day/BOGO/qty-break/item/category rules apply,
  // plus an auto service charge for large parties (VATable, 4400) and satang rounding (4900).
  apply_pricing_rules: z.boolean().optional(),
  channel: z.string().optional(),                       // 'dine_in'|'takeaway'|'delivery' — scopes rules
  location: z.string().optional(),                      // outlet/branch — scopes rules
  party_size: z.number().int().positive().optional(),   // for the auto service-charge threshold
  service_charge_pct: z.number().min(0).max(100).optional(),
  service_min_party: z.number().int().positive().optional(),
  rounding: z.number().positive().optional(),           // satang rounding multiple (e.g. 0.25, 1)
}).refine((d) => !(d.discount != null && d.discount_pct != null), { message: 'provide order discount amount or percent, not both' });
export type CheckoutDto = z.infer<typeof CheckoutBody>;

// ── tables / floor-plan ──
export const CreateTableBody = z.object({
  table_no: z.string().min(1), zone_id: z.number().int().nullable().optional(), seats: z.number().int().positive().optional(),
  shape: z.enum(['rect', 'circle', 'square']).optional(), pos_x: z.number().optional(), pos_y: z.number().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(), rotation: z.number().int().min(0).max(359).optional(),
});
export type CreateTableDto = z.infer<typeof CreateTableBody>;

// `rev` = optimistic-concurrency token: PATCH only applies if it matches the table's current rev
// (else 409 STALE_WRITE). Optional — omit it for an unconditional (last-write-wins) update.
export const UpdateTableBody = CreateTableBody.partial().extend({ rev: z.number().int().nonnegative().optional() });
export type UpdateTableDto = z.infer<typeof UpdateTableBody>;

export const TableStatusBody = z.object({ status: z.enum(['available', 'reserved', 'occupied', 'bill_requested', 'paying', 'cleaning', 'out_of_service']) });

// move a live tab to another (free) table
export const MoveTableBody = z.object({ to_table_id: z.number().int().positive() });

// move selected line items to another table's open order
export const TransferItemsBody = z.object({ item_ids: z.array(z.number().int().positive()).min(1).max(100), to_table_id: z.number().int().positive() });

// merge another table's tab into this one (combined bill)
export const MergeTablesBody = z.object({ from_table_id: z.number().int().positive() });

// POS-9: (re)assign selected (non-voided) line items to a guest seat (null = shared/table).
export const AssignSeatBody = z.object({
  item_ids: z.array(z.number().int().positive()).min(1).max(100),
  seat: z.number().int().min(1).max(99).nullable(),
});

export const ZoneBody = z.object({
  name: z.string().min(1), sort_order: z.number().int().optional(),
  pos_x: z.number().optional(), pos_y: z.number().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(),
  color: z.string().max(32).nullable().optional(),
});
export type ZoneDto = z.infer<typeof ZoneBody>;
export const ZoneUpdateBody = ZoneBody.partial();
export type ZoneUpdateDto = z.infer<typeof ZoneUpdateBody>;

export const StationBody = z.object({ code: z.string().min(1), name: z.string().min(1), sort: z.number().int().optional(), default_prep_minutes: z.number().int().positive().optional() });
