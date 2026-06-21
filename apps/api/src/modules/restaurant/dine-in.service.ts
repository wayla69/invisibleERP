import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, inArray, desc, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  dineInOrders, dineInOrderItems, kitchenStations, diningTables, tableSessions,
  custPosSales, custPosItems, tenants,
} from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { TaxService } from '../tax/tax.service';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { TaxInvoiceService } from '../tax-docs/tax-invoice.service';
import { MenuService } from '../menu/menu.service';
import { RecipeService } from '../menu/recipe.service';
import { MemberService } from '../loyalty/member.service';
import { PromoEngineService } from '../marketing/promo-engine.service';
import { promotions, promoRedemptions } from '../../database/schema';
import { roundCurrency } from '../tax/money';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { CreateOrderDto, AddItemsDto, CheckoutDto } from './dto';

const ACTIVE_ITEM = ['new', 'queued', 'preparing', 'ready', 'served'];

@Injectable()
export class DineInService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly tax: TaxService,
    private readonly payments: PaymentService,
    private readonly ledger: LedgerService,
    private readonly taxInvoice: TaxInvoiceService,
    private readonly menu: MenuService,
    private readonly promo: PromoEngineService,
    private readonly recipe: RecipeService,
    private readonly member: MemberService,
  ) {}

  private async resolveStation(tenantId: number | null, code?: string) {
    const db = this.db as any;
    const c = code || 'main';
    const [st] = await db.select().from(kitchenStations).where(eq(kitchenStations.code, c)).limit(1);
    if (st) return st;
    const [created] = await db.insert(kitchenStations).values({ tenantId, code: c, name: code ? code : 'ครัว', defaultPrepMinutes: 10 }).returning();
    return created;
  }

  private liveTotals(items: { amount: number }[]) {
    const subtotal = roundCurrency(items.reduce((a, l) => a + l.amount, 0), 'THB');
    const t = this.tax.calcTax({ net: subtotal, country: 'TH' });
    return { subtotal, vat: t.tax, total: roundCurrency(subtotal + t.tax, 'THB') };
  }

  private async insertItems(orderId: number, tenantId: number | null, items: AddItemsDto['items'], user: JwtUser) {
    const db = this.db as any;
    const rows = [] as any[];
    for (const it of items) {
      // menu-driven line → resolve name/price/station/modifiers from the catalog (enforces 86 + modifier rules);
      // freeform line → use the provided name/unit_price as before.
      let name = it.name, unitPrice = it.unit_price, stationCode = it.station_code;
      let prep = it.est_prep_minutes, mods: any = it.modifiers ?? null, itemRef = it.item_id ?? null;
      if (it.sku != null || it.menu_item_id != null) {
        const r = await this.menu.resolveLine({ sku: it.sku, item_id: it.menu_item_id, qty: n(it.qty), modifier_option_ids: it.modifier_option_ids, notes: it.notes }, user);
        name = r.name; unitPrice = r.unit_price; stationCode = it.station_code ?? r.station_code ?? undefined;
        prep = it.est_prep_minutes ?? r.prep_minutes ?? undefined; mods = r.modifiers; itemRef = r.sku;
      }
      const st = await this.resolveStation(tenantId, stationCode);
      const amount = roundCurrency(n(it.qty) * n(unitPrice), 'THB');
      rows.push({
        tenantId, orderId, stationId: Number(st.id), itemId: itemRef, name,
        qty: String(n(it.qty)), unitPrice: fx(n(unitPrice), 2), amount: fx(amount, 2),
        modifiers: mods, notes: it.notes ?? null, kdsStatus: 'new',
        estPrepMinutes: prep ?? null, createdBy: user.username,
      });
    }
    if (rows.length) await db.insert(dineInOrderItems).values(rows);
  }

  private async refreshTotals(orderId: number) {
    const db = this.db as any;
    const items = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.orderId, orderId), ne(dineInOrderItems.kdsStatus, 'voided')));
    const t = this.liveTotals(items.map((i: any) => ({ amount: n(i.amount) })));
    await db.update(dineInOrders).set({ subtotal: fx(t.subtotal, 2), vat: fx(t.vat, 2), total: fx(t.total, 2) }).where(eq(dineInOrders.id, orderId));
    return t;
  }

  async createOrder(dto: CreateOrderDto, user: JwtUser) {
    const db = this.db as any;
    const orderNo = await this.docNo.nextDaily('DIN');
    const [h] = await db.insert(dineInOrders).values({
      orderNo, tenantId: user.tenantId, tableId: dto.table_id ?? null, sessionId: dto.session_id ?? null,
      status: 'open', guestCount: dto.guest_count ?? 1, server: user.username, notes: dto.notes ?? null, createdBy: user.username,
    }).returning({ id: dineInOrders.id });
    await this.insertItems(Number(h.id), user.tenantId, dto.items, user);
    await this.refreshTotals(Number(h.id));
    // opening an order occupies the table
    if (dto.table_id) await db.update(diningTables).set({ status: 'occupied', updatedAt: new Date() }).where(and(eq(diningTables.id, dto.table_id), inArray(diningTables.status, ['available', 'reserved'] as any)));
    return this.getOrder(orderNo, user);
  }

  async addItems(orderNo: string, dto: AddItemsDto, user: JwtUser) {
    const db = this.db as any;
    const o = await this.loadOrder(orderNo);
    if (['paid', 'closed', 'cancelled'].includes(String(o.status))) throw new BadRequestException({ code: 'ORDER_CLOSED', message: 'Order is closed', messageTh: 'ออเดอร์ปิดแล้ว' });
    await this.insertItems(Number(o.id), o.tenantId, dto.items, user);
    await this.refreshTotals(Number(o.id));
    return this.getOrder(orderNo, user);
  }

  // ส่งครัว: new → queued, set firedAt
  async fire(orderNo: string, user: JwtUser) {
    const db = this.db as any;
    const o = await this.loadOrder(orderNo);
    const now = new Date();
    await db.update(dineInOrderItems).set({ kdsStatus: 'queued', firedAt: now, updatedAt: now }).where(and(eq(dineInOrderItems.orderId, Number(o.id)), eq(dineInOrderItems.kdsStatus, 'new')));
    if (!o.firedAt) await db.update(dineInOrders).set({ firedAt: now }).where(eq(dineInOrders.id, o.id));
    await this.recomputeOrderStatus(Number(o.id));
    return this.getOrder(orderNo, user);
  }

  // KDS item transition (start/ready/recall/serve/void)
  async itemTransition(itemId: number, action: string, reason: string | undefined, user: JwtUser) {
    const db = this.db as any;
    const [item] = await db.select().from(dineInOrderItems).where(eq(dineInOrderItems.id, itemId)).limit(1);
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Item not found', messageTh: 'ไม่พบรายการ' });
    const now = new Date();
    const cur = String(item.kdsStatus);
    const set: any = { updatedAt: now };
    const bad = () => { throw new BadRequestException({ code: 'BAD_TRANSITION', message: `Cannot ${action} from ${cur}`, messageTh: 'เปลี่ยนสถานะไม่ถูกต้อง' }); };
    if (action === 'start') { if (cur !== 'queued') bad(); set.kdsStatus = 'preparing'; set.startedAt = now; }
    else if (action === 'ready') { if (cur !== 'preparing') bad(); set.kdsStatus = 'ready'; set.readyAt = now; }
    else if (action === 'recall') { if (!['preparing', 'ready'].includes(cur)) bad(); set.kdsStatus = 'queued'; set.startedAt = null; set.readyAt = null; }
    else if (action === 'serve') { if (cur !== 'ready') bad(); set.kdsStatus = 'served'; set.servedAt = now; }
    else if (action === 'void') { if (['served', 'voided'].includes(cur)) bad(); set.kdsStatus = 'voided'; set.voidedAt = now; set.voidReason = reason ?? null; }
    else bad();
    await db.update(dineInOrderItems).set(set).where(eq(dineInOrderItems.id, itemId));
    await this.refreshTotals(Number(item.orderId));
    const status = await this.recomputeOrderStatus(Number(item.orderId));
    return { item_id: itemId, kds_status: set.kdsStatus, order_status: status };
  }

  // system-derived order status from aggregate item state (never downgrades terminal states)
  async recomputeOrderStatus(orderId: number) {
    const db = this.db as any;
    const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.id, orderId)).limit(1);
    if (!o) return null;
    if (['bill_requested', 'partially_paid', 'paid', 'closed', 'cancelled'].includes(String(o.status))) return o.status;
    const items = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.orderId, orderId), ne(dineInOrderItems.kdsStatus, 'voided')));
    let next = o.status;
    if (items.length) {
      const st = items.map((i: any) => String(i.kdsStatus));
      if (st.every((s: string) => s === 'served')) next = 'served';
      else if (st.some((s: string) => s === 'ready')) next = 'partially_ready';
      else if (st.some((s: string) => ['queued', 'preparing'].includes(s))) next = 'sent_to_kitchen';
      else next = 'open';
    }
    if (next !== o.status) await db.update(dineInOrders).set({ status: next }).where(eq(dineInOrders.id, orderId));
    return next;
  }

  async requestBill(orderNo: string, user: JwtUser) {
    const db = this.db as any;
    const o = await this.loadOrder(orderNo);
    if (['paid', 'closed', 'cancelled'].includes(String(o.status))) throw new BadRequestException({ code: 'ORDER_CLOSED', message: 'Order closed', messageTh: 'ออเดอร์ปิดแล้ว' });
    const t = await this.refreshTotals(Number(o.id));
    await db.update(dineInOrders).set({ status: 'bill_requested', billRequestedAt: new Date() }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'bill_requested', updatedAt: new Date() }).where(eq(diningTables.id, o.tableId));
    if (o.sessionId) await db.update(tableSessions).set({ status: 'bill_requested' }).where(eq(tableSessions.id, o.sessionId));
    return { order_no: orderNo, status: 'bill_requested', total: t.total };
  }

  // staff cash checkout → convert to cust_pos_sales (tender Captured) + GL + abbreviated invoice
  async checkout(orderNo: string, dto: CheckoutDto, user: JwtUser) {
    const o = await this.loadOrderForUpdate(orderNo); // lock + re-check inside the request tx → no double-settle
    if (['paid', 'closed', 'cancelled', 'partially_paid'].includes(String(o.status))) throw new BadRequestException({ code: 'ALREADY_PAID', message: 'Order already settled', messageTh: 'ออเดอร์ชำระแล้ว' });
    // loyalty: validate the redeem quote BEFORE building the sale (throws on disabled / not-found / cross-tenant /
    // insufficient balance) so an over-redeem is rejected and no sale row is created.
    let pointsRedeem: { memberId: number; points: number; bahtPerPoint: number; redeemValue: number } | undefined;
    if (dto.member_id && (dto.redeem_points ?? 0) > 0) {
      const q = await this.member.quoteRedeem(dto.member_id, dto.redeem_points!, user);
      pointsRedeem = { memberId: dto.member_id, points: dto.redeem_points!, bahtPerPoint: q.bahtPerPoint, redeemValue: q.redeemValue };
    }
    const saleNo = await this.mintSaleNo(o.tenantId);
    const built = await this.buildSale(o, saleNo, dto.discount ?? 0, user, { orderDiscountPct: dto.discount_pct, promoCode: dto.promo_code, lineDiscounts: dto.line_discounts, memberId: dto.member_id, pointsRedeem });
    // tender (cash → mock gateway = Captured); link to the open till so cash ties to the drawer (Z-report).
    // A fully points-redeemed bill (total 0) needs no tender — skip it (recordTender rejects non-positive amounts).
    const openTill = o.tenantId != null ? await this.payments.currentOpenTill(o.tenantId) : null;
    const tender: any = built.total > 0
      ? await this.payments.recordTender({ sale_no: saleNo, tenant_id: o.tenantId ?? undefined, method: dto.method ?? 'Cash', amount: built.total, currency: 'THB', gateway: 'mock', till_session_id: openTill?.id }, user)
      : null;
    const inv = await this.markPaidAndInvoice(o, saleNo, user);
    return { order_no: orderNo, sale_no: saleNo, ...built, payment_no: tender?.payment_no ?? null, payment_status: tender?.status ?? null, tax_invoice_no: inv };
  }

  // shared: insert cust_pos_sales + items + GL from a dine-in order, applying line/order/promo discounts.
  // VAT is on the discounted base (Thai rule). opts is optional → no-discount path matches the old behavior.
  async buildSale(o: any, saleNo: string, discount: number, user: JwtUser, opts?: { orderDiscountPct?: number; promoCode?: string; lineDiscounts?: Record<string, { discount_pct?: number; discount_amt?: number }>; maxDiscountPct?: number; memberId?: number; pointsRedeem?: { memberId: number; points: number; bahtPerPoint: number; redeemValue: number } }) {
    const db = this.db as any;
    const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
    const items = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.orderId, Number(o.id)), ne(dineInOrderItems.kdsStatus, 'voided')));
    const lineDiscounts = opts?.lineDiscounts ?? {};
    const maxPct = opts?.maxDiscountPct ?? 50;
    let subtotalNet = 0, grossSum = 0, lineDiscTotal = 0;
    const itemRows: any[] = [];
    for (const l of items) {
      const grossLine = roundCurrency(n(l.qty) * n(l.unitPrice), 'THB');
      const ld = lineDiscounts[String(l.id)] ?? lineDiscounts[Number(l.id) as any];
      let lineDisc = ld ? (ld.discount_amt != null ? roundCurrency(ld.discount_amt, 'THB') : roundCurrency(grossLine * n(ld.discount_pct) / 100, 'THB')) : 0;
      lineDisc = Math.min(lineDisc, grossLine);
      const netLine = roundCurrency(grossLine - lineDisc, 'THB');
      grossSum = roundCurrency(grossSum + grossLine, 'THB'); subtotalNet = roundCurrency(subtotalNet + netLine, 'THB'); lineDiscTotal = roundCurrency(lineDiscTotal + lineDisc, 'THB');
      itemRows.push({ itemId: l.itemId ?? l.name, itemDescription: l.name, qty: String(n(l.qty)), uom: 'จาน', unitPrice: fx(n(l.unitPrice), 2), discountPct: fx(grossLine > 0 ? r2(lineDisc / grossLine * 100) : 0, 2), amount: fx(netLine, 2), isCustom: false });
    }
    // order-level discount: explicit fixed amount, else percent
    if (discount > subtotalNet + 0.01) throw new BadRequestException({ code: 'DISCOUNT_EXCEEDS_SUBTOTAL', message: `Discount ${discount} exceeds subtotal ${subtotalNet}`, messageTh: `ส่วนลด (${discount}) เกินยอดรวม (${subtotalNet})` });
    let orderDisc = discount > 0 ? roundCurrency(discount, 'THB') : (opts?.orderDiscountPct ? roundCurrency(subtotalNet * opts.orderDiscountPct / 100, 'THB') : 0);
    let pe: any = null;
    if (opts?.promoCode) {
      pe = await this.promo.applyPromo({ code: opts.promoCode, subtotalNet, itemIds: items.map((i: any) => String(i.itemId ?? i.name)), tenantId: o.tenantId ?? null });
      orderDisc = Math.max(orderDisc, pe.discount); // promo takes over as the order discount
    }
    orderDisc = roundCurrency(Math.min(orderDisc, subtotalNet), 'THB');
    const effTotalPct = grossSum > 0 ? (lineDiscTotal + orderDisc) / grossSum * 100 : 0;
    if (effTotalPct > maxPct + 0.001) throw new BadRequestException({ code: 'DISCOUNT_OVER_LIMIT', message: `Total discount ${r2(effTotalPct)}% exceeds limit ${maxPct}%`, messageTh: 'ส่วนลดเกินเพดานที่อนุญาต' });

    // loyalty points redemption — applied AFTER line+order discount, clamped to the remaining bill, and
    // EXEMPT from the markdown cap (a member spending their own points is a settlement, not a markdown).
    // VAT is charged on the post-redemption base (Thai-correct). actualRedeemPoints back-computes what the
    // bill could actually absorb so we never consume more points than the discount realized.
    let pointsDisc = 0, actualRedeemPoints = 0;
    if (opts?.pointsRedeem && opts.pointsRedeem.redeemValue > 0) {
      pointsDisc = roundCurrency(Math.min(opts.pointsRedeem.redeemValue, subtotalNet - orderDisc), 'THB');
      actualRedeemPoints = opts.pointsRedeem.bahtPerPoint > 0 ? Math.round(pointsDisc / opts.pointsRedeem.bahtPerPoint) : 0;
    }
    const taxable = Math.max(0, roundCurrency(subtotalNet - orderDisc - pointsDisc, 'THB'));
    const vat = this.tax.calcTax({ net: taxable, country: 'TH' }).tax;
    const total = roundCurrency(taxable + vat, 'THB');
    const [h] = await db.insert(custPosSales).values({
      saleNo, saleDate: ymd(), tenantId: o.tenantId, subtotal: fx(subtotalNet, 2), discount: fx(roundCurrency(orderDisc + pointsDisc, 'THB'), 2),
      taxAmount: fx(vat, 2), total: fx(total, 2), paymentMethod: 'Dine-in', pointsUsed: String(actualRedeemPoints), pointsEarned: '0',
      status: 'Completed', notes: `Dine-in ${o.orderNo}`, createdBy: user.username,
    }).returning({ id: custPosSales.id });
    await db.insert(custPosItems).values(itemRows.map((r) => ({ saleId: Number(h.id), ...r })));
    // recipe/BOM: deduct ingredients per sold menu line (allows negative, logs Consume); accumulate COGS if post_cogs
    let recipeCogs = 0;
    for (const l of items) { const ded = await this.recipe.applyDeduction(db, o.tenantId, String(l.itemId ?? ''), n(l.qty), saleNo, user); recipeCogs = roundCurrency(recipeCogs + ded.cost, 'THB'); }
    let journalNo: string | null = null;
    if (total > 0) {
      const je: any = await this.ledger.postEntry({
        source: 'POS', sourceRef: saleNo, tenantId: o.tenantId, memo: `Dine-in ${o.orderNo}`, createdBy: user.username,
        lines: [{ account_code: '1000', debit: total }, { account_code: '4000', credit: taxable }, { account_code: '2100', credit: vat }],
      });
      journalNo = je?.entry_no ?? null;
      if (pe?.ok && pe.promoRowId) {
        // atomic cap: increment only while under max_uses (prevents read-then-increment over-redemption race)
        const upd = await db.update(promotions).set({ usedCount: sql`${promotions.usedCount} + 1` })
          .where(and(eq(promotions.id, pe.promoRowId), sql`(${promotions.maxUses} IS NULL OR ${promotions.usedCount} < ${promotions.maxUses})`))
          .returning({ id: promotions.id });
        if (!upd.length) throw new BadRequestException({ code: 'PROMO_EXHAUSTED', message: 'Promo usage limit reached', messageTh: 'โปรโมชันถูกใช้ครบจำนวนแล้ว' });
        await db.insert(promoRedemptions).values({ tenantId: o.tenantId ?? null, promoId: pe.promoRowId, promoCode: pe.promoCode, saleNo, orderNo: o.orderNo, discountAmount: fx(pe.discount, 2), appliedBy: user.username });
      }
    }
    // recipe COGS (gated by per-recipe post_cogs): Dr 5300 Recipe COGS / Cr 1200 Inventory
    if (recipeCogs > 0 && !(await this.ledger.alreadyPosted('POS-COGS', saleNo))) {
      await this.ledger.postEntry({ source: 'POS-COGS', sourceRef: saleNo, tenantId: o.tenantId, memo: `COGS ${saleNo}`, createdBy: user.username, lines: [{ account_code: '5300', debit: recipeCogs }, { account_code: '1200', credit: recipeCogs }] });
    }
    // loyalty member: earn on the net spend + redeem the actually-consumed points — both inside the request
    // tx so a rollback un-does the points sub-ledger too. Revenue-reduction model → no GL footprint here.
    let pointsEarned = 0;
    if (opts?.memberId) {
      pointsEarned = await this.member.earnInTx(db, o.tenantId, opts.memberId, taxable, saleNo, user.username);
      if (pointsEarned > 0) await db.update(custPosSales).set({ pointsEarned: String(pointsEarned) }).where(eq(custPosSales.id, h.id));
      if (actualRedeemPoints > 0) await this.member.redeemInTx(db, o.tenantId, opts.memberId, actualRedeemPoints, pointsDisc, saleNo, user.username);
    }
    return { subtotal: subtotalNet, discount: roundCurrency(orderDisc + pointsDisc, 'THB'), vat, total, journal_no: journalNo, promo_code: pe?.promoCode ?? null, line_discount_total: lineDiscTotal, points_used: actualRedeemPoints, points_earned: pointsEarned };
  }

  // mark order paid + close table/session + idempotent abbreviated tax invoice
  async markPaidAndInvoice(o: any, saleNo: string, user: JwtUser) {
    const db = this.db as any;
    const now = new Date();
    await db.update(dineInOrders).set({ status: 'paid', saleNo, paidAt: now, closedAt: now }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'cleaning', updatedAt: now }).where(eq(diningTables.id, o.tableId));
    if (o.sessionId) await db.update(tableSessions).set({ status: 'closed', closedAt: now, saleNo }).where(eq(tableSessions.id, o.sessionId));
    return this.issueAbbreviated(saleNo, user);
  }

  // idempotent abbreviated tax invoice for a sale (VAT-unregistered tenant → null, no slip).
  async issueAbbreviated(saleNo: string, user: JwtUser): Promise<string | null> {
    try { const inv: any = await this.taxInvoice.issueAbbreviatedFromSale(saleNo, user); return inv?.doc_no ?? null; } catch { return null; }
  }

  // SALE- number, collision-safe: nextTenantStamped is second-precision, so rapid/split sales in the
  // same second would clash on cust_pos_sales.sale_no (UNIQUE). Retry on a bumped second until unique.
  async mintSaleNo(tenantId: number | null) {
    const db = this.db as any;
    let code = 'POS';
    if (tenantId != null) { const [t] = await db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, tenantId)).limit(1); code = t?.code ?? 'POS'; }
    for (let attempt = 0; attempt < 12; attempt++) {
      const saleNo = this.docNo.nextTenantStamped('SALE', code, new Date(Date.now() + attempt * 1000));
      const [exists] = await db.select({ id: custPosSales.id }).from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
      if (!exists) return saleNo;
    }
    return this.docNo.nextTenantStamped('SALE', code) + '-' + Math.floor(Date.now() % 997);
  }

  // split bill: build a cust_pos_sales + items + ONE GL entry from a subset / pro-rated slice of an order.
  // grossOverride present (equal split) → the share is VAT-inclusive, back out net+vat; else compute from lines.
  async buildCheckSale(o: any, saleNo: string, lines: any[], opts: { grossOverride?: number; discount?: number }, user: JwtUser) {
    const db = this.db as any;
    const disc = roundCurrency(opts.discount ?? 0, 'THB');
    let subtotal: number, vat: number, total: number;
    if (opts.grossOverride != null) {
      total = roundCurrency(opts.grossOverride, 'THB');
      const inc = this.tax.calcInclusive({ gross: total, country: 'TH' });
      subtotal = inc.net; vat = inc.tax;
    } else {
      const gross = roundCurrency(lines.reduce((a, l) => a + n(l.amount), 0), 'THB');
      subtotal = Math.max(0, roundCurrency(gross - disc, 'THB'));
      const t = this.tax.calcTax({ net: subtotal, country: 'TH' });
      vat = t.tax; total = roundCurrency(subtotal + vat, 'THB');
    }
    const [h] = await db.insert(custPosSales).values({
      saleNo, saleDate: ymd(), tenantId: o.tenantId, subtotal: fx(subtotal, 2), discount: fx(disc, 2),
      taxAmount: fx(vat, 2), total: fx(total, 2), paymentMethod: 'Split', pointsUsed: '0', pointsEarned: '0',
      status: 'Completed', notes: `Split ${o.orderNo}`, createdBy: user.username,
    }).returning({ id: custPosSales.id });
    const itemRows = lines.length ? lines : [{ itemId: 'SPLIT', name: `แบ่งบิล ${o.orderNo}`, qty: 1, unitPrice: subtotal, amount: subtotal }];
    await db.insert(custPosItems).values(itemRows.map((l: any) => ({
      saleId: Number(h.id), itemId: l.itemId ?? l.name, itemDescription: l.name, qty: String(n(l.qty ?? 1)), uom: 'จาน',
      unitPrice: fx(n(l.unitPrice ?? l.amount), 2), discountPct: '0', amount: fx(n(l.amount), 2), isCustom: l.itemId == null,
    })));
    let journalNo: string | null = null;
    if (total > 0) {
      const je: any = await this.ledger.postEntry({
        source: 'POS', sourceRef: saleNo, tenantId: o.tenantId, memo: `Split ${o.orderNo}`, createdBy: user.username,
        lines: [{ account_code: '1000', debit: total }, { account_code: '4000', credit: subtotal }, { account_code: '2100', credit: vat }],
      });
      journalNo = je?.entry_no ?? null;
    }
    return { sale_no: saleNo, subtotal, discount: disc, vat, total, journal_no: journalNo };
  }

  // split: per-check invoices already issued — flip the order/table/session to paid/closed (no new sale).
  async markAllChecksPaid(o: any, _user: JwtUser) {
    const db = this.db as any;
    const now = new Date();
    await db.update(dineInOrders).set({ status: 'paid', paidAt: now, closedAt: now }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'cleaning', updatedAt: now }).where(eq(diningTables.id, o.tableId));
    if (o.sessionId) await db.update(tableSessions).set({ status: 'closed', closedAt: now }).where(eq(tableSessions.id, o.sessionId));
  }

  async closeTable(orderNo: string, user: JwtUser) {
    const db = this.db as any;
    const o = await this.loadOrder(orderNo);
    await db.update(dineInOrders).set({ status: 'closed', closedAt: new Date() }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'available', updatedAt: new Date() }).where(eq(diningTables.id, o.tableId));
    return { order_no: orderNo, status: 'closed' };
  }

  async cancelOrder(orderNo: string, reason: string | undefined, user: JwtUser) {
    const db = this.db as any;
    const o = await this.loadOrder(orderNo);
    if (!['open', 'sent_to_kitchen'].includes(String(o.status))) throw new BadRequestException({ code: 'CANNOT_CANCEL', message: 'Cannot cancel after serving/payment', messageTh: 'ยกเลิกไม่ได้หลังเสิร์ฟ/ชำระ' });
    await db.update(dineInOrders).set({ status: 'cancelled', closedAt: new Date(), notes: reason ?? o.notes }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'available', updatedAt: new Date() }).where(eq(diningTables.id, o.tableId));
    return { order_no: orderNo, status: 'cancelled' };
  }

  async loadOrder(orderNo: string) {
    const db = this.db as any;
    const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).limit(1);
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    return o;
  }

  // FOR UPDATE — used by settle paths so a concurrent double-submit serializes + re-checks status (no double-book).
  async loadOrderForUpdate(orderNo: string) {
    const db = this.db as any;
    const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).for('update').limit(1);
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    return o;
  }

  async getOrder(orderNo: string, _user: JwtUser) {
    const o = await this.loadOrder(orderNo);
    return this.viewOrder(o);
  }

  async listOpenOrders(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(dineInOrders).where(ne(dineInOrders.status, 'closed')).orderBy(desc(dineInOrders.id)).limit(100);
    return { orders: rows.filter((o: any) => o.status !== 'cancelled').map((o: any) => ({ order_no: o.orderNo, table_id: o.tableId, status: o.status, total: n(o.total), waited_min: o.firedAt ? Math.floor((Date.now() - new Date(o.firedAt).getTime()) / 60000) : 0 })) };
  }

  // order summary for the diner page (by session)
  async publicSummary(sessionId: number) {
    const db = this.db as any;
    const [o] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, sessionId), ne(dineInOrders.status, 'cancelled'))).orderBy(desc(dineInOrders.id)).limit(1);
    if (!o) return null;
    return this.viewOrder(o);
  }

  private async viewOrder(o: any) {
    const db = this.db as any;
    const items = await db.select({
      id: dineInOrderItems.id, name: dineInOrderItems.name, qty: dineInOrderItems.qty, unitPrice: dineInOrderItems.unitPrice,
      amount: dineInOrderItems.amount, kdsStatus: dineInOrderItems.kdsStatus, stationId: dineInOrderItems.stationId,
      modifiers: dineInOrderItems.modifiers, notes: dineInOrderItems.notes, firedAt: dineInOrderItems.firedAt,
      startedAt: dineInOrderItems.startedAt, readyAt: dineInOrderItems.readyAt, estPrep: dineInOrderItems.estPrepMinutes,
    }).from(dineInOrderItems).where(eq(dineInOrderItems.orderId, Number(o.id))).orderBy(dineInOrderItems.id);
    const now = Date.now();
    const statusTh: Record<string, string> = { new: 'รับออเดอร์', queued: 'รอคิว', preparing: 'กำลังปรุง', ready: 'พร้อมเสิร์ฟ', served: 'เสิร์ฟแล้ว', voided: 'ยกเลิก' };
    const viewItems = items.map((i: any) => {
      const fired = i.firedAt ? new Date(i.firedAt).getTime() : null;
      const prep = i.estPrep ?? 10;
      const elapsedMin = fired && !['served', 'voided'].includes(i.kdsStatus) ? Math.floor((now - fired) / 60000) : (i.readyAt && fired ? Math.floor((new Date(i.readyAt).getTime() - fired) / 60000) : 0);
      const base = i.startedAt ? Math.floor((now - new Date(i.startedAt).getTime()) / 60000) : elapsedMin;
      const remainingMin = ['ready', 'served', 'voided'].includes(i.kdsStatus) ? 0 : Math.max(0, prep - base);
      return { item_id: Number(i.id), name: i.name, qty: n(i.qty), unit_price: n(i.unitPrice), amount: n(i.amount), kds_status: i.kdsStatus, status_th: statusTh[i.kdsStatus], modifiers: i.modifiers ?? [], notes: i.notes, elapsed_min: elapsedMin, remaining_min: remainingMin, prep_min: prep };
    });
    const waitedMin = o.firedAt ? Math.floor((now - new Date(o.firedAt).getTime()) / 60000) : 0;
    const readyInMin = Math.max(0, ...viewItems.filter((v: any) => !['served', 'voided'].includes(v.kds_status)).map((v: any) => v.remaining_min), 0);
    return {
      order_no: o.orderNo, table_id: o.tableId, session_id: o.sessionId, status: o.status, guest_count: o.guestCount,
      subtotal: n(o.subtotal), vat: n(o.vat), total: n(o.total), sale_no: o.saleNo,
      waited_min: waitedMin, ready_in_min: readyInMin, items: viewItems,
    };
  }
}
