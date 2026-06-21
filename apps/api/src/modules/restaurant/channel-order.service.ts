import { Inject, Injectable, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { eq, and, isNotNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dineInOrders, orderDeliveryDetails, channelWebhookEvents, tenants } from '../../database/schema';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { TaxService } from '../tax/tax.service';
import { roundCurrency } from '../tax/money';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { RealtimeScope } from './realtime.scope';
import { DineInService } from './dine-in.service';
import { mintChannelToken, verifyChannelToken } from './channel-token.util';

// A synthetic principal for public/aggregator channel writes — tenant-scoped, no extra permissions.
const diner = (tenantId: number): JwtUser => ({ username: 'channel:public', role: 'Sales', customerName: null, tenantId, permissions: [] });

// fulfillment lifecycle (orthogonal to the KDS kitchen-ticket machine): customer-facing handoff state.
const FULFILL_NEXT: Record<string, string[]> = {
  received: ['accepted', 'rejected'],
  accepted: ['preparing', 'rejected'],
  preparing: ['ready'],
  ready: ['out_for_delivery', 'completed'],
  out_for_delivery: ['completed'],
  completed: [],
  rejected: [],
};

// Online ordering + delivery + kiosk. Public flows run under RealtimeScope.run(tenantId) (RLS-scoped),
// like QrService, but bound to one ORDER (per-order HMAC token) instead of a table session. The food sale
// GL is ALWAYS posted by DineInService.buildSale (never duplicated); the delivery fee is a separate
// balanced stream (4100) so food vs delivery revenue is reportable apart.
@Injectable()
export class ChannelOrderService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly scope: RealtimeScope,
    private readonly dineIn: DineInService,
    private readonly payments: PaymentService,
    private readonly ledger: LedgerService,
    private readonly tax: TaxService,
  ) {}

  // slug → tenant (controlled bypass: reads only id + name by code)
  private async resolveStore(slug: string): Promise<{ tenantId: number; storeName: string }> {
    const found = await this.scope.bypassQuery(async () => {
      const db = this.db as any;
      const [t] = await db.select({ id: tenants.id, name: tenants.name }).from(tenants).where(eq(tenants.code, slug)).limit(1);
      return t ? { tenantId: Number(t.id), storeName: t.name } : null;
    });
    if (!found) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: `Store ${slug} not found`, messageTh: 'ไม่พบร้านค้า' });
    return found;
  }
  async store(slug: string) { return this.resolveStore(slug); }

  // PUBLIC: create a takeaway/delivery/pickup order (no staff) over web/kiosk
  async createPublicOrder(slug: string, dto: any) {
    const { tenantId } = await this.resolveStore(slug);
    return this.scope.run(tenantId, async () => {
      const db = this.db as any;
      const u = diner(tenantId);
      const view: any = await this.dineIn.createOrder({ items: dto.items, notes: dto.notes }, u); // tableId null
      const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, view.order_no)).limit(1);
      const token = mintChannelToken({ tenantId, orderId: Number(o.id) });
      const fee = roundCurrency(n(dto.delivery_fee), 'THB');
      await db.update(dineInOrders).set({
        channel: dto.channel ?? 'web', fulfillmentType: dto.fulfillment_type ?? 'takeaway', fulfillmentStatus: 'received',
        deliveryFee: fx(fee, 2), scheduledAt: dto.scheduled_at ? new Date(dto.scheduled_at) : null, publicToken: token, server: 'channel:web',
      }).where(eq(dineInOrders.id, o.id));
      if ((dto.fulfillment_type === 'delivery') && dto.delivery) {
        await db.insert(orderDeliveryDetails).values({
          tenantId, orderId: Number(o.id), contactName: dto.delivery.contact_name ?? null, contactPhone: dto.delivery.contact_phone ?? null,
          addressLine: dto.delivery.address_line ?? null, addressNote: dto.delivery.address_note ?? null,
          lat: dto.delivery.lat != null ? String(dto.delivery.lat) : null, lng: dto.delivery.lng != null ? String(dto.delivery.lng) : null,
        });
      }
      return { order_no: view.order_no, token, fulfillment_type: dto.fulfillment_type ?? 'takeaway', subtotal: n(view.subtotal), vat: n(view.vat), delivery_fee: fee, total: roundCurrency(n(view.total) + fee, 'THB') };
    });
  }

  private claimOrThrow(token: string) {
    const claim = verifyChannelToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid order token', messageTh: 'โทเคนออเดอร์ไม่ถูกต้อง' });
    return claim;
  }
  private async loadByToken(db: any, claim: { orderId: number }, token: string) {
    const [o] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.id, claim.orderId), eq(dineInOrders.publicToken, token))).limit(1);
    if (!o) throw new UnauthorizedException({ code: 'ORDER_NOT_FOUND', message: 'Order not found for this token', messageTh: 'ไม่พบออเดอร์' });
    return o;
  }

  // PUBLIC: live status tracking
  async status(token: string) {
    const claim = this.claimOrThrow(token);
    return this.scope.run(claim.tenantId, async () => {
      const db = this.db as any;
      const o = await this.loadByToken(db, claim, token);
      const v: any = await this.dineIn.getOrder(o.orderNo, diner(claim.tenantId));
      const fee = n(o.deliveryFee);
      return {
        order_no: o.orderNo, channel: o.channel, fulfillment_type: o.fulfillmentType, fulfillment_status: o.fulfillmentStatus,
        status: v.status, waited_min: v.waited_min, ready_in_min: v.ready_in_min, items: v.items,
        bill: { subtotal: v.subtotal, vat: v.vat, delivery_fee: fee, total: roundCurrency(n(v.total) + fee, 'THB') },
      };
    });
  }

  // PUBLIC: start PromptPay tender (Pending). Covers food total + delivery fee in one receipt.
  async pay(token: string) {
    const claim = this.claimOrThrow(token);
    return this.scope.run(claim.tenantId, async () => {
      const db = this.db as any;
      const o = await this.loadByToken(db, claim, token);
      if (['paid', 'closed', 'cancelled'].includes(String(o.status))) throw new BadRequestException({ code: 'ALREADY_PAID', message: 'Order already settled', messageTh: 'ออเดอร์ชำระแล้ว' });
      const total = roundCurrency(n(o.total) + n(o.deliveryFee), 'THB');
      if (!(total > 0)) throw new BadRequestException({ code: 'EMPTY_BILL', message: 'Bill is zero', messageTh: 'ยอดบิลเป็นศูนย์' });
      const u = diner(claim.tenantId);
      const saleNo = await this.dineIn.mintSaleNo(claim.tenantId);
      const tender: any = await this.payments.recordTender({ sale_no: saleNo, tenant_id: claim.tenantId, method: 'PromptPay', amount: total, currency: 'THB', gateway: 'promptpay' }, u);
      await db.update(dineInOrders).set({ saleNo }).where(eq(dineInOrders.id, o.id));
      return { payment_no: tender.payment_no, status: tender.status, gateway_ref: tender.gateway_ref, total };
    });
  }

  // PUBLIC: settle → food GL (buildSale) + delivery GL + abbreviated invoice
  async confirm(token: string, paymentNo: string) {
    const claim = this.claimOrThrow(token);
    return this.scope.run(claim.tenantId, async () => {
      const u = diner(claim.tenantId);
      const settled: any = await this.payments.settle(paymentNo, u);
      const guard = await this.loadByToken(this.db as any, claim, token);
      const o = await this.dineIn.loadOrderForUpdate(guard.orderNo); // FOR UPDATE → double-confirm serializes
      if (!o.saleNo) throw new BadRequestException({ code: 'NO_SALE', message: 'Call /pay first', messageTh: 'กรุณาเริ่มชำระเงินก่อน' });
      const built: any = await this.dineIn.buildSale(o, o.saleNo, 0, u);
      await this.postDeliveryFeeGL(o, o.saleNo, u);
      const invNo = await this.dineIn.markPaidAndInvoice(o, o.saleNo, u);
      return { paid: true, payment_status: settled.status, sale_no: o.saleNo, total: built.total, delivery_fee: n(o.deliveryFee), journal_no: built.journal_no, tax_invoice_no: invNo };
    });
  }

  // KIOSK: on-prem self-order that TENDERS AT CREATE (authenticated device) — one call, no public token.
  async kioskCheckout(dto: any, user: JwtUser) {
    const db = this.db as any;
    const view: any = await this.dineIn.createOrder({ items: dto.items, notes: dto.notes }, user);
    const [created] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, view.order_no)).limit(1);
    const fee = roundCurrency(n(dto.delivery_fee), 'THB');
    await db.update(dineInOrders).set({ channel: 'kiosk', fulfillmentType: dto.fulfillment_type ?? 'takeaway', fulfillmentStatus: 'received', deliveryFee: fx(fee, 2) }).where(eq(dineInOrders.id, created.id));
    const o = await this.dineIn.loadOrderForUpdate(view.order_no);
    const saleNo = await this.dineIn.mintSaleNo(user.tenantId ?? null);
    const built: any = await this.dineIn.buildSale(o, saleNo, 0, user);
    await this.postDeliveryFeeGL(o, saleNo, user);
    const saleCash = roundCurrency(n(built.total) + fee, 'THB'); // kiosk pays food + delivery in one tender
    const openTill = user.tenantId != null ? await this.payments.currentOpenTill(user.tenantId) : null;
    const tender: any = saleCash > 0 ? await this.payments.recordTender({ sale_no: saleNo, tenant_id: user.tenantId ?? undefined, method: dto.method ?? 'Cash', amount: saleCash, currency: 'THB', gateway: 'mock', till_session_id: openTill?.id }, user) : null;
    const invNo = await this.dineIn.markPaidAndInvoice(o, saleNo, user);
    return { order_no: view.order_no, sale_no: saleNo, total: built.total, delivery_fee: fee, payment_no: tender?.payment_no ?? null, tax_invoice_no: invNo };
  }

  // STAFF: advance the fulfillment/handoff machine (separate from KDS item state)
  async advanceFulfillment(orderNo: string, action: string, user: JwtUser) {
    const db = this.db as any;
    const o = await this.dineIn.loadOrder(orderNo);
    const cur = String(o.fulfillmentStatus ?? 'received');
    if (!(FULFILL_NEXT[cur] ?? []).includes(action)) throw new BadRequestException({ code: 'BAD_TRANSITION', message: `Cannot go ${cur} → ${action}`, messageTh: 'เปลี่ยนสถานะการจัดส่งไม่ถูกต้อง' });
    const now = new Date();
    await db.update(dineInOrders).set({ fulfillmentStatus: action }).where(eq(dineInOrders.id, o.id));
    if (action === 'out_for_delivery') await db.update(orderDeliveryDetails).set({ dispatchedAt: now }).where(eq(orderDeliveryDetails.orderId, Number(o.id)));
    if (action === 'completed') await db.update(orderDeliveryDetails).set({ deliveredAt: now }).where(eq(orderDeliveryDetails.orderId, Number(o.id)));
    return { order_no: orderNo, fulfillment_status: action };
  }

  // STAFF: active online/delivery orders board
  async fulfillmentBoard(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(dineInOrders).where(isNotNull(dineInOrders.fulfillmentStatus)).limit(200);
    return { orders: rows.filter((o: any) => o.fulfillmentStatus && !['completed', 'rejected'].includes(o.fulfillmentStatus)).map((o: any) => ({ order_no: o.orderNo, channel: o.channel, fulfillment_type: o.fulfillmentType, fulfillment_status: o.fulfillmentStatus, total: n(o.total), delivery_fee: n(o.deliveryFee) })) };
  }

  // 3rd-party (Grab/LineMan) ingest — idempotent at the edge (event id) AND the order (ext order id).
  async ingestThirdParty(source: string, body: any) {
    if (!['grab', 'lineman'].includes(source)) throw new BadRequestException({ code: 'BAD_SOURCE', message: 'Unknown channel source', messageTh: 'ช่องทางไม่ถูกต้อง' });
    if (!body?.ext_event_id || !body?.ext_order_id || !body?.store_ref) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'ext_event_id, ext_order_id, store_ref required', messageTh: 'ข้อมูล webhook ไม่ครบ' });
    const { tenantId } = await this.resolveStore(body.store_ref);
    return this.scope.run(tenantId, async () => {
      const db = this.db as any;
      // edge idempotency: one processed event per (source, ext_event_id)
      const ins = await db.insert(channelWebhookEvents).values({ tenantId, source, extEventId: body.ext_event_id, extOrderId: body.ext_order_id, payload: body, status: 'processed' }).onConflictDoNothing({ target: [channelWebhookEvents.source, channelWebhookEvents.extEventId] }).returning({ id: channelWebhookEvents.id });
      // order idempotency: one internal order per (tenant, ext_source, ext_order_id)
      const [existing] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.extSource, source), eq(dineInOrders.extOrderId, String(body.ext_order_id)))).limit(1);
      if (existing) {
        if (!ins.length) return { status: 'duplicate', order_no: existing.orderNo };
        await db.update(channelWebhookEvents).set({ orderNo: existing.orderNo, status: 'duplicate' }).where(and(eq(channelWebhookEvents.source, source), eq(channelWebhookEvents.extEventId, body.ext_event_id)));
        return { status: 'duplicate', order_no: existing.orderNo };
      }
      const u = diner(tenantId);
      const items = (body.items ?? []).map((it: any) => ({ name: it.name, qty: n(it.qty), unit_price: n(it.unit_price), station_code: it.station_code ?? 'hot' }));
      const view: any = await this.dineIn.createOrder({ items }, u);
      await db.update(dineInOrders).set({ channel: source as any, fulfillmentType: body.fulfillment_type ?? 'delivery', fulfillmentStatus: 'accepted', extSource: source, extOrderId: String(body.ext_order_id), server: `channel:${source}` }).where(eq(dineInOrders.orderNo, view.order_no));
      if (body.customer) {
        const [oRow] = await db.select({ id: dineInOrders.id }).from(dineInOrders).where(eq(dineInOrders.orderNo, view.order_no)).limit(1);
        await db.insert(orderDeliveryDetails).values({ tenantId, orderId: Number(oRow.id), contactName: body.customer.name ?? null, contactPhone: body.customer.phone ?? null, addressLine: body.customer.address ?? null });
      }
      await db.update(channelWebhookEvents).set({ orderNo: view.order_no }).where(and(eq(channelWebhookEvents.source, source), eq(channelWebhookEvents.extEventId, body.ext_event_id)));
      return { status: 'processed', order_no: view.order_no, channel: source };
    });
  }

  // delivery-fee GL — Dr 1000 / Cr 4100 (net) / Cr 2100 (vat). Fee is the VAT-inclusive charge.
  private async postDeliveryFeeGL(o: any, saleNo: string, user: JwtUser) {
    const fee = roundCurrency(n(o.deliveryFee), 'THB');
    if (!(fee > 0)) return;
    if (await this.ledger.alreadyPosted('POS-DELIV', saleNo)) return;
    const inc = this.tax.calcInclusive({ gross: fee, country: 'TH' });
    await this.ledger.postEntry({ source: 'POS-DELIV', sourceRef: saleNo, tenantId: o.tenantId, memo: `Delivery fee ${saleNo}`, createdBy: user.username, lines: [{ account_code: '1000', debit: fee }, { account_code: '4100', credit: inc.net }, { account_code: '2100', credit: inc.tax }] });
  }
}
