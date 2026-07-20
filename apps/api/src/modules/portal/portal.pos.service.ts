import { Inject, Injectable, Optional, BadRequestException } from '@nestjs/common';
import { sql, eq, ne, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { UsageMeterService } from '../usage/usage-meter.service';
import {
  custPosSales, custPosItems, customerInventory, custStockLog, branchStock,
  loyaltyConfig, loyaltyPoints, loyaltyTxn, branches, items, itemRelationships,
} from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { PortalService } from './portal.service';
import { TaxService } from '../tax/tax.service';
import { roundCurrency } from '../tax/money';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { RecipeService } from '../menu/recipe.service';
import { CostingService } from '../costing/costing.service';
import { PricingService } from '../pricing/pricing.service';
import { JournalService } from '../pos/fiscal/journal.service';
import { LockingService } from '../pos/scale/locking.service';
import { LotsService } from '../lots/lots.service';
import { SerialsService } from '../serials/serials.service';
import { PriceBookService } from '../pricing/price-book.service';
import { PosControlService } from '../pos/control/pos-control.service';

export interface PortalSaleDto {
  items: { item_id: string; item_description?: string; qty: number; unit_price: number; uom?: string; discount_pct?: number; modifier_option_ids?: number[]; lot_no?: string; serial_nos?: string[] }[];
  discount?: number;
  payment_method?: string;
  notes?: string;
  apply_pricing?: boolean;   // opt-in: fold pricing-engine rule discounts into the order discount
  channel?: string;
  party_size?: number;
  service_charge_pct?: number;  // B4: auto service charge for large parties (VATable → acct 4400)
  service_min_party?: number;   // B4: party threshold for service charge (default 6)
  rounding?: number;            // B4: satang rounding step (0 = disabled) → acct 4900
  branch_id?: number;           // multi-branch: tag the sale to an outlet (must belong to this tenant)
  // docs/52 Phase 3c — age-restricted gate: when the cart contains an age-restricted item (min_age > 0) the
  // sale must be age-verified — the cashier attests they checked ID (`age_ack`) OR a `customer_birthdate`
  // (YYYY-MM-DD) proves the buyer meets the highest required age. Absent an age-restricted item, both are ignored.
  age_ack?: boolean;
  customer_birthdate?: string;
  // docs/52 Phase 6a — split payment: settle one sale with several tenders (cash + card + QR + voucher …).
  // Each leg's `amount` is what it APPLIES to the sale; the legs must sum EXACTLY to the total. A cash leg may
  // carry `cash_tendered` > amount to record change (mirrors #1). ABSENT ⇒ the single-tender path (unchanged).
  tenders?: { method: string; amount: number; gateway?: string; cash_tendered?: number; reference?: string }[];
  // docs/52 Phase 4a — price books: the customer PRICE TIER for this sale (retail|wholesale|vip|member…). When
  // a tier (or the branch) has an active, approved book pricing an item, that governed price OVERRIDES the
  // line's client-supplied unit_price. ABSENT (and no branch book) ⇒ the client price stands (byte-identical).
  price_tier?: string;
  // docs/52 Phase 4d — B2B contract pricing: a negotiated per-customer book (most specific) prices the sale's
  // items ahead of any tier/branch book. ABSENT ⇒ no customer scope ⇒ byte-identical.
  customer_code?: string;
  // docs/52 Phase 4b — discount authority: when a manual line/bill discount exceeds the tenant's configured
  // cap, the sale must reference a supervisor's discount authorization (an OVR- number from
  // POST /api/pos/discount-authorize). ABSENT caps (the default) ⇒ no gate ⇒ byte-identical.
  discount_approval_no?: string;
}

// docs/52 Phase 6a — map a tender method label to its GL posting event. Each TENDER.* event defaults its
// asset debit to 1000 (Cash) and is GL-24-remappable, so a shop that banks card/QR proceeds into a clearing
// account remaps them without a code change (mirrors SALE.GOODS/SERVICE all defaulting to 4000).
export function tenderEvent(method: string): string {
  const m = (method || '').toLowerCase();
  if (/cash|เงินสด/.test(m)) return 'TENDER.CASH';
  if (/card|บัตร|credit|debit|visa|master|amex|jcb/.test(m)) return 'TENDER.CARD';
  if (/qr|promptpay|prompt|wallet|วอลเล็ท|โอน|transfer|linepay|truemoney/.test(m)) return 'TENDER.QR';
  if (/voucher|gift|coupon|คูปอง|บัตรกำนัล|เครดิตร้าน/.test(m)) return 'TENDER.VOUCHER';
  return 'TENDER.OTHER';
}
const isCashMethod = (method: string): boolean => /cash|เงินสด/.test((method || '').toLowerCase());

// docs/52 Phase 3c — full years between a birthdate and the sale (business) date, both 'YYYY-MM-DD'.
function ageOnDate(birthdate: string, onDate: string): number {
  const bp = birthdate.slice(0, 10).split('-'); const op = onDate.slice(0, 10).split('-');
  const by = +(bp[0] ?? 0), bm = +(bp[1] ?? 0), bd = +(bp[2] ?? 0);
  const oy = +(op[0] ?? 0), om = +(op[1] ?? 0), od = +(op[2] ?? 0);
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

@Injectable()
export class PortalPosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly portal: PortalService,
    private readonly tax: TaxService,
    private readonly payments: PaymentService,
    private readonly ledger: LedgerService,
    private readonly recipe: RecipeService,
    @Optional() private readonly costing?: CostingService, // Phase 17A — costed COGS for configured retail items
    @Optional() private readonly pricing?: PricingService,  // wiring: rule discounts at checkout (opt-in)
    @Optional() private readonly journal?: JournalService,  // wiring: append electronic journal per sale
    @Optional() private readonly locking?: LockingService,  // wiring: auto-86 recompute after stock decrement
    @Optional() private readonly usage?: UsageMeterService,  // 1.5 — meter one billable POS transaction per sale
    @Optional() private readonly lots?: LotsService,  // docs/52 Phase 3a — FEFO lot capture for lot-tracked items
    @Optional() private readonly serials?: SerialsService,  // docs/52 Phase 3b — serial/IMEI capture for serial-tracked items
    @Optional() private readonly priceBooks?: PriceBookService,  // docs/52 Phase 4a — governed tier/branch base price
    @Optional() private readonly posControl?: PosControlService,  // docs/52 Phase 4b — over-cap discount authority
  ) {}

  // POST /api/portal/pos/sales — retail sale (SALE-) + stock decrement + loyalty earn.
  // opts.saleDate (offline sync) books the sale + its GL on the original offline day, not today.
  // docs/52 Phase 1b — this same generic engine now backs the INTERNAL register's non-restaurant checkout:
  //   • opts.tenant lets an internal caller (whose customerName is not the tenant CODE, so portal.tenantId
  //     can't resolve it) pass the already-resolved tenant explicitly; default = the portal resolution
  //     (unchanged for portal callers).
  //   • opts.revenueEvent selects the revenue posting-event (SALE.GOODS/SALE.SERVICE per the business-type
  //     profile); default 'SALE.FOOD' → byte-identical GL to the prior behaviour (all three default to 4000).
  async createSale(dto: PortalSaleDto, user: JwtUser, opts?: { saleDate?: string; branchId?: number; tenant?: { id: number; code: string }; revenueEvent?: string }) {
    const t = opts?.tenant ?? await this.portal.tenantId(user);
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการสินค้า' });

    // multi-branch tag: validate the outlet belongs to this tenant (explicit tenant predicate even under
    // Admin RLS-bypass) so a sale can't be mis-tagged to a foreign branch. NULL = untagged (backward-compat).
    const branchId = opts?.branchId ?? dto.branch_id ?? null;
    if (branchId != null) {
      const [br] = await db.select({ id: branches.id }).from(branches)
        .where(and(eq(branches.id, Number(branchId)), eq(branches.tenantId, t.id), eq(branches.active, true))).limit(1);
      if (!br) throw new BadRequestException({ code: 'BRANCH_NOT_FOUND', message: `Branch ${branchId} not found for this tenant`, messageTh: 'ไม่พบสาขาของร้านนี้' });
    }

    // docs/52 Phase 4a — price books: resolve a GOVERNED base price per line by the sale's customer tier +
    // branch BEFORE any discount. When an active, approved book prices the item, its price OVERRIDES the
    // client-supplied unit_price (an auditable basis, not a number typed at the till). No matching book ⇒ the
    // client price stands ⇒ byte-identical. Only consulted when a tier or branch is in play (default path skips it).
    let saleItems = dto.items;
    if (this.priceBooks && (dto.price_tier || dto.customer_code || branchId != null)) {
      const qtyByItem = new Map<string, number>();
      for (const it of dto.items) qtyByItem.set(String(it.item_id), (qtyByItem.get(String(it.item_id)) ?? 0) + n(it.qty));
      const booked = await this.priceBooks.resolvePriceMany(t.id, dto.items.map((it) => String(it.item_id)), { tier: dto.price_tier ?? null, branchId, customerCode: dto.customer_code ?? null, at: opts?.saleDate, qtyByItem });
      if (booked.size) saleItems = dto.items.map((it) => { const b = booked.get(String(it.item_id)); return b ? { ...it, unit_price: b.unit_price } : it; });
    }

    const lines = saleItems.map((it) => {
      const gross = n(it.qty) * n(it.unit_price);
      const lineDisc = gross * (n(it.discount_pct) / 100);
      return { ...it, amount: roundCurrency(gross - lineDisc, 'THB') };
    });
    const subtotal = roundCurrency(lines.reduce((a, l) => a + l.amount, 0), 'THB');
    // docs/52 Phase 2a — resolve each line against the shared `items` master to read its supplyType. A line
    // whose item_id has NO master row defaults to 'goods' (byte-identical to the prior uncontrolled path). A
    // 'service' line (e.g. a haircut, a consultation) is NOT a stocked good: it skips the inventory/COGS
    // moves below and its revenue posts to the service revenue event. Goods-only sales are unchanged.
    const itemIds = [...new Set(lines.map((l) => String(l.item_id)))];
    const masterRows = itemIds.length ? await db.select({ id: items.id, itemId: items.itemId, supplyType: items.supplyType, isLotTracked: items.isLotTracked, isSerialTracked: items.isSerialTracked, minAge: items.minAge }).from(items).where(inArray(items.itemId, itemIds)) : [];
    const supplyByItem = new Map<string, string>(masterRows.map((r: any) => [String(r.itemId), String(r.supplyType ?? 'goods')]));
    // docs/52 Phase 3a — a lot-tracked item sells only from a real, non-expired, non-held lot (FEFO). Non-tracked
    // items (the default) capture no lot → byte-identical. Service/non_inventory lines are never lot-tracked.
    const lotTracked = new Set<string>(masterRows.filter((r: any) => r.isLotTracked).map((r: any) => String(r.itemId)));
    // docs/52 Phase 3b — a serial-tracked item sells as specific serial/IMEI unit(s); the line must carry one
    // in-stock serial per unit. Non-tracked items capture no serial → byte-identical.
    const serialTracked = new Set<string>(masterRows.filter((r: any) => r.isSerialTracked).map((r: any) => String(r.itemId)));
    // docs/52 Phase 3c — age-restricted gate. The required age is the HIGHEST min_age across the cart (0 =
    // unrestricted). When > 0 the sale must be age-verified BEFORE anything is persisted: a `customer_birthdate`
    // proves the buyer meets it, or the cashier attests (`age_ack`) they checked ID — else the sale is refused.
    const requiredAge = masterRows.reduce((m: number, r: any) => Math.max(m, Number(r.minAge) || 0), 0);
    let ageVerified = false;
    if (requiredAge > 0) {
      const bizDate = opts?.saleDate ?? ymd();
      if (dto.customer_birthdate) {
        const age = ageOnDate(String(dto.customer_birthdate), bizDate);
        if (age < requiredAge) throw new BadRequestException({ code: 'AGE_BELOW_MINIMUM', message: `Customer age ${age} is under the required minimum ${requiredAge}`, messageTh: `ลูกค้าอายุ ${age} ปี ต่ำกว่าเกณฑ์ ${requiredAge} ปี` });
        ageVerified = true;
      } else if (dto.age_ack === true) {
        ageVerified = true;
      } else {
        throw new BadRequestException({ code: 'AGE_VERIFICATION_REQUIRED', message: `This sale contains an age-restricted item (min age ${requiredAge}) — verify the buyer's age`, messageTh: `รายการนี้มีสินค้าจำกัดอายุ (ขั้นต่ำ ${requiredAge} ปี) — ต้องยืนยันอายุผู้ซื้อ` });
      }
    }
    const isSvc = (l: { item_id: string }) => supplyByItem.get(String(l.item_id)) === 'service';
    // docs/52 Phase 2c — a 'service' OR 'non_inventory' line moves no stock and books no COGS; the only
    // difference is revenue routing (service → SALE.SERVICE via isSvc; non-inventory → the goods event).
    const skipStock = (l: { item_id: string }) => { const s = supplyByItem.get(String(l.item_id)); return s === 'service' || s === 'non_inventory'; };
    // docs/52 Phase 2c — kits/bundles: a kit PARENT sells as one line at one price but consumes its COMPONENT
    // stock/COGS on sale (the kit SKU itself is not stocked). Components are tenant-scoped item_relationships
    // rows (rel_type='kit_component', from=kit → to=component) carrying the per-kit qty. Map: kit code →
    // [{ componentId, qty }]. A goods line with no kit_component rows is a plain line (byte-identical path).
    const kitByItem = new Map<string, { componentId: string; qty: number }[]>();
    if (masterRows.length) {
      const codeById = new Map<number, string>(masterRows.map((r: any) => [Number(r.id), String(r.itemId)]));
      const relRows = await db.select({ fromId: itemRelationships.fromItemId, compCode: items.itemId, qty: itemRelationships.qty })
        .from(itemRelationships)
        .innerJoin(items, eq(itemRelationships.toItemId, items.id))
        .where(and(eq(itemRelationships.tenantId, t.id), eq(itemRelationships.relType, 'kit_component'), inArray(itemRelationships.fromItemId, [...codeById.keys()])));
      for (const rr of relRows) {
        const kitCode = codeById.get(Number(rr.fromId));
        if (!kitCode) continue;
        const arr = kitByItem.get(kitCode) ?? [];
        arr.push({ componentId: String(rr.compCode), qty: Number(rr.qty ?? 1) });
        kitByItem.set(kitCode, arr);
      }
    }
    // wiring: opt-in pricing engine — fold rule discounts (happy-hour/BOGO/qty-break/order) into the
    // order discount. GL stays balanced (cash leg = total = taxable + vat). Advisory: never block a sale.
    let pricingDiscount = 0;
    if (dto.apply_pricing && this.pricing) {
      try {
        const q = await this.pricing.quote({ channel: dto.channel, party_size: dto.party_size, lines: lines.map((l) => ({ sku: String(l.item_id), qty: n(l.qty), unit_price: n(l.unit_price) })) }, user);
        pricingDiscount = roundCurrency(n(q.line_discount_total) + n(q.order_discount), 'THB');
      } catch { /* pricing is advisory at checkout */ }
    }
    const discount = roundCurrency(n(dto.discount) + pricingDiscount, 'THB');
    const taxable = Math.max(0, subtotal - discount);
    // B4: auto service charge for large parties (VATable service income → acct 4400). Zero unless opted-in.
    const scPct = dto.apply_pricing ? (dto.service_charge_pct ?? 0) : 0;
    const minParty = dto.service_min_party ?? 6;
    const serviceCharge = scPct > 0 && (dto.party_size ?? 0) >= minParty ? roundCurrency(taxable * scPct / 100, 'THB') : 0;
    const taxableTotal = roundCurrency(taxable + serviceCharge, 'THB');
    // pluggable tax (move #5) — no more hard-coded VAT 7%
    const taxCalc = this.tax.calcTax({ net: taxableTotal, country: 'TH' });
    const vat = taxCalc.tax;
    // B4: satang rounding (→ acct 4900). Zero unless opted-in with rounding > 0.
    const roundTo = dto.apply_pricing ? (dto.rounding ?? 0) : 0;
    const preRoundTotal = roundCurrency(taxableTotal + vat, 'THB');
    const total = roundTo > 0 ? roundCurrency(Math.round(preRoundTotal / roundTo) * roundTo, 'THB') : preRoundTotal;
    const roundingAdj = roundCurrency(total - preRoundTotal, 'THB');

    // docs/52 Phase 6a — split payment: validate the tenders BEFORE persisting anything (fail fast). Each leg
    // applies its `amount` to the sale; the legs must sum EXACTLY to the total. A cash leg may over-tender
    // (change), but a non-cash leg must be exact — you can't over-charge a card. ABSENT ⇒ single-tender path.
    const splitTenders = dto.tenders?.length ? dto.tenders : null;
    if (splitTenders) {
      for (const leg of splitTenders) {
        if (!(n(leg.amount) > 0)) throw new BadRequestException({ code: 'BAD_TENDER', message: 'Each tender amount must be positive', messageTh: 'จำนวนเงินแต่ละรายการต้องมากกว่าศูนย์' });
        if (!isCashMethod(leg.method) && leg.cash_tendered != null && roundCurrency(n(leg.cash_tendered), 'THB') !== roundCurrency(n(leg.amount), 'THB'))
          throw new BadRequestException({ code: 'NONCASH_OVERTENDER', message: 'Only a cash tender can over-tender (change)', messageTh: 'มีเพียงเงินสดเท่านั้นที่ทอนเงินได้' });
      }
      const applied = roundCurrency(splitTenders.reduce((a, l) => a + n(l.amount), 0), 'THB');
      if (Math.abs(applied - total) > 0.001)
        throw new BadRequestException({ code: 'TENDER_MISMATCH', message: `Tenders apply ${applied} but the sale total is ${total}`, messageTh: `ยอดชำระรวม (${applied}) ไม่ตรงกับยอดที่ต้องชำระ (${total})` });
    }

    // docs/52 Phase 4b — discount authority: a MANUAL line/bill discount above the tenant's configured cap
    // requires a supervisor's authorization (SoD R08). Both caps NULL (the default) ⇒ no gate ⇒ byte-identical.
    // The gate is on the manual discounts (`items[].discount_pct`, `discount`), not the pricing-engine discount.
    let discountConsume: { overrideNo: string; requestedPct: number; discountAmount: number } | null = null;
    if (this.posControl) {
      const caps = await this.posControl.getDiscountSettings(t.id);
      if (caps.maxLinePct != null || caps.maxBillPct != null) {
        const maxLinePct = dto.items.reduce((m, it) => Math.max(m, n(it.discount_pct)), 0);
        const billPct = subtotal > 0 ? (n(dto.discount) / subtotal) * 100 : 0;
        const lineOver = caps.maxLinePct != null && maxLinePct > caps.maxLinePct + 1e-6;
        const billOver = caps.maxBillPct != null && billPct > caps.maxBillPct + 1e-6;
        if (lineOver || billOver) {
          const requestedPct = Math.max(lineOver ? maxLinePct : 0, billOver ? billPct : 0);
          // total MANUAL discount ฿ (line-level markdowns folded into subtotal + the bill-level discount) —
          // this is what an authorization's optional baht cap bounds.
          const lineDiscountAmt = saleItems.reduce((a, it) => a + n(it.qty) * n(it.unit_price) * (n(it.discount_pct) / 100), 0);
          const discountAmount = roundCurrency(lineDiscountAmt + n(dto.discount), 'THB');
          if (!dto.discount_approval_no)
            throw new BadRequestException({ code: 'DISCOUNT_APPROVAL_REQUIRED', message: `A ${requestedPct.toFixed(2)}% discount exceeds the cap (line ${caps.maxLinePct ?? '—'}% / bill ${caps.maxBillPct ?? '—'}%) — a supervisor must authorize it`, messageTh: `ส่วนลด ${requestedPct.toFixed(2)}% เกินเพดานที่กำหนด — ต้องให้หัวหน้าอนุมัติก่อน` });
          discountConsume = { overrideNo: dto.discount_approval_no, requestedPct, discountAmount };
        }
      }
    }

    // SALE- number, collision-safe: the second-precision stamp can clash for rapid sales → retry on a
    // bumped second until cust_pos_sales.sale_no (UNIQUE) is free.
    let saleNo = this.docNo.nextTenantStamped('SALE', t.code);
    for (let attempt = 1; attempt < 12; attempt++) {
      const [exists] = await this.db.select({ id: custPosSales.id }).from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
      if (!exists) break;
      saleNo = this.docNo.nextTenantStamped('SALE', t.code, new Date(Date.now() + attempt * 1000));
    }
    const today = opts?.saleDate ?? ymd();
    const now = new Date();
    let recipeCogs = 0;
    const nonRecipeLines: { itemId: string; qty: number }[] = []; // Phase 17A — costed COGS for these

    // loyalty earn (parity with central POS)
    let pointsEarned = 0;
    const [cfg] = await db.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    if (cfg?.enabled) pointsEarned = roundCurrency(total * n(cfg.pointsPerBaht), 'THB');

    await db.transaction(async (tx: any) => {
      const [h] = await tx.insert(custPosSales).values({
        saleNo, saleDate: today, tenantId: t.id, branchId, subtotal: fx(subtotal, 2), discount: fx(discount, 2),
        taxAmount: fx(vat, 2), total: fx(total, 2), serviceCharge: fx(serviceCharge, 2), paymentMethod: dto.payment_method ?? 'Cash',
        pointsUsed: '0', pointsEarned: String(pointsEarned), status: 'Completed', notes: dto.notes ?? null, ageVerified, createdBy: user.username,
      }).returning({ id: custPosSales.id });

      // docs/52 Phase 4b — consume the supervisor discount authorization inside the sale tx (fail-closed +
      // single-use), so a rolled-back sale never burns it and a concurrent sale can't reuse it (SoD R08).
      if (this.posControl && discountConsume)
        await this.posControl.consumeDiscountApproval(tx, { tenantId: t.id, user, overrideNo: discountConsume.overrideNo, requestedPct: discountConsume.requestedPct, discountAmount: discountConsume.discountAmount, saleNo });

      // docs/52 Phase 3a — resolve the lot(s) for each lot-tracked line BEFORE writing the sale lines, so the
      // line carries the consumed lot and the sale fails fast (whole request rolls back) on an expired / held /
      // missing lot. FEFO by default; an explicit `lot_no` overrides. Non-tracked lines resolve to no lot.
      const lotByLine: (string | null)[] = new Array(lines.length).fill(null);
      const lotExpiryByLine: (string | null)[] = new Array(lines.length).fill(null);
      const serialByLine: (string | null)[] = new Array(lines.length).fill(null);
      for (const [i, l] of lines.entries()) {
        if (lotTracked.has(String(l.item_id))) {
          if (!this.lots) throw new BadRequestException({ code: 'LOT_TRACKING_UNAVAILABLE', message: 'Lot tracking is not available', messageTh: 'ระบบล็อตไม่พร้อมใช้งาน' });
          const alloc = await this.lots.consumeForSale(tx, { itemId: String(l.item_id), qty: n(l.qty), refDoc: saleNo, bizToday: today, explicitLot: l.lot_no, createdBy: user.username });
          const first = alloc[0];
          if (first) { lotByLine[i] = first.lot_no; lotExpiryByLine[i] = first.expiry; }
        }
        // docs/52 Phase 3b — a serial-tracked line consumes the exact serial/IMEI unit(s) it names (one per unit);
        // the sale fails closed (whole request rolls back) on a missing / already-sold / count-mismatched serial.
        if (serialTracked.has(String(l.item_id))) {
          if (!this.serials) throw new BadRequestException({ code: 'SERIAL_TRACKING_UNAVAILABLE', message: 'Serial tracking is not available', messageTh: 'ระบบซีเรียลไม่พร้อมใช้งาน' });
          const used = await this.serials.consumeForSale(tx, { tenantId: t.id, itemId: String(l.item_id), serialNos: l.serial_nos ?? [], qty: n(l.qty), saleNo, createdBy: user.username });
          serialByLine[i] = used[0] ?? null;
        }
      }

      await tx.insert(custPosItems).values(lines.map((l, i) => ({
        saleId: Number(h.id), itemId: l.item_id, itemDescription: l.item_description ?? null,
        qty: String(n(l.qty)), uom: l.uom ?? null, unitPrice: fx(l.unit_price, 2),
        discountPct: String(n(l.discount_pct)), amount: fx(l.amount, 2), isCustom: false,
        lotNo: lotByLine[i], expiryDate: lotExpiryByLine[i], serialNo: serialByLine[i],
      })));

      // decrement customer inventory (MAX(0,...)) + stock log. Phase 2c: extracted per-physical-quantity so a
      // kit/bundle line can explode into its components and a plain goods line stays byte-identical.
      const processStockQty = async (itemId: string, qty: number) => {
        const [inv] = await tx.select().from(customerInventory)
          .where(and(eq(customerInventory.tenantId, t.id), eq(customerInventory.itemId, itemId))).limit(1);
        if (inv) {
          const newStock = Math.max(0, n(inv.currentStock) - qty);
          await tx.update(customerInventory).set({ currentStock: String(newStock), lastUpdated: now }).where(eq(customerInventory.id, inv.id));
          await tx.insert(custStockLog).values({
            tenantId: t.id, branchId, itemId, itemDescription: inv.itemDescription, logDate: now, logType: 'Sale',
            qtyChange: String(-qty), balanceAfter: String(newStock), refDoc: saleNo, notes: null, createdBy: user.username,
          });
          // mirror into the per-branch ledger (branch-aware replenishment). Same MAX(0) clamp as the rollup above.
          if (branchId != null) {
            const [bs] = await tx.select().from(branchStock).where(and(eq(branchStock.tenantId, t.id), eq(branchStock.branchId, branchId), eq(branchStock.itemId, itemId))).for('update').limit(1);
            if (bs) await tx.update(branchStock).set({ onHand: String(Math.max(0, n(bs.onHand) - qty)), lastUpdated: now }).where(eq(branchStock.id, bs.id));
            else await tx.insert(branchStock).values({ tenantId: t.id, branchId, itemId, itemDescription: inv.itemDescription, uom: inv.uom ?? null, onHand: '0', lastUpdated: now });
          }
        }
        // recipe/BOM: deduct ingredients for a recipe-backed menu line (ingredient item_ids differ from the dish SKU)
        const ded = await this.recipe.applyDeduction(tx, t.id, itemId, qty, saleNo, user, branchId);
        recipeCogs = roundCurrency(recipeCogs + ded.cost, 'THB');
        if (!ded.deducted) nonRecipeLines.push({ itemId, qty }); // non-recipe → costed COGS
      };
      const roundQty = (x: number) => Math.round(x * 1000) / 1000; // numeric(14,3) — avoid float drift on qty math

      for (const l of lines) {
        // Phase 2a/2c: a service or non-inventory line is not stocked — no inventory decrement, no recipe/BOM, no COGS.
        if (skipStock(l)) continue;
        // Phase 2c: a kit/bundle line explodes into its components (component stock + COGS); a plain goods line
        // processes its own SKU exactly as before. The kit SKU itself is never decremented/costed.
        const kit = kitByItem.get(String(l.item_id));
        if (kit && kit.length) {
          for (const c of kit) await processStockQty(c.componentId, roundQty(c.qty * n(l.qty)));
        } else {
          await processStockQty(String(l.item_id), n(l.qty));
        }
        // Step 1 — modifier COGS: chosen options ("extra patty") add their standard cost to the line's COGS
        // (Dr 5300 / Cr 1200), so menu modifiers no longer move price without moving cost of goods.
        const modCogs = await this.recipe.modifierCogs(tx, t.id, l.modifier_option_ids ?? [], n(l.qty));
        recipeCogs = roundCurrency(recipeCogs + modCogs, 'THB');
      }

      // loyalty accrual
      if (pointsEarned > 0) {
        const [lp] = await tx.select().from(loyaltyPoints).where(eq(loyaltyPoints.tenantId, t.id)).limit(1);
        const newBalance = n(lp?.balance) + pointsEarned;
        const newLifetime = n(lp?.lifetime) + pointsEarned;
        await tx.insert(loyaltyPoints).values({ tenantId: t.id, balance: String(newBalance), lifetime: String(newLifetime), lastUpdated: now })
          .onConflictDoUpdate({ target: loyaltyPoints.tenantId, set: { balance: String(newBalance), lifetime: String(newLifetime), lastUpdated: now } });
        await tx.insert(loyaltyTxn).values({ tenantId: t.id, txnDate: now, txnType: 'Earn', points: String(pointsEarned), balanceAfter: String(newBalance), refDoc: saleNo });
      }
    });

    // Tender (move #3) + GL posting (move #2) are part of the sale's atomicity — same request tx.
    // We do NOT swallow their errors: a swallowed DB failure here poisons the request tx (Postgres
    // aborts it), so the interceptor's COMMIT becomes a ROLLBACK and we'd return 200 + sale_no for a
    // sale that was never persisted (phantom sale). Letting them propagate rolls the whole sale back
    // atomically — no sale without its money + books.
    // A zero-total sale (e.g. 100% comp/discount) has no money movement and no VAT — skip the tender
    // and the GL posting (recordTender rejects amount<=0 and an all-zero journal has nothing to post).
    let tender: any = null;
    let je: any = null;
    let splitTenderResults: any[] | null = null;
    // recipe COGS (gated by post_cogs): Dr 5300 / Cr 1200 — posted alongside the sale's GL (same request tx)
    if (recipeCogs > 0 && !(await this.ledger.alreadyPosted('POS-COGS', saleNo))) {
      await this.ledger.postEntry({ date: today, source: 'POS-COGS', sourceRef: saleNo, tenantId: t.id, memo: `COGS ${saleNo}`, createdBy: user.username, lines: [{ account_code: '5300', debit: recipeCogs }, { account_code: '1200', credit: recipeCogs }] });
    }
    // Phase 17A — costed COGS (Dr 5000 / Cr 1200) for non-recipe lines whose item has a costing method
    if (this.costing && nonRecipeLines.length) await this.costing.onIssue({ tenantId: t.id, saleNo, date: today, lines: nonRecipeLines, createdBy: user.username });
    if (total > 0) {
      // Link this tender to the shop's open till (if any) so closeTill sees POS cash (move #5 reconciliation).
      const openTill = await this.payments.currentOpenTill(t.id);
      // Phase 6a: a split sale records ONE tender per leg (all linked to sale_no + till → each shows in the
      // pending-settlement worklist + drawer count); a stable per-leg idempotency key makes a retry safe. The
      // single-tender path is unchanged (no key → byte-identical).
      if (splitTenders) {
        splitTenderResults = [];
        for (const [i, leg] of splitTenders.entries()) {
          const r = await this.payments.recordTender(
            { sale_no: saleNo, tenant_id: t.id, method: leg.method, amount: roundCurrency(n(leg.amount), 'THB'),
              cash_tendered: leg.cash_tendered != null ? n(leg.cash_tendered) : undefined,
              currency: 'THB', gateway: leg.gateway ?? 'mock', till_session_id: openTill?.id, idempotency_key: `${saleNo}#${i}` },
            user,
          );
          splitTenderResults.push({ ...r, method: leg.method });
        }
        tender = splitTenderResults[0];
      } else {
        tender = await this.payments.recordTender(
          { sale_no: saleNo, tenant_id: t.id, method: dto.payment_method ?? 'Cash', amount: total, currency: 'THB', gateway: 'mock', till_session_id: openTill?.id },
          user,
        );
      }
      // docs/43 PR-6: revenue/service-charge/rounding legs follow the tenant posting-rules (batched,
      // cached read); cash/VAT legs stay pinned/widen-gated.
      // revenue posts under the business-type profile's event (SALE.GOODS/SALE.SERVICE for a generic POS),
      // default SALE.FOOD — all three default to 4000, so the GL is unchanged unless a tenant remaps via GL-24.
      const revEvent = opts?.revenueEvent ?? 'SALE.FOOD';
      // Phase 2a: split the item revenue by supplyType — goods lines post to the caller's revenue event, service
      // lines to SALE.SERVICE. The service base gets the proportional share of the (rounded) taxable amount; goods
      // takes the residual so the two legs sum EXACTLY to `taxable` (a goods-only sale → serviceTaxable 0 → a single
      // goods leg == the prior behaviour, byte-identical). SALE.SERVICE is only read/posted when a service line exists.
      const hasService = lines.some(isSvc);
      const serviceSubtotal = hasService ? roundCurrency(lines.filter(isSvc).reduce((a, l) => a + l.amount, 0), 'THB') : 0;
      const serviceTaxable = hasService && subtotal > 0 ? roundCurrency(taxable * serviceSubtotal / subtotal, 'THB') : 0;
      const goodsTaxable = roundCurrency(taxable - serviceTaxable, 'THB');
      const povr = await this.ledger.postingOverridesMany(hasService ? [revEvent, 'SALE.SERVICE', 'SVC.CHARGE', 'POS.ROUNDING'] : [revEvent, 'SVC.CHARGE', 'POS.ROUNDING'], t.id);
      const pRev = povr[revEvent]?.revenue ?? postingDefault(revEvent, 'revenue');
      const pSvcRev = hasService ? (povr['SALE.SERVICE']?.revenue ?? postingDefault('SALE.SERVICE', 'revenue')) : pRev;
      const pSvc = povr['SVC.CHARGE']?.service_charge_income ?? postingDefault('SVC.CHARGE', 'service_charge_income');
      const pRnd = povr['POS.ROUNDING']?.rounding ?? postingDefault('POS.ROUNDING', 'rounding');
      // Phase 6a: the asset (cash) debit. Single-tender → one Dr 1000 = total (unchanged). Split → one Dr per
      // resolved TENDER.<METHOD> asset account, legs grouped + summed. All methods default to 1000, so an
      // all-default split collapses to the same single Dr 1000 = total (net GL byte-identical); a tenant that
      // remaps card/QR to a clearing account gets a proper multi-account debit. Legs sum to `taxableTotal + vat`
      // = the pre-rounding total; the rounding legs below reconcile to the rounded cash `total`.
      let tenderLines: { account_code: string; debit: number }[];
      if (splitTenders) {
        const events = [...new Set(splitTenders.map((l) => tenderEvent(l.method)))];
        const tpovr = await this.ledger.postingOverridesMany(events, t.id);
        const byAcct = new Map<string, number>();
        for (const leg of splitTenders) {
          const ev = tenderEvent(leg.method);
          const acct = tpovr[ev]?.tender_asset ?? postingDefault(ev, 'tender_asset');
          byAcct.set(acct, roundCurrency((byAcct.get(acct) ?? 0) + n(leg.amount), 'THB'));
        }
        tenderLines = [...byAcct.entries()].map(([account_code, debit]) => ({ account_code, debit }));
      } else {
        tenderLines = [{ account_code: '1000', debit: total }];
      }
      je = await this.ledger.postEntry({
        date: today, source: 'POS', sourceRef: saleNo, tenantId: t.id, memo: `Retail sale ${saleNo}`, createdBy: user.username,
        lines: [
          ...tenderLines,                             // Dr Cash / tender assets (sum = rounded total)
          ...(roundingAdj < 0 ? [{ account_code: pRnd, debit: roundCurrency(-roundingAdj, 'THB') }] : []),
          ...(goodsTaxable > 0 ? [{ account_code: pRev, credit: goodsTaxable }] : []),      // Cr Sales Revenue (goods)
          ...(serviceTaxable > 0 ? [{ account_code: pSvcRev, credit: serviceTaxable }] : []), // Cr Service Revenue
          ...(serviceCharge > 0 ? [{ account_code: pSvc, credit: serviceCharge }] : []),
          { account_code: '2100', credit: vat },     // Cr Tax Payable
          ...(roundingAdj > 0 ? [{ account_code: pRnd, credit: roundingAdj }] : []),
        ],
      });
    }

    // wiring (best-effort, never poison the sale): append the hash-chained electronic journal, then
    // recompute auto-86 in case this sale depleted a recipe ingredient.
    const ju = { ...user, tenantId: t.id };
    if (this.journal) { try { await this.journal.append({ doc_type: 'SALE', doc_no: saleNo, payload: { subtotal, discount, vat, total, lines: lines.length, payment_method: dto.payment_method ?? 'Cash' } }, ju); } catch { /* journal best-effort */ } }
    if (this.locking) { try { await this.locking.recomputeAvailability(); } catch { /* auto-86 best-effort */ } }
    // 1.5 — meter one billable POS transaction per completed sale (idempotent per sale_no; best-effort).
    await this.usage?.record(t.id, 'pos_txns', saleNo);

    // Phase 6a: a split sale returns every leg (payment_no/method/amount/change) + the total change handed
    // back; a single-tender sale keeps the flat `payment_no` (back-compat) and `tenders: null`.
    const tenders = splitTenderResults
      ? splitTenderResults.map((r) => ({ payment_no: r.payment_no, method: r.method ?? null, amount: n(r.amount), status: r.status, change_due: r.change_due ?? null }))
      : null;
    const changeDue = splitTenderResults ? roundCurrency(splitTenderResults.reduce((a, r) => a + n(r.change_due), 0), 'THB') : (tender?.change_due ?? null);
    return { sale_no: saleNo, branch_id: branchId, subtotal, discount, pricing_discount: pricingDiscount, service_charge: serviceCharge, rounding_adjustment: roundingAdj, vat, total, points_earned: pointsEarned, lines: lines.length, payment_no: tender?.payment_no ?? null, tenders, change_due: changeDue, journal_no: je?.entry_no ?? null };
  }

  // GET /api/portal/pos/sales — history (this tenant)
  async listSales(user: JwtUser, limit: number, offset: number) {
    const t = await this.portal.tenantId(user);
    const db = this.db;
    const rows = await db.select({
      sale_no: custPosSales.saleNo, sale_date: custPosSales.saleDate, subtotal: custPosSales.subtotal,
      discount: custPosSales.discount, tax_amount: custPosSales.taxAmount, total: custPosSales.total,
      payment_method: custPosSales.paymentMethod, points_earned: custPosSales.pointsEarned,
      status: custPosSales.status, cashier: custPosSales.createdBy,
    }).from(custPosSales)
      .where(and(eq(custPosSales.tenantId, t.id), ne(custPosSales.status, 'Voided')))
      .orderBy(desc(custPosSales.saleNo)).limit(limit).offset(offset);
    return {
      sales: rows.map((r: any) => ({
        ...r, subtotal: n(r.subtotal), discount: n(r.discount), tax_amount: n(r.tax_amount),
        total: n(r.total), points_earned: n(r.points_earned),
      })),
      count: rows.length,
    };
  }
}
