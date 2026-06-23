import { Inject, Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, ne, inArray, desc } from 'drizzle-orm';
import QRCode from 'qrcode';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { diningTables, tableSessions, dineInOrders, buffetPackages, payments } from '../../database/schema';
import { PaymentService } from '../payments/payments.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { RealtimeScope } from './realtime.scope';
import { TableService } from './table.service';
import { DineInService } from './dine-in.service';
import { MenuService } from '../menu/menu.service';
import { BuffetService } from './buffet.service';
import { verifyTableToken, type TableClaim } from './qr-token.util';
import { rateLimit } from './rate-limit.util';
import type { PublicOrderDto } from './dto';

const LIVE = ['open', 'bill_requested', 'paying'];
const diner = (tenantId: number): JwtUser => ({ username: 'diner:qr', role: 'Sales', customerName: null, tenantId, permissions: [] });

@Injectable()
export class QrService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly scope: RealtimeScope,
    private readonly tables: TableService,
    private readonly dineIn: DineInService,
    private readonly menuSvc: MenuService,
    private readonly buffet: BuffetService,
    private readonly payments: PaymentService,
  ) {}

  // diner scans the printed QR (stable table token) → mint/join a session, return the per-session token
  async start(qrToken: string) {
    // controlled bypass: discover which tenant the QR belongs to (reads only id + tenant_id + status)
    const resolved = await this.scope.bypassQuery(async () => {
      const dbx = this.db as any;
      const [t] = await dbx.select({ id: diningTables.id, tenantId: diningTables.tenantId }).from(diningTables).where(eq(diningTables.qrToken, qrToken)).limit(1);
      return t ? { tenantId: Number(t.tenantId), tableId: Number(t.id) } : null;
    });
    if (!resolved) throw new NotFoundException({ code: 'BAD_QR', message: 'Unknown table QR', messageTh: 'ไม่พบโต๊ะของ QR นี้' });
    return this.scope.run(resolved.tenantId, () => this.tables.openTable(resolved.tableId, undefined, 'diner:qr', null));
  }

  // verify HMAC + live session (under RLS) → claim. Throws 401 on forged/closed token.
  private async resolve(token: string): Promise<{ claim: TableClaim; session: any; table: any }> {
    const claim = verifyTableToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
    return this.scope.run(claim.tenantId, async () => {
      const dbx = this.db as any;
      const [session] = await dbx.select().from(tableSessions).where(and(eq(tableSessions.id, claim.sessionId), eq(tableSessions.publicToken, token), eq(tableSessions.tableId, claim.tableId), inArray(tableSessions.status, LIVE as any))).limit(1);
      if (!session) throw new UnauthorizedException({ code: 'SESSION_ENDED', message: 'Table session ended', messageTh: 'เซสชันโต๊ะนี้สิ้นสุดแล้ว' });
      const [table] = await dbx.select().from(diningTables).where(eq(diningTables.id, claim.tableId)).limit(1);
      return { claim, session, table };
    });
  }

  async status(token: string) {
    const claim = verifyTableToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
    return this.scope.run(claim.tenantId, () => this.snapshot(token, claim));
  }

  // current order + bill snapshot for the diner page — assumes we are already inside scope.run(tenantId).
  private async snapshot(token: string, claim: TableClaim) {
    const dbx = this.db as any;
    const [session] = await dbx.select().from(tableSessions).where(and(eq(tableSessions.id, claim.sessionId), eq(tableSessions.publicToken, token), inArray(tableSessions.status, LIVE as any))).limit(1);
    if (!session) throw new UnauthorizedException({ code: 'SESSION_ENDED', message: 'Table session ended', messageTh: 'เซสชันโต๊ะนี้สิ้นสุดแล้ว' });
    const [table] = await dbx.select({ tableNo: diningTables.tableNo }).from(diningTables).where(eq(diningTables.id, claim.tableId)).limit(1);
    const order = await this.dineIn.publicSummary(claim.sessionId);
    let buffet: any = null;
    if (session.orderMode === 'buffet') {
      const [pkg] = session.buffetPackageId ? await dbx.select({ name: buffetPackages.name }).from(buffetPackages).where(eq(buffetPackages.id, Number(session.buffetPackageId))).limit(1) : [];
      const expMs = session.buffetExpiresAt ? new Date(session.buffetExpiresAt).getTime() : null;
      buffet = {
        package_name: pkg?.name ?? null, pax: session.pax, expires_at: session.buffetExpiresAt,
        minutes_left: expMs ? Math.max(0, Math.ceil((expMs - Date.now()) / 60000)) : null,
        expired: expMs ? Date.now() > expMs : false,
      };
    }
    return {
      table_no: table?.tableNo ?? null, session_status: session.status, order_mode: session.orderMode, buffet,
      order: order ? { order_no: order.order_no, status: order.status, waited_min: order.waited_min, ready_in_min: order.ready_in_min, items: order.items } : null,
      bill: order ? { subtotal: order.subtotal, vat: order.vat, total: order.total, settled: session.status === 'closed' } : null,
    };
  }

  private async loadSession(sessionId: number) {
    const dbx = this.db as any;
    const [s] = await dbx.select().from(tableSessions).where(eq(tableSessions.id, sessionId)).limit(1);
    return s;
  }

  // diner sees the buffet tiers offered (before choosing a mode)
  async buffetTiers(token: string) {
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, () => this.buffet.publicTiers());
  }

  // diner picks a buffet tier + headcount → session switches to buffet mode, charge line + time window set
  async startBuffet(token: string, packageId: number, pax?: number) {
    this.throttle(token, 'buffet', 5);
    const { claim, session } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => {
      await this.buffet.startBuffet({ tenantId: claim.tenantId, tableId: claim.tableId, sessionId: claim.sessionId }, packageId, pax ?? session.partySize ?? 1, diner(claim.tenantId));
      return this.snapshot(token, claim);
    });
  }

  // diner pulls the menu to order from — full catalog with modifier groups inlined, scoped to the table's tenant.
  async menu(token: string) {
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, () => this.menuSvc.listMenuForOrder(diner(claim.tenantId)));
  }

  // diner submits menu-driven items → append to (or open) the session's order, then AUTO-FIRE to the KDS so the
  // kitchen sees it immediately. Price/station/86/modifier rules are resolved server-side (diner can't set price).
  async order(token: string, dto: PublicOrderDto) {
    this.throttle(token, 'order', 15);            // anti-abuse: cap diner order bursts per session
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => {
      const u = diner(claim.tenantId);
      const session = await this.loadSession(claim.sessionId);
      const buffet = session?.orderMode === 'buffet';
      const buffetPackageId = buffet ? Number(session.buffetPackageId) : undefined;
      if (buffet) {
        this.buffet.assertActive(session);                               // BUFFET_EXPIRED after the window
        await this.buffet.assertEligible(buffetPackageId!, dto.items);   // tier eligibility
      }
      const existing = await this.openOrderForSession(claim.sessionId);
      let orderNo: string;
      if (existing) {
        await this.dineIn.addItems(existing.orderNo, { items: dto.items as any }, u, { buffet, buffetPackageId });
        orderNo = existing.orderNo;
      } else {
        const created = await this.dineIn.createOrder({ table_id: claim.tableId, session_id: claim.sessionId, items: dto.items as any }, u, { buffet, buffetPackageId });
        orderNo = created.order_no;
      }
      await this.dineIn.fire(orderNo, u); // diner orders fire straight to the kitchen
      return this.snapshot(token, claim);
    });
  }

  // per-session throttle for public diner endpoints — keyed off the verified HMAC token (no DB hit)
  private throttle(token: string, action: string, perMinute: number) {
    const c = verifyTableToken(token);
    if (c) rateLimit(`qr:${action}:${c.sessionId}`, perMinute, 60_000);
  }

  private async openOrderForSession(sessionId: number) {
    const dbx = this.db as any;
    const [o] = await dbx.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, sessionId), ne(dineInOrders.status, 'cancelled'), ne(dineInOrders.status, 'closed'))).orderBy(desc(dineInOrders.id)).limit(1);
    return o;
  }

  async requestBill(token: string) {
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => {
      const o = await this.openOrderForSession(claim.sessionId);
      if (!o) throw new BadRequestException({ code: 'NO_OPEN_ORDER', message: 'No order to bill', messageTh: 'ยังไม่มีรายการอาหารให้ชำระ' });
      await this.buffet.applyOvertime(o.orderNo, diner(claim.tenantId)); // buffet: add overtime surcharge if past the window
      return this.dineIn.requestBill(o.orderNo, diner(claim.tenantId));
    });
  }

  // start PromptPay tender (Pending) — returns the QR payload for the diner to scan
  async pay(token: string) {
    this.throttle(token, 'pay', 8);
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => {
      const dbx = this.db as any;
      const o = await this.openOrderForSession(claim.sessionId);
      if (!o) throw new BadRequestException({ code: 'NO_OPEN_ORDER', message: 'No order to pay', messageTh: 'ยังไม่มีรายการให้ชำระ' });
      await this.buffet.applyOvertime(o.orderNo, diner(claim.tenantId)); // buffet: ensure overtime surcharge is on the bill
      const [fresh] = await dbx.select({ total: dineInOrders.total }).from(dineInOrders).where(eq(dineInOrders.id, o.id)).limit(1);
      const total = n(fresh?.total) > 0 ? n(fresh.total) : (await this.dineIn.requestBill(o.orderNo, diner(claim.tenantId))).total;
      if (!(total > 0)) throw new BadRequestException({ code: 'EMPTY_BILL', message: 'Bill is zero', messageTh: 'ยอดบิลเป็นศูนย์' });
      const u = diner(claim.tenantId);
      const saleNo = await (this.dineIn as any).mintSaleNo(claim.tenantId);
      const tender: any = await this.payments.recordTender({ sale_no: saleNo, tenant_id: claim.tenantId, method: 'PromptPay', amount: total, currency: 'THB', gateway: 'promptpay' }, u);
      await dbx.update(tableSessions).set({ status: 'paying', saleNo }).where(eq(tableSessions.id, claim.sessionId));
      await dbx.update(diningTables).set({ status: 'paying', updatedAt: new Date() }).where(eq(diningTables.id, claim.tableId));
      // Render the gateway ref (a real EMVCo PromptPay payload when the tenant has a PromptPay id) as a
      // scannable QR. When a settlement webhook is wired (PROMPTPAY_WEBHOOK_SECRET), the diner pays in
      // their banking app and we settle out-of-band; without it (dev), the UI offers a simulate button.
      const qrImage = tender.gateway_ref ? await QRCode.toDataURL(String(tender.gateway_ref), { margin: 1, width: 320 }) : null;
      return { payment_no: tender.payment_no, status: tender.status, gateway_ref: tender.gateway_ref, qr_payload: tender.qr_payload ?? null, qr_image: qrImage, mock_settle: !webhookSecret(), total };
    });
  }

  // diner-facing poll: tolerates a just-closed session (unlike status()) so the page can show "paid"
  // once an out-of-band PromptPay webhook has settled + closed the table.
  async paymentStatus(token: string) {
    const claim = verifyTableToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
    return this.scope.run(claim.tenantId, async () => {
      const dbx = this.db as any;
      const [session] = await dbx.select().from(tableSessions).where(and(eq(tableSessions.id, claim.sessionId), eq(tableSessions.publicToken, token))).limit(1);
      if (!session) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
      const [o] = await dbx.select({ status: dineInOrders.status, saleNo: dineInOrders.saleNo }).from(dineInOrders).where(and(eq(dineInOrders.sessionId, claim.sessionId), ne(dineInOrders.status, 'cancelled'))).orderBy(desc(dineInOrders.id)).limit(1);
      const settled = ['paid', 'closed'].includes(String(o?.status)) || session.status === 'closed';
      return { session_status: session.status, settled, sale_no: o?.saleNo ?? session.saleNo ?? null };
    });
  }

  // diner taps "confirm" in DEV (mock gateway): settle + finalise. Real deployments use the webhook below.
  async confirm(token: string, paymentNo: string) {
    const { claim, session } = await this.resolve(token);
    return this.scope.run(claim.tenantId, () => this.settleAndFinalize(claim, paymentNo, session));
  }

  // PSP settlement webhook (real PromptPay): the bank/aggregator calls this when the diner has paid.
  // Shared-secret gated + fail-closed in prod (mirrors the channel webhook); idempotent on re-delivery.
  async promptPayWebhook(paymentNo: string, secret?: string) {
    const expected = webhookSecret();
    if (expected) { if (secret !== expected) throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIG', message: 'Invalid webhook signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' }); }
    else if (process.env.NODE_ENV === 'production') throw new UnauthorizedException({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook secret not configured', messageTh: 'ยังไม่ได้ตั้งค่า webhook secret' });
    // controlled bypass: discover which tenant + sale this payment belongs to (reads no tenant-private data)
    const found = await this.scope.bypassQuery(async () => {
      const dbx = this.db as any;
      const [p] = await dbx.select({ tenantId: payments.tenantId, saleNo: payments.saleNo }).from(payments).where(eq(payments.paymentNo, paymentNo)).limit(1);
      return p ? { tenantId: Number(p.tenantId), saleNo: p.saleNo as string | null } : null;
    });
    if (!found) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
    return this.scope.run(found.tenantId, async () => {
      const dbx = this.db as any;
      const [session] = found.saleNo ? await dbx.select().from(tableSessions).where(eq(tableSessions.saleNo, found.saleNo)).limit(1) : [];
      if (!session) { await this.payments.settle(paymentNo, diner(found.tenantId)); return { settled: true, note: 'no live session (already finalised)' }; }
      const claim = { tenantId: found.tenantId, tableId: Number(session.tableId), sessionId: Number(session.id) };
      return this.settleAndFinalize(claim, paymentNo, session);
    });
  }

  // settle the tender → build sale + GL + invoice + close (idempotent). Assumes inside scope.run(tenantId).
  private async settleAndFinalize(claim: { tenantId: number; tableId: number; sessionId: number }, paymentNo: string, sessionRow?: any) {
    const dbx = this.db as any;
    const u = diner(claim.tenantId);
    const settled: any = await this.payments.settle(paymentNo, u); // idempotent (Captured stays Captured)
    const o = await this.openOrderForSession(claim.sessionId);
    const saleNo = sessionRow?.saleNo || o?.saleNo;
    if (!o) {
      // re-delivery after the order already closed → report success without re-posting
      if (saleNo) { const [done] = await dbx.select({ id: dineInOrders.id }).from(dineInOrders).where(eq(dineInOrders.saleNo, saleNo)).limit(1); if (done) return { payment_status: settled.status, sale_no: saleNo, paid: true, already: true }; }
      throw new BadRequestException({ code: 'NO_OPEN_ORDER', message: 'No order', messageTh: 'ไม่พบออเดอร์' });
    }
    if (['paid', 'closed'].includes(String(o.status))) return { payment_status: settled.status, sale_no: saleNo, paid: true, already: true };
    if (!saleNo) throw new BadRequestException({ code: 'NO_SALE', message: 'No provisional sale; call /pay first', messageTh: 'กรุณาเริ่มชำระเงินก่อน' });
    const built = await this.dineIn.buildSale(o, saleNo, 0, u);
    const invNo = await this.dineIn.markPaidAndInvoice(o, saleNo, u);
    return { payment_status: settled.status, sale_no: saleNo, total: built.total, journal_no: built.journal_no, tax_invoice_no: invNo, paid: true };
  }
}

// The PromptPay settlement webhook is enabled (real, out-of-band) when a shared secret is configured.
function webhookSecret(): string | undefined {
  return process.env.PROMPTPAY_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || undefined;
}
