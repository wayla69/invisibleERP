import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { RealtimeService } from '../pos/scale/realtime.service';
import { eq, and, inArray, desc, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  dineInOrders, dineInOrderItems, kitchenStations, diningTables, tableSessions,
  custPosSales, custPosItems, tenants, qrSettings,
} from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { TaxService } from '../tax/tax.service';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { TaxInvoiceService } from '../tax/documents/tax-invoice.service';
import { MenuService } from '../menu/menu.service';
import { RecipeService } from '../menu/recipe.service';
import { MemberService } from '../loyalty/member.service';
import { JournalService } from '../pos/fiscal/journal.service';
import { GiftCardService } from '../giftcards/gift-card.service';
import { PromoEngineService } from '../marketing/promo-engine.service';
import { VouchersService } from '../campaigns/vouchers.service';
import { PricingService } from '../pricing/pricing.service';
import { roundCurrency } from '../tax/money';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { CreateOrderDto, AddItemsDto, CheckoutDto } from './dto';
import { DineInTablesService } from './dine-in-tables.service';
import { DineInSaleService } from './dine-in-sale.service';

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
    private readonly vouchers: VouchersService,
    private readonly recipe: RecipeService,
    private readonly member: MemberService,
    private readonly gift: GiftCardService,
    private readonly pricing: PricingService,
    @Optional() private readonly realtime?: RealtimeService,   // multi-terminal SSE fan-out (best-effort)
    // Electronic fiscal journal (RD tamper-evidence). @Optional so partial harnesses still construct;
    // the append is best-effort for the same reason the payments path treats it that way.
    @Optional() private readonly fiscal?: JournalService,
  ) {
    // Ctor-body plain class (god-service ratchet pattern) — floor operations (transfer/merge/fire/seat).
    this.tables = new DineInTablesService(db, {
      loadOrder: (no) => this.loadOrder(no),
      ensureOpenOrder: (t, u) => this.ensureOpenOrder(t, u),
      liveSessionForTable: (t) => this.liveSessionForTable(t),
      refreshTotals: (id) => this.refreshTotals(id),
      recomputeOrderStatus: (id) => this.recomputeOrderStatus(id),
      getOrder: (no, u) => this.getOrder(no, u),
    });
    // Ctor-body plain class (service-size headroom round) — sale construction (checkout + split-bill GL).
    this.sale = new DineInSaleService(db, tax, ledger, promo, vouchers, recipe, member, gift, pricing);
  }
  private readonly tables: DineInTablesService;
  private readonly sale: DineInSaleService;

  private async resolveStation(tenantId: number | null, code?: string) {
    const db = this.db;
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

  private async insertItems(orderId: number, tenantId: number | null, items: AddItemsDto['items'], user: JwtUser, opts?: { buffet?: boolean; buffetPackageId?: number }) {
    const db = this.db;
    const buffet = !!opts?.buffet;
    const rows: (typeof dineInOrderItems.$inferInsert)[] = [];
    for (const it of items) {
      // menu-driven line → resolve name/price/station/modifiers from the catalog (enforces 86 + modifier rules);
      // freeform line → use the provided name/unit_price as before.
      let name = it.name, unitPrice = it.unit_price, stationCode = it.station_code;
      let prep = it.est_prep_minutes, mods: any = it.modifiers ?? null, itemRef = it.item_id ?? null;
      let kdsPriority = 0;   // food-prioritisation — snapshot the menu item's priority onto the kitchen line
      if (it.sku != null || it.menu_item_id != null) {
        const r = await this.menu.resolveLine({ sku: it.sku, item_id: it.menu_item_id, qty: n(it.qty), modifier_option_ids: it.modifier_option_ids, notes: it.notes }, user);
        name = r.name; unitPrice = r.unit_price; stationCode = it.station_code ?? r.station_code ?? undefined;
        prep = it.est_prep_minutes ?? r.prep_minutes ?? undefined; mods = r.modifiers; itemRef = r.sku; kdsPriority = r.kds_priority ?? 0;
      }
      // buffet food still routes to the kitchen (station + prep), but is billed at ฿0 — the per-pax buffet
      // charge covers it. The 86/modifier rules above still apply.
      const effUnit = buffet ? 0 : n(unitPrice);
      const st = await this.resolveStation(tenantId, stationCode);
      const amount = roundCurrency(n(it.qty) * effUnit, 'THB');
      rows.push({
        tenantId, orderId, stationId: Number(st!.id), itemId: itemRef, name: name!,
        qty: String(n(it.qty)), unitPrice: fx(effUnit, 2), amount: fx(amount, 2),
        modifiers: mods, notes: it.notes ?? null, kdsStatus: 'new', isBuffet: buffet,
        buffetPackageId: buffet ? (opts?.buffetPackageId ?? null) : null, course: (it as { course?: number }).course ?? 1, kdsPriority,
        seat: it.seat ?? null,   // seat-level ordering (POS-9)
        estPrepMinutes: prep ?? null, createdBy: user.username,
      });
    }
    if (rows.length) await db.insert(dineInOrderItems).values(rows);
  }

  // public wrapper so the buffet service can recompute totals after inserting charge / overtime lines
  async refreshOrderTotals(orderId: number) { return this.refreshTotals(orderId); }

  private async refreshTotals(orderId: number) {
    const db = this.db;
    const items = await db.select().from(dineInOrderItems).where(and(eq(dineInOrderItems.orderId, orderId), ne(dineInOrderItems.kdsStatus, 'voided')));
    const t = this.liveTotals(items.map((i: any) => ({ amount: n(i.amount) })));
    await db.update(dineInOrders).set({ subtotal: fx(t.subtotal, 2), vat: fx(t.vat, 2), total: fx(t.total, 2) }).where(eq(dineInOrders.id, orderId));
    return t;
  }

  async createOrder(dto: CreateOrderDto, user: JwtUser, opts?: { buffet?: boolean; buffetPackageId?: number }) {
    const db = this.db;
    const orderNo = await this.docNo.nextDaily('DIN');
    const [h] = await db.insert(dineInOrders).values({
      orderNo, tenantId: user.tenantId, tableId: dto.table_id ?? null, sessionId: dto.session_id ?? null,
      status: 'open', guestCount: dto.guest_count ?? 1, fulfillmentType: dto.fulfillment_type ?? 'dine_in',
      server: user.username, notes: dto.notes ?? null, createdBy: user.username,
    }).returning({ id: dineInOrders.id });
    await this.insertItems(Number(h!.id), user.tenantId, dto.items, user, opts);
    await this.refreshTotals(Number(h!.id));
    // opening an order occupies the table
    if (dto.table_id) await db.update(diningTables).set({ status: 'occupied', updatedAt: new Date() }).where(and(eq(diningTables.id, dto.table_id), inArray(diningTables.status, ['available', 'reserved'] as NonNullable<typeof diningTables.$inferSelect.status>[])));
    return this.getOrder(orderNo, user);
  }

  async addItems(orderNo: string, dto: AddItemsDto, user: JwtUser, opts?: { buffet?: boolean; buffetPackageId?: number }) {
    const db = this.db;
    const o = await this.loadOrder(orderNo);
    if (['paid', 'closed', 'cancelled'].includes(String(o.status))) throw new BadRequestException({ code: 'ORDER_CLOSED', message: 'Order is closed', messageTh: 'ออเดอร์ปิดแล้ว' });
    await this.insertItems(Number(o.id), o.tenantId, dto.items, user, opts);
    await this.refreshTotals(Number(o.id));
    return this.getOrder(orderNo, user);
  }

  // ── table operations: transfer items / merge tabs (Phase 1) ──
  private async liveSessionForTable(tableId: number) {
    const db = this.db;
    const [s] = await db.select().from(tableSessions).where(and(eq(tableSessions.tableId, tableId), inArray(tableSessions.status, ['open', 'bill_requested', 'paying']))).orderBy(desc(tableSessions.id)).limit(1);
    return s;
  }

  // the live session's open order for a table — created empty if the table is seated but has none yet
  async ensureOpenOrder(tableId: number, user: JwtUser) {
    const db = this.db;
    const s = await this.liveSessionForTable(tableId);
    if (!s) throw new BadRequestException({ code: 'NO_SESSION', message: 'Target table has no live session', messageTh: 'โต๊ะปลายทางไม่มีลูกค้า' });
    const [o] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, Number(s.id)), ne(dineInOrders.status, 'closed'), ne(dineInOrders.status, 'cancelled'))).orderBy(desc(dineInOrders.id)).limit(1);
    if (o) return o;
    const orderNo = await this.docNo.nextDaily('DIN');
    await db.insert(dineInOrders).values({ orderNo, tenantId: user.tenantId, tableId, sessionId: Number(s.id), status: 'open', server: user.username, createdBy: user.username });
    await db.update(diningTables).set({ status: 'occupied', updatedAt: new Date() }).where(eq(diningTables.id, tableId));
    return this.loadOrder(orderNo);
  }

  // move selected (non-voided) line items from one order to another table's open order; bill follows the items
  // Floor operations (transfer/merge/fire/seat) — extracted to DineInTablesService (god-service ratchet
  // round); order load/totals/status/view mechanics stay here and feed it as ports.
  async transferItems(orderNo: string, itemIds: number[], toTableId: number, user: JwtUser) { return this.tables.transferItems(orderNo, itemIds, toTableId, user); }
  async mergeTables(targetTableId: number, fromTableId: number, user: JwtUser) { return this.tables.mergeTables(targetTableId, fromTableId, user); }
  async fire(orderNo: string, user: JwtUser, course?: number, seat?: number) { return this.tables.fire(orderNo, user, course, seat); }
  async assignSeat(orderNo: string, itemIds: number[], seat: number | null, user: JwtUser) { return this.tables.assignSeat(orderNo, itemIds, seat, user); }

  // KDS item transition (start/ready/recall/serve/void)
  async itemTransition(itemId: number, action: string, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    const [item] = await db.select().from(dineInOrderItems).where(eq(dineInOrderItems.id, itemId)).limit(1);
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Item not found', messageTh: 'ไม่พบรายการ' });
    const now = new Date();
    const cur = String(item.kdsStatus);
    const set: any = { updatedAt: now };
    const bad = () => { throw new BadRequestException({ code: 'BAD_TRANSITION', message: `Cannot ${action} from ${cur}`, messageTh: 'เปลี่ยนสถานะไม่ถูกต้อง' }); };
    if (action === 'start') { if (cur !== 'queued') bad(); set.kdsStatus = 'preparing'; set.startedAt = now; }
    else if (action === 'ready') { if (cur !== 'preparing') bad(); set.kdsStatus = 'ready'; set.readyAt = now; }
    else if (action === 'recall') { if (!['preparing', 'ready'].includes(cur)) bad(); set.kdsStatus = 'queued'; set.startedAt = null; set.readyAt = null; set.recallCount = (Number(item.recallCount) || 0) + 1; } // KDS recall — bump the all-day recall counter (POS-4)
    else if (action === 'serve') { if (cur !== 'ready') bad(); set.kdsStatus = 'served'; set.servedAt = now; }
    else if (action === 'void') { if (['served', 'voided'].includes(cur)) bad(); set.kdsStatus = 'voided'; set.voidedAt = now; set.voidReason = reason ?? null; }
    else bad();
    await db.update(dineInOrderItems).set(set).where(eq(dineInOrderItems.id, itemId));
    await this.refreshTotals(Number(item.orderId));
    const status = await this.recomputeOrderStatus(Number(item.orderId));
    // realtime: fan this KDS state change out to every other terminal (SSE), so a second screen reflects
    // it without waiting for its poll. Best-effort — a missing realtime service never blocks the action.
    this.realtime?.publish({ type: 'kds_item', tenant_id: user.tenantId ?? null, item_id: itemId, order_id: Number(item.orderId), kds_status: set.kdsStatus, order_status: status, at: now.toISOString() });
    return { item_id: itemId, kds_status: set.kdsStatus, order_status: status };
  }

  // system-derived order status from aggregate item state (never downgrades terminal states)
  async recomputeOrderStatus(orderId: number) {
    const db = this.db;
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

  async requestBill(orderNo: string, user: JwtUser) { return this.tables.requestBill(orderNo, user); }

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
    const built = await this.buildSale(o, saleNo, dto.discount ?? 0, user, {
      orderDiscountPct: dto.discount_pct, promoCode: dto.promo_code, voucherCode: dto.voucher_code, lineDiscounts: dto.line_discounts, memberId: dto.member_id, pointsRedeem, tip: dto.tip, giftCardNo: dto.gift_card_no, giftCardAmount: dto.gift_card_amount,
      applyPricingRules: dto.apply_pricing_rules,
      // pricing.channel also gates a channel-scoped voucher (POS-3) — thread it even when rules are off
      // (every other pricing.* consumer is gated on applyPricingRules, so this changes nothing else).
      pricing: dto.apply_pricing_rules ? { channel: dto.channel ?? 'dine_in', location: dto.location, partySize: dto.party_size ?? o.guestCount ?? 0, serviceChargePct: dto.service_charge_pct, serviceMinParty: dto.service_min_party, rounding: dto.rounding } : { channel: dto.channel ?? 'dine_in' },
    });
    // tender the SALE-MONEY cash (= total − gift draw-down on the bill); gift is already settled as the 2200
    // draw, not a drawer payment. payments.amount excludes tip (tip rides separately) so the Z-report's
    // cash reconciliation counts sale money only. Skip the tender when no sale-money cash is due.
    const saleCash = roundCurrency(built.total - Math.min(built.gift_applied, built.total), 'THB');
    const openTill = o.tenantId != null ? await this.payments.currentOpenTill(o.tenantId) : null;
    const tender: any = saleCash > 0
      ? await this.payments.recordTender({ sale_no: saleNo, tenant_id: o.tenantId ?? undefined, method: dto.method ?? 'Cash', amount: saleCash, tip: built.tip, currency: 'THB', gateway: 'mock', till_session_id: openTill?.id }, user)
      : null;
    const inv = await this.markPaidAndInvoice(o, saleNo, user);

    // Fiscal electronic journal (RD tamper-evidence, PN-20): the restaurant path used to append NOTHING,
    // so dine-in/diner-QR/register sales — the bulk of a restaurant's revenue — were absent from the
    // hash chain that the portal POS and the refund/void paths already write to. Append once here, at
    // finalisation, with the authoritative figures. Best-effort (like the payments path): a journal
    // outage must not roll back a settled sale, and `GET /api/pos/journal/verify` detects a gap.
    // NB on a LAN-first store the hub keeps its OWN chain (its in-store journal) and the cloud appends
    // again when the sale replays — the cloud chain is the company's book of record (docs/41, PN-24 §7 6c).
    try {
      await this.fiscal?.append({
        doc_type: 'SALE', doc_no: saleNo, action: 'checkout',
        payload: {
          order_no: orderNo, sale_no: saleNo, subtotal: built.subtotal, discount: built.discount,
          vat: built.vat, service_charge: built.service_charge, tip: built.tip, total: built.total,
          method: dto.method ?? 'Cash', tax_invoice_no: inv ?? null,
        },
      }, user);
    } catch { /* tamper-evidence is detective: verify() surfaces the gap, the sale stands */ }

    return { order_no: orderNo, sale_no: saleNo, ...built, payment_no: tender?.payment_no ?? null, payment_status: tender?.status ?? null, tax_invoice_no: inv };
  }

  // shared: insert cust_pos_sales + items + GL from a dine-in order — extracted to DineInSaleService
  // (service-size headroom round; ctor-body plain class). The ONE place the POS food GL is posted.
  async buildSale(o: any, saleNo: string, discount: number, user: JwtUser, opts?: Parameters<DineInSaleService['buildSale']>[4]) {
    return this.sale.buildSale(o, saleNo, discount, user, opts);
  }

  // mark order paid + close table/session + idempotent abbreviated tax invoice
  async markPaidAndInvoice(o: any, saleNo: string, user: JwtUser) {
    const db = this.db;
    const now = new Date();
    // snapshot the table's CURRENT room onto the order — keeps per-room revenue accurate even if the table
    // is later moved to another room (zone lives on the table, not on the historical sale).
    let zoneId: number | null = null;
    if (o.tableId) { const [tbl] = await db.select({ zoneId: diningTables.zoneId }).from(diningTables).where(eq(diningTables.id, o.tableId)).limit(1); zoneId = tbl?.zoneId ?? null; }
    await db.update(dineInOrders).set({ status: 'paid', saleNo, zoneId, paidAt: now, closedAt: now }).where(eq(dineInOrders.id, o.id));
    // Close the table on payment. auto_close_on_paid (0434) frees it straight to 'available' so the table
    // can be reused the instant the bill clears; otherwise it holds in 'cleaning' until staff clear it.
    if (o.tableId) await db.update(diningTables).set({ status: (await this.autoCloseOnPaid()) ? 'available' : 'cleaning', updatedAt: now }).where(eq(diningTables.id, o.tableId));
    if (o.sessionId) await db.update(tableSessions).set({ status: 'closed', closedAt: now, saleNo }).where(eq(tableSessions.id, o.sessionId));
    return this.issueAbbreviated(saleNo, user);
  }

  // Per-tenant QR/close setting (0434). Assumes we are inside scope.run(tenantId) / the request tenant tx.
  private async autoCloseOnPaid(): Promise<boolean> {
    const [row] = await this.db.select({ v: qrSettings.autoCloseOnPaid }).from(qrSettings).limit(1);
    return row?.v === true;
  }

  // KDS "serve the whole ticket" — scan the order QR (or tap Served on the expo card) to mark EVERY ready
  // line of an order as served in one go, so a finished ticket never lingers on the pass. Only lines that
  // are actually 'ready' flip; queued/preparing lines are left for the station. Idempotent (0 ready → noop).
  async serveOrder(orderNo: string, user: JwtUser) {
    const db = this.db;
    const o = await this.loadOrder(orderNo);
    const now = new Date();
    const served = await db.update(dineInOrderItems)
      .set({ kdsStatus: 'served', servedAt: now, updatedAt: now })
      .where(and(eq(dineInOrderItems.orderId, Number(o.id)), eq(dineInOrderItems.kdsStatus, 'ready')))
      .returning({ id: dineInOrderItems.id });
    if (served.length) {
      const status = await this.recomputeOrderStatus(Number(o.id));
      this.realtime?.publish({ type: 'kds_item', tenant_id: user.tenantId ?? null, order_id: Number(o.id), kds_status: 'served', order_status: status, at: now.toISOString() });
    }
    return { order_no: orderNo, served: served.length };
  }

  // idempotent abbreviated tax invoice for a sale (VAT-unregistered tenant → null, no slip).
  async issueAbbreviated(saleNo: string, user: JwtUser): Promise<string | null> {
    try { const inv: any = await this.taxInvoice.issueAbbreviatedFromSale(saleNo, user); return inv?.doc_no ?? null; } catch { return null; }
  }

  // SALE- number, collision-safe: nextTenantStamped is second-precision, so rapid/split sales in the
  // same second would clash on cust_pos_sales.sale_no (UNIQUE). Retry on a bumped second until unique.
  async mintSaleNo(tenantId: number | null) {
    const db = this.db;
    let code = 'POS';
    if (tenantId != null) { const [t] = await db.select({ code: tenants.code }).from(tenants).where(eq(tenants.id, tenantId)).limit(1); code = t?.code ?? 'POS'; }
    for (let attempt = 0; attempt < 12; attempt++) {
      const saleNo = this.docNo.nextTenantStamped('SALE', code, new Date(Date.now() + attempt * 1000));
      const [exists] = await db.select({ id: custPosSales.id }).from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
      if (!exists) return saleNo;
    }
    return this.docNo.nextTenantStamped('SALE', code) + '-' + Math.floor(Date.now() % 997);
  }

  // split bill: cust_pos_sales + items + ONE GL entry from a subset/slice — extracted to DineInSaleService.
  async buildCheckSale(o: any, saleNo: string, lines: any[], opts: { grossOverride?: number; discount?: number }, user: JwtUser) {
    return this.sale.buildCheckSale(o, saleNo, lines, opts, user);
  }

  // split: per-check invoices already issued — flip the order/table/session to paid/closed (no new sale).
  async markAllChecksPaid(o: any, _user: JwtUser) {
    const db = this.db;
    const now = new Date();
    await db.update(dineInOrders).set({ status: 'paid', paidAt: now, closedAt: now }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'cleaning', updatedAt: now }).where(eq(diningTables.id, o.tableId));
    if (o.sessionId) await db.update(tableSessions).set({ status: 'closed', closedAt: now }).where(eq(tableSessions.id, o.sessionId));
  }

  async closeTable(orderNo: string, user: JwtUser) {
    const db = this.db;
    const o = await this.loadOrder(orderNo);
    await db.update(dineInOrders).set({ status: 'closed', closedAt: new Date() }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'available', updatedAt: new Date() }).where(eq(diningTables.id, o.tableId));
    return { order_no: orderNo, status: 'closed' };
  }

  async cancelOrder(orderNo: string, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    const o = await this.loadOrder(orderNo);
    if (!['open', 'sent_to_kitchen'].includes(String(o.status))) throw new BadRequestException({ code: 'CANNOT_CANCEL', message: 'Cannot cancel after serving/payment', messageTh: 'ยกเลิกไม่ได้หลังเสิร์ฟ/ชำระ' });
    await db.update(dineInOrders).set({ status: 'cancelled', closedAt: new Date(), notes: reason ?? o.notes }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'available', updatedAt: new Date() }).where(eq(diningTables.id, o.tableId));
    return { order_no: orderNo, status: 'cancelled' };
  }

  async loadOrder(orderNo: string) {
    const db = this.db;
    const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).limit(1);
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    return o;
  }

  // FOR UPDATE — used by settle paths so a concurrent double-submit serializes + re-checks status (no double-book).
  async loadOrderForUpdate(orderNo: string) {
    const db = this.db;
    const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).for('update').limit(1);
    if (!o) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    return o;
  }

  async getOrder(orderNo: string, _user: JwtUser) {
    const o = await this.loadOrder(orderNo);
    return this.viewOrder(o);
  }

  async listOpenOrders(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(dineInOrders).where(ne(dineInOrders.status, 'closed')).orderBy(desc(dineInOrders.id)).limit(100);
    return { orders: rows.filter((o: any) => o.status !== 'cancelled').map((o: any) => ({ order_no: o.orderNo, table_id: o.tableId, status: o.status, total: n(o.total), waited_min: o.firedAt ? Math.floor((Date.now() - new Date(o.firedAt).getTime()) / 60000) : 0 })) };
  }

  // order summary for the diner page (by session)
  async publicSummary(sessionId: number) {
    const db = this.db;
    const [o] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, sessionId), ne(dineInOrders.status, 'cancelled'))).orderBy(desc(dineInOrders.id)).limit(1);
    if (!o) return null;
    return this.viewOrder(o);
  }

  private async viewOrder(o: any) {
    const db = this.db;
    const items = await db.select({
      id: dineInOrderItems.id, itemId: dineInOrderItems.itemId, name: dineInOrderItems.name, qty: dineInOrderItems.qty, unitPrice: dineInOrderItems.unitPrice,
      amount: dineInOrderItems.amount, kdsStatus: dineInOrderItems.kdsStatus, stationId: dineInOrderItems.stationId, isBuffet: dineInOrderItems.isBuffet, course: dineInOrderItems.course, seat: dineInOrderItems.seat,
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
      const charge = i.itemId === '__buffet_charge__' || i.itemId === '__buffet_overtime__';
      return { item_id: Number(i.id), name: i.name, qty: n(i.qty), unit_price: n(i.unitPrice), amount: n(i.amount), kds_status: i.kdsStatus, status_th: statusTh[i.kdsStatus], is_buffet: i.isBuffet, course: i.course ?? 1, seat: i.seat ?? null, charge, modifiers: i.modifiers ?? [], notes: i.notes, elapsed_min: elapsedMin, remaining_min: remainingMin, prep_min: prep };
    });
    const waitedMin = o.firedAt ? Math.floor((now - new Date(o.firedAt).getTime()) / 60000) : 0;
    const readyInMin = Math.max(0, ...viewItems.filter((v: any) => !['served', 'voided'].includes(v.kds_status)).map((v: any) => v.remaining_min), 0);
    // seat-level roll-up (POS-9): per-seat subtotal of non-voided lines — drives the split-by-seat UI.
    const seats = new Map<number | null, number>();
    for (const v of viewItems) { if (v.kds_status === 'voided') continue; const key = v.seat ?? null; seats.set(key, roundCurrency((seats.get(key) ?? 0) + v.amount, 'THB')); }
    const seatSummary = [...seats.entries()].sort((a, b) => (a[0] ?? 1e9) - (b[0] ?? 1e9)).map(([seat, subtotal]) => ({ seat, subtotal }));
    return {
      order_no: o.orderNo, table_id: o.tableId, session_id: o.sessionId, status: o.status, guest_count: o.guestCount,
      subtotal: n(o.subtotal), vat: n(o.vat), total: n(o.total), sale_no: o.saleNo,
      waited_min: waitedMin, ready_in_min: readyInMin, items: viewItems, seats: seatSummary,
    };
  }
}
