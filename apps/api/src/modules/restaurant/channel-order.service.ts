import { Inject, Injectable, Optional, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dineInOrders, orderDeliveryDetails, channelWebhookEvents, tenants, payments, posMemberLedger } from '../../database/schema';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { TaxService } from '../tax/tax.service';
import { MemberService } from '../loyalty/member.service';
import { roundCurrency } from '../tax/money';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';
import { verifyInboundWebhook } from '../../common/webhook-auth';
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
    @Optional() private readonly member?: MemberService,
  ) {}

  // slug → tenant (controlled bypass: reads only id + name by code)
  private async resolveStore(slug: string): Promise<{ tenantId: number; storeName: string }> {
    const found = await this.scope.bypassQuery(async () => {
      const db = this.db;
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
      const db = this.db;
      const u = diner(tenantId);
      const view: any = await this.dineIn.createOrder({ items: dto.items, notes: dto.notes }, u); // tableId null
      const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, view.order_no)).limit(1);
      const token = mintChannelToken({ tenantId, orderId: Number(o!.id) });
      const fee = roundCurrency(n(dto.delivery_fee), 'THB');
      const memberId = dto.member_id ? Number(dto.member_id) : null;
      await db.update(dineInOrders).set({
        channel: dto.channel ?? 'web', fulfillmentType: dto.fulfillment_type ?? 'takeaway', fulfillmentStatus: 'received',
        deliveryFee: fx(fee, 2), scheduledAt: dto.scheduled_at ? new Date(dto.scheduled_at) : null,
        publicToken: token, server: 'channel:web', memberId,
      }).where(eq(dineInOrders.id, o!.id));
      if ((dto.fulfillment_type === 'delivery') && dto.delivery) {
        await db.insert(orderDeliveryDetails).values({
          tenantId, orderId: Number(o!.id), contactName: dto.delivery.contact_name ?? null, contactPhone: dto.delivery.contact_phone ?? null,
          addressLine: dto.delivery.address_line ?? null, addressNote: dto.delivery.address_note ?? null,
          lat: dto.delivery.lat != null ? String(dto.delivery.lat) : null, lng: dto.delivery.lng != null ? String(dto.delivery.lng) : null,
        });
      }
      return { order_no: view.order_no, token, track_url: `/track/${token}`, fulfillment_type: dto.fulfillment_type ?? 'takeaway', subtotal: n(view.subtotal), vat: n(view.vat), delivery_fee: fee, total: roundCurrency(n(view.total) + fee, 'THB') };
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
      const db = this.db;
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
  // Idempotent: repeated calls return the SAME open Pending tender (no orphan tenders / sale-nos). Locks
  // the order row so concurrent pay() serialize, and freezes the order to 'bill_requested' (the bill is in
  // flight) so item changes between pay and confirm are caught.
  async pay(token: string) {
    const claim = this.claimOrThrow(token);
    return this.scope.run(claim.tenantId, async () => {
      const db = this.db;
      const guard = await this.loadByToken(db, claim, token);
      const o = await this.dineIn.loadOrderForUpdate(guard.orderNo); // lock → serialize concurrent pay()
      if (['paid', 'closed', 'cancelled'].includes(String(o.status))) throw new BadRequestException({ code: 'ALREADY_PAID', message: 'Order already settled', messageTh: 'ออเดอร์ชำระแล้ว' });
      const total = roundCurrency(n(o.total) + n(o.deliveryFee), 'THB');
      if (!(total > 0)) throw new BadRequestException({ code: 'EMPTY_BILL', message: 'Bill is zero', messageTh: 'ยอดบิลเป็นศูนย์' });
      if (o.saleNo) {
        const [ex] = await db.select().from(payments).where(and(eq(payments.saleNo, o.saleNo), eq(payments.method, 'PromptPay'), sql`${payments.status}::text = 'Pending'`)).limit(1);
        if (ex) return { payment_no: ex.paymentNo, status: ex.status, gateway_ref: ex.gatewayRef, total };
      }
      const u = diner(claim.tenantId);
      const saleNo = o.saleNo ?? await this.dineIn.mintSaleNo(claim.tenantId); // never overwrite an existing sale_no
      const tender: any = await this.payments.recordTender({ sale_no: saleNo, tenant_id: claim.tenantId, method: 'PromptPay', amount: total, currency: 'THB', gateway: 'promptpay' }, u);
      await db.update(dineInOrders).set({ saleNo, status: 'bill_requested', billRequestedAt: new Date() }).where(eq(dineInOrders.id, o.id));
      return { payment_no: tender.payment_no, status: tender.status, gateway_ref: tender.gateway_ref, total };
    });
  }

  // PUBLIC: settle → food GL (buildSale) + delivery GL + abbreviated invoice
  async confirm(token: string, paymentNo: string) {
    const claim = this.claimOrThrow(token);
    return this.scope.run(claim.tenantId, async () => {
      const u = diner(claim.tenantId);
      const settled: any = await this.payments.settle(paymentNo, u);
      const guard = await this.loadByToken(this.db, claim, token);
      const o = await this.dineIn.loadOrderForUpdate(guard.orderNo); // FOR UPDATE → double-confirm serializes
      if (!o.saleNo) throw new BadRequestException({ code: 'NO_SALE', message: 'Call /pay first', messageTh: 'กรุณาเริ่มชำระเงินก่อน' });
      const built: any = await this.dineIn.buildSale(o, o.saleNo, 0, u);
      await this.postDeliveryFeeGL(o, o.saleNo, u);
      // reconciliation guard: the captured tender (set at pay) must equal the freshly-built bill. If items
      // changed between pay and confirm, the books would diverge from the money — reject instead (rolls back GL).
      const [pmt] = await this.db.select({ amount: payments.amount }).from(payments).where(eq(payments.paymentNo, paymentNo)).limit(1);
      const expected = roundCurrency(n(built.total) + n(o.deliveryFee), 'THB');
      if (pmt && Math.abs(n(pmt.amount) - expected) > 0.01) throw new BadRequestException({ code: 'TENDER_MISMATCH', message: `Captured ${n(pmt.amount)} != bill ${expected} — order changed after payment`, messageTh: 'ยอดที่ชำระไม่ตรงกับบิล' });
      const invNo = await this.dineIn.markPaidAndInvoice(o, o.saleNo, u);
      // Loyalty earn for linked member — idempotent on saleNo (skip if already earned).
      let pointsEarned = 0;
      if (this.member && o.memberId) {
        const db2 = this.db;
        const [ex] = await db2.select({ id: posMemberLedger.id }).from(posMemberLedger)
          .where(and(eq(posMemberLedger.refDoc, o.saleNo), eq(posMemberLedger.txnType, 'Earn'))).limit(1);
        if (!ex) {
          await db2.transaction(async (tx: any) => {
            pointsEarned = await this.member!.earnInTx(tx, claim.tenantId, Number(o.memberId), n(built.total), o.saleNo!, 'channel:confirm');
          });
        }
      }
      return { paid: true, payment_status: settled.status, sale_no: o.saleNo, total: built.total, delivery_fee: n(o.deliveryFee), journal_no: built.journal_no, tax_invoice_no: invNo, points_earned: pointsEarned };
    });
  }

  // KIOSK: on-prem self-order that TENDERS AT CREATE (authenticated device) — one call, no public token.
  async kioskCheckout(dto: any, user: JwtUser) {
    const db = this.db;
    const view: any = await this.dineIn.createOrder({ items: dto.items, notes: dto.notes }, user);
    const [created] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, view.order_no)).limit(1);
    const fee = roundCurrency(n(dto.delivery_fee), 'THB');
    const kioskMemberId = dto.member_id ? Number(dto.member_id) : null;
    // mint a per-order public token so the takeaway customer can track the order (GET /api/order/t/:token).
    const trackToken = mintChannelToken({ tenantId: user.tenantId ?? 0, orderId: Number(created!.id) });
    await db.update(dineInOrders).set({ channel: 'kiosk', fulfillmentType: dto.fulfillment_type ?? 'takeaway', fulfillmentStatus: 'received', deliveryFee: fx(fee, 2), memberId: kioskMemberId, publicToken: trackToken }).where(eq(dineInOrders.id, created!.id));
    const o = await this.dineIn.loadOrderForUpdate(view.order_no);
    const saleNo = await this.dineIn.mintSaleNo(user.tenantId ?? null);
    const built: any = await this.dineIn.buildSale(o, saleNo, 0, user);
    await this.postDeliveryFeeGL(o, saleNo, user);
    const saleCash = roundCurrency(n(built.total) + fee, 'THB'); // kiosk pays food + delivery in one tender
    const openTill = user.tenantId != null ? await this.payments.currentOpenTill(user.tenantId) : null;
    const tender: any = saleCash > 0 ? await this.payments.recordTender({ sale_no: saleNo, tenant_id: user.tenantId ?? undefined, method: dto.method ?? 'Cash', amount: saleCash, currency: 'THB', gateway: 'mock', till_session_id: openTill?.id }, user) : null;
    const invNo = await this.dineIn.markPaidAndInvoice(o, saleNo, user);
    let kioskPoints = 0;
    if (this.member && kioskMemberId && user.tenantId != null) {
      await db.transaction(async (tx: any) => {
        kioskPoints = await this.member!.earnInTx(tx, user.tenantId!, kioskMemberId, n(built.total), saleNo, user.username);
      });
    }
    return { order_no: view.order_no, sale_no: saleNo, total: built.total, delivery_fee: fee, payment_no: tender?.payment_no ?? null, tax_invoice_no: invNo, points_earned: kioskPoints, track_token: trackToken, track_url: `/track/${trackToken}` };
  }

  // STAFF: advance the fulfillment/handoff machine (separate from KDS item state)
  async advanceFulfillment(orderNo: string, action: string, user: JwtUser) {
    const db = this.db;
    const o = await this.dineIn.loadOrder(orderNo);
    const cur = String(o.fulfillmentStatus ?? 'received');
    if (!(FULFILL_NEXT[cur] ?? []).includes(action)) throw new BadRequestException({ code: 'BAD_TRANSITION', message: `Cannot go ${cur} → ${action}`, messageTh: 'เปลี่ยนสถานะการจัดส่งไม่ถูกต้อง' });
    const now = new Date();
    await db.update(dineInOrders).set({ fulfillmentStatus: action as typeof dineInOrders.$inferInsert.fulfillmentStatus }).where(eq(dineInOrders.id, o.id));
    if (action === 'out_for_delivery') await db.update(orderDeliveryDetails).set({ dispatchedAt: now }).where(eq(orderDeliveryDetails.orderId, Number(o.id)));
    if (action === 'completed') await db.update(orderDeliveryDetails).set({ deliveredAt: now }).where(eq(orderDeliveryDetails.orderId, Number(o.id)));
    return { order_no: orderNo, fulfillment_status: action };
  }

  // STAFF: active online/delivery orders board
  async fulfillmentBoard(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(dineInOrders).where(isNotNull(dineInOrders.fulfillmentStatus)).limit(200);
    return { orders: rows.filter((o: any) => o.fulfillmentStatus && !['completed', 'rejected'].includes(o.fulfillmentStatus)).map((o: any) => ({ order_no: o.orderNo, channel: o.channel, fulfillment_type: o.fulfillmentType, fulfillment_status: o.fulfillmentStatus, total: n(o.total), delivery_fee: n(o.deliveryFee) })) };
  }

  // 3rd-party (Grab/LineMan) ingest — idempotent at the edge (event id) AND the order (ext order id).
  // Authenticated by a per-source shared secret (store_ref is a public, enumerable slug → NOT an auth factor):
  // fail-CLOSED in production (a missing secret config rejects); lenient only in dev/test.
  async ingestThirdParty(source: string, body: any, secret?: string, sig?: { rawBody?: Buffer | string; signature?: string; timestamp?: string }) {
    if (!['grab', 'lineman'].includes(source)) throw new BadRequestException({ code: 'BAD_SOURCE', message: 'Unknown channel source', messageTh: 'ช่องทางไม่ถูกต้อง' });
    // Authenticate (security review L-2): HMAC-over-body when WEBHOOK_HMAC_SECRET_<SOURCE> / CHANNEL_WEBHOOK_HMAC_SECRET
    // is set, else the legacy static shared secret; fail-closed in prod when neither is configured.
    const staticSecret = process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`] || process.env.CHANNEL_WEBHOOK_SECRET;
    const hmacSecret = process.env[`WEBHOOK_HMAC_SECRET_${source.toUpperCase()}`] || process.env.CHANNEL_WEBHOOK_HMAC_SECRET;
    const auth = verifyInboundWebhook({ rawBody: sig?.rawBody, staticSecret, providedSecret: secret, hmacSecret, signature: sig?.signature, timestamp: sig?.timestamp });
    if (auth === 'stale') throw new UnauthorizedException({ code: 'WEBHOOK_STALE', message: 'Webhook timestamp outside the allowed window (possible replay)', messageTh: 'เวลาของ webhook หมดอายุ (อาจเป็นการส่งซ้ำ)' });
    if (auth === 'bad') throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIG', message: 'Invalid webhook signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' });
    if (auth === 'unconfigured' && process.env.NODE_ENV === 'production') throw new UnauthorizedException({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook secret not configured', messageTh: 'ยังไม่ได้ตั้งค่า webhook secret' });
    if (!body?.ext_event_id || !body?.ext_order_id || !body?.store_ref) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'ext_event_id, ext_order_id, store_ref required', messageTh: 'ข้อมูล webhook ไม่ครบ' });
    const { tenantId } = await this.resolveStore(body.store_ref);
    return this.scope.run(tenantId, async () => {
      const db = this.db;
      // edge idempotency: one processed event per (source, ext_event_id)
      const ins = await db.insert(channelWebhookEvents).values({ tenantId, source, extEventId: body.ext_event_id, extOrderId: body.ext_order_id, payload: body, status: 'processed' }).onConflictDoNothing({ target: [channelWebhookEvents.source, channelWebhookEvents.extEventId] }).returning({ id: channelWebhookEvents.id });
      const findExisting = async () => (await db.select().from(dineInOrders).where(and(eq(dineInOrders.extSource, source), eq(dineInOrders.extOrderId, String(body.ext_order_id)))).limit(1))[0];
      // order idempotency: one internal order per (tenant, ext_source, ext_order_id)
      let existing = await findExisting();
      if (existing) {
        if (ins.length) await db.update(channelWebhookEvents).set({ orderNo: existing.orderNo, status: 'duplicate' }).where(and(eq(channelWebhookEvents.source, source), eq(channelWebhookEvents.extEventId, body.ext_event_id)));
        return { status: 'duplicate', order_no: existing.orderNo };
      }
      try {
        const u = diner(tenantId);
        const items = (body.items ?? []).map((it: any) => ({ name: it.name, qty: n(it.qty), unit_price: n(it.unit_price), station_code: it.station_code ?? 'hot' }));
        const view: any = await this.dineIn.createOrder({ items }, u);
        await db.update(dineInOrders).set({ channel: source as any, fulfillmentType: body.fulfillment_type ?? 'delivery', fulfillmentStatus: 'accepted', extSource: source, extOrderId: String(body.ext_order_id), server: `channel:${source}` }).where(eq(dineInOrders.orderNo, view.order_no));
        if (body.customer) {
          const [oRow] = await db.select({ id: dineInOrders.id }).from(dineInOrders).where(eq(dineInOrders.orderNo, view.order_no)).limit(1);
          await db.insert(orderDeliveryDetails).values({ tenantId, orderId: Number(oRow!.id), contactName: body.customer.name ?? null, contactPhone: body.customer.phone ?? null, addressLine: body.customer.address ?? null });
        }
        await db.update(channelWebhookEvents).set({ orderNo: view.order_no }).where(and(eq(channelWebhookEvents.source, source), eq(channelWebhookEvents.extEventId, body.ext_event_id)));
        return { status: 'processed', order_no: view.order_no, channel: source };
      } catch (e: any) {
        // concurrent-replay race: the partial-unique (tenant,ext_source,ext_order_id) lost → resolve to the winner
        if (isUniqueViolation(e)) { existing = await findExisting(); if (existing) return { status: 'duplicate', order_no: existing.orderNo }; }
        throw e;
      }
    });
  }

  // delivery-fee GL — Dr 1000 / Cr 4100 (net) / Cr 2100 (vat). Fee is the VAT-inclusive charge.
  private async postDeliveryFeeGL(o: any, saleNo: string, user: JwtUser) {
    const fee = roundCurrency(n(o.deliveryFee), 'THB');
    if (!(fee > 0)) return;
    if (await this.ledger.alreadyPosted('POS-DELIV', saleNo)) return;
    const inc = this.tax.calcInclusive({ gross: fee, country: 'TH' });
    // docs/43 PR-6: the delivery-income leg follows the tenant posting-rule (SALE.DELIVERY) ?? default.
    const delAcct = (await this.ledger.postingOverrides('SALE.DELIVERY', o.tenantId)).delivery_income ?? postingDefault('SALE.DELIVERY', 'delivery_income');
    await this.ledger.postEntry({ source: 'POS-DELIV', sourceRef: saleNo, tenantId: o.tenantId, memo: `Delivery fee ${saleNo}`, createdBy: user.username, lines: [{ account_code: '1000', debit: fee }, { account_code: delAcct, credit: inc.net }, { account_code: '2100', credit: inc.tax }] });
  }
}
