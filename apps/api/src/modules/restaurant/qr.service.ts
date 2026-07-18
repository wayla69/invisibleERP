import { Inject, Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, ne, inArray, desc, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { diningTables, tableSessions, dineInOrders, buffetPackages, payments, qrSettings, posMembers } from '../../database/schema';
import { PaymentService } from '../payments/payments.service';
import { MemberService } from '../loyalty/member.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { RealtimeScope } from './realtime.scope';
import { TableService } from './table.service';
import { DineInService } from './dine-in.service';
import { MenuService } from '../menu/menu.service';
import { BuffetService } from './buffet.service';
import { RecommendationService, type RecommendMode } from './recommendation.service';
import { ServiceRequestService } from './service-request.service';
import { verifyTableToken, verifyRotatingTableToken, type TableClaim } from './qr-token.util';
import { rateLimit } from './rate-limit.util';
import { verifyInboundWebhook } from '../../common/webhook-auth';
import { safeEqualStr } from '../../common/crypto';
import { WebhookIdempotencyService } from '../../common/webhook-idempotency.service';
import type { PublicOrderDto, CreateOrderDto, AddItemsDto } from './dto';

const LIVE: NonNullable<typeof tableSessions.$inferSelect.status>[] = ['open', 'bill_requested', 'paying'];
const diner = (tenantId: number): JwtUser => ({ username: 'diner:qr', role: 'Sales', customerName: null, tenantId, permissions: [] });
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

@Injectable()
export class QrService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly scope: RealtimeScope,
    private readonly tables: TableService,
    private readonly dineIn: DineInService,
    private readonly menuSvc: MenuService,
    private readonly buffet: BuffetService,
    private readonly recommend: RecommendationService,
    private readonly serviceReq: ServiceRequestService,
    private readonly member: MemberService,
    private readonly payments: PaymentService,
    private readonly idem: WebhookIdempotencyService,
  ) {}

  // diner scans the printed QR (stable table token) → mint/join a session, return the per-session token
  async start(qrToken: string) {
    // controlled bypass: discover which tenant the QR belongs to (reads only id + tenant_id + status)
    const resolved = await this.scope.bypassQuery(async () => {
      const dbx = this.db;
      const [t] = await dbx.select({ id: diningTables.id, tenantId: diningTables.tenantId }).from(diningTables).where(eq(diningTables.qrToken, qrToken)).limit(1);
      return t ? { tenantId: Number(t.tenantId), tableId: Number(t.id) } : null;
    });
    if (!resolved) throw new NotFoundException({ code: 'BAD_QR', message: 'Unknown table QR', messageTh: 'ไม่พบโต๊ะของ QR นี้' });
    this.throttleTable(resolved.tenantId, resolved.tableId); // one placard can't open sessions unboundedly (#3)
    return this.scope.run(resolved.tenantId, async () => {
      // Dynamic QR (0434): the printed code only becomes an ordering session while staff have the table
      // OPEN, and dies with the bill. If no live session exists, the scan is refused (staff must seat first)
      // rather than self-opening. Off (default) keeps the legacy diner self-open behaviour.
      if (await this.dynamicMode(resolved.tenantId)) {
        const live = await this.liveSessionForTable(resolved.tableId);
        if (!live) throw new UnauthorizedException({ code: 'QR_TABLE_NOT_OPEN', message: 'Table is not open yet — please ask staff to seat you', messageTh: 'โต๊ะยังไม่เปิด กรุณาให้พนักงานเปิดโต๊ะก่อน' });
      }
      return this.tables.openTable(resolved.tableId, undefined, 'diner:qr', null);
    });
  }

  // per-tenant dynamic-QR flag (0434). Assumes we are inside scope.run(tenantId) (RLS-scoped).
  private async dynamicMode(tenantId: number): Promise<boolean> {
    const [row] = await this.db.select({ v: qrSettings.dynamicMode }).from(qrSettings).where(eq(qrSettings.tenantId, tenantId)).limit(1);
    return row?.v === true;
  }

  // the current live session on a table (RLS-scoped) — used to gate the dynamic-QR join.
  private async liveSessionForTable(tableId: number) {
    const [s] = await this.db.select({ id: tableSessions.id }).from(tableSessions).where(and(eq(tableSessions.tableId, tableId), inArray(tableSessions.status, LIVE))).orderBy(desc(tableSessions.id)).limit(1);
    return s ?? null;
  }

  // Presence-bound entry (#3): a per-table display shows a SHORT-TTL rotating token `HMAC(tenant:table:window)`
  // instead of a permanent printed code — a photographed code expires within ~a minute. Additive; the stable
  // printed-token start() above is unchanged for static placards.
  async startRotating(token: string) {
    const claim = verifyRotatingTableToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'QR_EXPIRED', message: 'QR expired or invalid — please rescan', messageTh: 'QR หมดอายุหรือไม่ถูกต้อง กรุณาสแกนใหม่' });
    this.throttleTable(claim.tenantId, claim.tableId);
    return this.scope.run(claim.tenantId, async () => {
      if (await this.dynamicMode(claim.tenantId)) {
        const live = await this.liveSessionForTable(claim.tableId);
        if (!live) throw new UnauthorizedException({ code: 'QR_TABLE_NOT_OPEN', message: 'Table is not open yet — please ask staff to seat you', messageTh: 'โต๊ะยังไม่เปิด กรุณาให้พนักงานเปิดโต๊ะก่อน' });
      }
      return this.tables.openTable(claim.tableId, undefined, 'diner:qr', null);
    });
  }

  // Per-(tenant, table) start throttle (#3): a single compromised/leaked QR can't exceed a human rate of
  // opening sessions from one instance. Best-effort in-process (pairs with the edge per-IP 'qr' bucket).
  private throttleTable(tenantId: number, tableId: number) {
    rateLimit(`qr:start:${tenantId}:${tableId}`, Number(process.env.QR_START_PER_MIN_PER_TABLE ?? 20), 60_000);
  }

  // verify HMAC + live session (under RLS) → claim. Throws 401 on forged/closed token.
  private async resolve(token: string): Promise<{ claim: TableClaim; session: any; table: any }> {
    const claim = verifyTableToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
    return this.scope.run(claim.tenantId, async () => {
      const dbx = this.db;
      const [session] = await dbx.select().from(tableSessions).where(and(eq(tableSessions.id, claim.sessionId), eq(tableSessions.publicToken, token), eq(tableSessions.tableId, claim.tableId), inArray(tableSessions.status, LIVE))).limit(1);
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
    const dbx = this.db;
    const [session] = await dbx.select().from(tableSessions).where(and(eq(tableSessions.id, claim.sessionId), eq(tableSessions.publicToken, token), inArray(tableSessions.status, LIVE))).limit(1);
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
    const [mem] = session.memberId ? await dbx.select({ name: posMembers.name, code: posMembers.memberCode }).from(posMembers).where(eq(posMembers.id, Number(session.memberId))).limit(1) : [];
    return {
      table_no: table?.tableNo ?? null, session_status: session.status, order_mode: session.orderMode, buffet,
      member: mem ? { name: mem.name, member_code: mem.code } : null,
      order: order ? { order_no: order.order_no, status: order.status, waited_min: order.waited_min, ready_in_min: order.ready_in_min, items: order.items } : null,
      bill: order ? { subtotal: order.subtotal, vat: order.vat, total: order.total, settled: session.status === 'closed' } : null,
    };
  }

  private async loadSession(sessionId: number) {
    const dbx = this.db;
    const [s] = await dbx.select().from(tableSessions).where(eq(tableSessions.id, sessionId)).limit(1);
    return s;
  }

  // sum of the sale-money captured against a sale so far (split pay-your-share, F2) — excludes tips.
  private async capturedForSale(saleNo: string): Promise<number> {
    const [row] = await this.db.select({ v: sql<string>`coalesce(sum(${payments.amount}),0)` }).from(payments)
      .where(and(eq(payments.saleNo, saleNo), eq(payments.status, 'Captured')));
    return round2(n(row?.v));
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

  // diner pulls the menu to order from — full catalog with modifier groups inlined, scoped to the table's
  // tenant. The tenant's recommend_mode decides the "เมนูแนะนำ" set: manual flags, or a dynamic set
  // (member behaviour / popular+low-cost) computed by the recommendation engine and applied here (0435).
  async menu(token: string) {
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => {
      const cfg = await this.getSettings(claim.tenantId);
      const recommendedSkus = await this.recommend.recommendedSkus(cfg.recommend_mode as RecommendMode, cfg.recommend_count);
      return this.menuSvc.listMenuForOrder(diner(claim.tenantId), { recommendedSkus });
    });
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
        await this.dineIn.addItems(existing.orderNo, { items: dto.items as AddItemsDto['items'] }, u, { buffet, buffetPackageId });
        orderNo = existing.orderNo;
      } else {
        const created = await this.dineIn.createOrder({ table_id: claim.tableId, session_id: claim.sessionId, items: dto.items as CreateOrderDto['items'] }, u, { buffet, buffetPackageId });
        orderNo = created.order_no;
      }
      // Staff-fire gate (#3): when the tenant requires it, a diner's QR order is PARKED, not auto-fired —
      // floor staff release it (existing POST /api/restaurant/orders/:orderNo/fire), so an injected/spam
      // order is a queue item a human clears, not an unbounded kitchen/inventory event. Default: auto-fire.
      const requireStaffFire = await this.requiresStaffFire(claim.tenantId);
      if (requireStaffFire) return { ...(await this.snapshot(token, claim)), pending_fire: true };
      await this.dineIn.fire(orderNo, u); // diner orders fire straight to the kitchen
      return this.snapshot(token, claim);
    });
  }

  // Per-tenant QR settings (#3). Assumes we are inside scope.run(tenantId) (RLS-scoped read).
  private async requiresStaffFire(_tenantId: number): Promise<boolean> {
    const [row] = await this.db.select({ v: qrSettings.requireStaffFire }).from(qrSettings).limit(1);
    return row?.v === true;
  }

  async getSettings(tenantId: number): Promise<{ require_staff_fire: boolean; dynamic_mode: boolean; auto_close_on_paid: boolean; recommend_mode: RecommendMode; recommend_count: number }> {
    const [row] = await this.db.select({ v: qrSettings.requireStaffFire, dm: qrSettings.dynamicMode, ac: qrSettings.autoCloseOnPaid, rm: qrSettings.recommendMode, rc: qrSettings.recommendCount }).from(qrSettings).where(eq(qrSettings.tenantId, tenantId)).limit(1);
    return {
      require_staff_fire: row?.v === true, dynamic_mode: row?.dm === true, auto_close_on_paid: row?.ac === true,
      recommend_mode: (row?.rm as RecommendMode) ?? 'manual', recommend_count: row?.rc ?? 6,
    };
  }

  // Partial update: only the provided fields change; absent ones keep their stored value (defaults on first write).
  async setSettings(tenantId: number, patch: { require_staff_fire?: boolean; dynamic_mode?: boolean; auto_close_on_paid?: boolean; recommend_mode?: RecommendMode; recommend_count?: number }, actor: string) {
    const cur = await this.getSettings(tenantId);
    const next = {
      requireStaffFire: patch.require_staff_fire ?? cur.require_staff_fire,
      dynamicMode: patch.dynamic_mode ?? cur.dynamic_mode,
      autoCloseOnPaid: patch.auto_close_on_paid ?? cur.auto_close_on_paid,
      recommendMode: patch.recommend_mode ?? cur.recommend_mode,
      recommendCount: patch.recommend_count ?? cur.recommend_count,
    };
    await this.db.insert(qrSettings)
      .values({ tenantId, ...next, updatedBy: actor, updatedAt: new Date() })
      .onConflictDoUpdate({ target: qrSettings.tenantId, set: { ...next, updatedBy: actor, updatedAt: new Date() } });
    return { require_staff_fire: next.requireStaffFire, dynamic_mode: next.dynamicMode, auto_close_on_paid: next.autoCloseOnPaid, recommend_mode: next.recommendMode, recommend_count: next.recommendCount };
  }

  // per-session throttle for public diner endpoints — keyed off the verified HMAC token (no DB hit)
  private throttle(token: string, action: string, perMinute: number) {
    const c = verifyTableToken(token);
    if (c) rateLimit(`qr:${action}:${c.sessionId}`, perMinute, 60_000);
  }

  private async openOrderForSession(sessionId: number) {
    const dbx = this.db;
    const [o] = await dbx.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, sessionId), ne(dineInOrders.status, 'cancelled'), ne(dineInOrders.status, 'closed'))).orderBy(desc(dineInOrders.id)).limit(1);
    return o;
  }

  // "สั่งคู่กับ…" upsell (F6): given the diner's current basket SKUs, return the SKUs most often ordered
  // alongside them (co-purchase). The diner UI already has the menu, so we return SKUs it renders itself.
  async suggestions(token: string, skus: string[]) {
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => ({ skus: await this.recommend.coPurchase(skus ?? [], 4) }));
  }

  // diner links a loyalty member to the table (F3): enter a member code or phone → the session carries the
  // member so the QR-settled sale earns points. Idempotent (re-link overwrites). Returns the member name.
  async linkMember(token: string, codeOrPhone: string) {
    this.throttle(token, 'member', 8);
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => {
      const u = diner(claim.tenantId);
      const q = /^\d{9,10}$/.test(codeOrPhone.trim()) ? { phone: codeOrPhone.trim() } : { code: codeOrPhone.trim() };
      let m: any;
      try { m = await this.member.lookup(q, u); } catch { m = null; }
      if (!m?.id) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
      await this.db.update(tableSessions).set({ memberId: Number(m.id) }).where(eq(tableSessions.id, claim.sessionId));
      const existing = await this.openOrderForSession(claim.sessionId);
      if (existing) await this.db.update(dineInOrders).set({ memberId: Number(m.id) }).where(eq(dineInOrders.id, existing.id));
      return { member_id: Number(m.id), member_code: m.member_code ?? null, name: m.name ?? null };
    });
  }

  // diner taps เรียกพนักงาน / ขอน้ำ / ขอช้อนส้อม / ขอบิล — raise a service request to the floor board (F1)
  async call(token: string, type: string, note?: string) {
    this.throttle(token, 'call', 10);   // anti-abuse: cap service-call bursts per session
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, () => this.serviceReq.create(claim, type, note));
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
      const dbx = this.db;
      const o = await this.openOrderForSession(claim.sessionId);
      if (!o) throw new BadRequestException({ code: 'NO_OPEN_ORDER', message: 'No order to pay', messageTh: 'ยังไม่มีรายการให้ชำระ' });
      await this.buffet.applyOvertime(o.orderNo, diner(claim.tenantId)); // buffet: ensure overtime surcharge is on the bill
      const [fresh] = await dbx.select({ total: dineInOrders.total }).from(dineInOrders).where(eq(dineInOrders.id, o.id)).limit(1);
      const total = n(fresh?.total) > 0 ? n(fresh!.total) : (await this.dineIn.requestBill(o.orderNo, diner(claim.tenantId))).total;
      if (!(total > 0)) throw new BadRequestException({ code: 'EMPTY_BILL', message: 'Bill is zero', messageTh: 'ยอดบิลเป็นศูนย์' });
      const u = diner(claim.tenantId);
      const saleNo = await this.dineIn.mintSaleNo(claim.tenantId);
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

  // Split pay-your-share (F2): pay ONE share of the bill via PromptPay. Multiple diners each call this;
  // shares tender against the SAME sale and the order finalises only once the captured total covers the
  // bill (coverage-aware settle below). `amount` omitted ⇒ pay the whole remaining balance.
  async payShare(token: string, amount?: number) {
    this.throttle(token, 'pay', 12);
    const { claim } = await this.resolve(token);
    return this.scope.run(claim.tenantId, async () => {
      const dbx = this.db;
      const u = diner(claim.tenantId);
      const o = await this.openOrderForSession(claim.sessionId);
      if (!o) throw new BadRequestException({ code: 'NO_OPEN_ORDER', message: 'No order to pay', messageTh: 'ยังไม่มีรายการให้ชำระ' });
      await this.buffet.applyOvertime(o.orderNo, u);
      const [fresh] = await dbx.select({ total: dineInOrders.total }).from(dineInOrders).where(eq(dineInOrders.id, o.id)).limit(1);
      const total = n(fresh?.total) > 0 ? n(fresh!.total) : (await this.dineIn.requestBill(o.orderNo, u)).total;
      if (!(total > 0)) throw new BadRequestException({ code: 'EMPTY_BILL', message: 'Bill is zero', messageTh: 'ยอดบิลเป็นศูนย์' });
      const session = await this.loadSession(claim.sessionId);
      const saleNo = session?.saleNo || o.saleNo || await this.dineIn.mintSaleNo(claim.tenantId);
      const paid = await this.capturedForSale(saleNo);
      const remaining = round2(total - paid);
      if (remaining <= 0) return { fully_paid: true, total, paid_so_far: paid, remaining: 0 };
      const share = round2(Math.min(n(amount) > 0 ? n(amount) : remaining, remaining));
      if (!(share > 0)) throw new BadRequestException({ code: 'EMPTY_BILL', message: 'Nothing left to pay', messageTh: 'ไม่มียอดค้างชำระ' });
      const tender: any = await this.payments.recordTender({ sale_no: saleNo, tenant_id: claim.tenantId, method: 'PromptPay', amount: share, currency: 'THB', gateway: 'promptpay' }, u);
      await dbx.update(tableSessions).set({ status: 'paying', saleNo }).where(eq(tableSessions.id, claim.sessionId));
      await dbx.update(diningTables).set({ status: 'paying', updatedAt: new Date() }).where(eq(diningTables.id, claim.tableId));
      const qrImage = tender.gateway_ref ? await QRCode.toDataURL(String(tender.gateway_ref), { margin: 1, width: 320 }) : null;
      return { payment_no: tender.payment_no, status: tender.status, gateway_ref: tender.gateway_ref, qr_image: qrImage, mock_settle: !webhookSecret(), total, share, paid_so_far: paid, remaining };
    });
  }

  // split progress for the diner UI — tolerates a just-closed session (like paymentStatus) so it can show
  // "fully paid" after the final share finalises + closes the table.
  async splitStatus(token: string) {
    const claim = verifyTableToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
    return this.scope.run(claim.tenantId, async () => {
      const dbx = this.db;
      const [session] = await dbx.select().from(tableSessions).where(and(eq(tableSessions.id, claim.sessionId), eq(tableSessions.publicToken, token))).limit(1);
      if (!session) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
      const [o] = await dbx.select({ total: dineInOrders.total, status: dineInOrders.status, saleNo: dineInOrders.saleNo }).from(dineInOrders).where(and(eq(dineInOrders.sessionId, claim.sessionId), ne(dineInOrders.status, 'cancelled'))).orderBy(desc(dineInOrders.id)).limit(1);
      const saleNo = session.saleNo || o?.saleNo || undefined;
      const total = o ? n(o.total) : 0;
      const settled = session.status === 'closed' || ['paid', 'closed'].includes(String(o?.status));
      const paid = saleNo ? await this.capturedForSale(saleNo) : 0;
      return { total: round2(total), paid_so_far: round2(paid), remaining: settled ? 0 : round2(Math.max(0, total - paid)), settled };
    });
  }

  // diner-facing poll: tolerates a just-closed session (unlike status()) so the page can show "paid"
  // once an out-of-band PromptPay webhook has settled + closed the table.
  async paymentStatus(token: string) {
    const claim = verifyTableToken(token);
    if (!claim) throw new UnauthorizedException({ code: 'BAD_TOKEN', message: 'Invalid table token', messageTh: 'โทเคนโต๊ะไม่ถูกต้อง' });
    return this.scope.run(claim.tenantId, async () => {
      const dbx = this.db;
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
  // Auth (SOX-ICFR #5): additive HMAC-over-rawBody with a replay window when a PROMPTPAY_WEBHOOK_HMAC_SECRET
  // is configured (mirrors the L-1/L-2 additive pattern), else the legacy static shared secret — now
  // compared CONSTANT-TIME (was a plain `!==`, a timing side-channel). Fail-closed in prod when neither is
  // set. Replay is then blocked hard by a (source, tenant:payment_no) idempotency claim below, so a
  // redelivery within the window can never double-settle / double-post.
  async promptPayWebhook(paymentNo: string, opts: { secret?: string; rawBody?: Buffer | string; signature?: string; timestamp?: string } = {}) {
    const hmac = webhookHmacSecret();
    if (hmac) {
      const res = verifyInboundWebhook({
        rawBody: opts.rawBody, hmacSecret: hmac, signature: opts.signature, timestamp: opts.timestamp,
        toleranceSec: Number(process.env.PROMPTPAY_WEBHOOK_TOLERANCE_SEC ?? process.env.PSP_WEBHOOK_TOLERANCE_SEC ?? 300),
      });
      if (res === 'stale') throw new UnauthorizedException({ code: 'WEBHOOK_STALE', message: 'Webhook timestamp outside the replay window', messageTh: 'เวลาของ webhook อยู่นอกช่วงที่อนุญาต' });
      if (res !== 'ok') throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIG', message: 'Invalid webhook signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' });
    } else {
      const expected = webhookSecret();
      if (expected) { if (!opts.secret || !safeEqualStr(opts.secret, expected)) throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIG', message: 'Invalid webhook signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' }); }
      else if (process.env.NODE_ENV === 'production') throw new UnauthorizedException({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook secret not configured', messageTh: 'ยังไม่ได้ตั้งค่า webhook secret' });
    }
    // controlled bypass: discover which tenant + sale this payment belongs to (reads no tenant-private data)
    const found = await this.scope.bypassQuery(async () => {
      const dbx = this.db;
      const [p] = await dbx.select({ tenantId: payments.tenantId, saleNo: payments.saleNo }).from(payments).where(eq(payments.paymentNo, paymentNo)).limit(1);
      return p ? { tenantId: Number(p.tenantId), saleNo: p.saleNo as string | null } : null;
    });
    if (!found) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
    return this.scope.run(found.tenantId, async () => {
      // Replay guard — single-shot per (tenant, payment). A redelivery acks as a duplicate without
      // re-settling; the claim rides this tenant tx, so a processing failure rolls it back for a clean retry.
      if ((await this.idem.claim('promptpay', `${found.tenantId}:${paymentNo}`, found.tenantId)) === 'duplicate')
        return { settled: true, note: 'duplicate_event', payment_no: paymentNo };
      const dbx = this.db;
      const [session] = found.saleNo ? await dbx.select().from(tableSessions).where(eq(tableSessions.saleNo, found.saleNo)).limit(1) : [];
      if (!session) { await this.payments.settle(paymentNo, diner(found.tenantId)); return { settled: true, note: 'no live session (already finalised)' }; }
      const claim = { tenantId: found.tenantId, tableId: Number(session.tableId), sessionId: Number(session.id) };
      return this.settleAndFinalize(claim, paymentNo, session);
    });
  }

  // settle the tender → build sale + GL + invoice + close (idempotent). Assumes inside scope.run(tenantId).
  private async settleAndFinalize(claim: { tenantId: number; tableId: number; sessionId: number }, paymentNo: string, sessionRow?: any) {
    const dbx = this.db;
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
    // Split pay-your-share (F2): finalise ONLY once the captured tenders cover the bill. A single full-amount
    // pay() tenders the whole total, so this is transparent for the non-split flow (captured == total → finalise).
    const total = n(o.total);
    const captured = await this.capturedForSale(saleNo);
    if (captured + 0.01 < total) return { payment_status: settled.status, sale_no: saleNo, paid: false, total: round2(total), paid_so_far: captured, remaining: round2(total - captured) };
    // F3: earn loyalty points for the member linked to this table session (no GL footprint — points sub-ledger).
    const memberId = sessionRow?.memberId ?? (await this.loadSession(claim.sessionId))?.memberId ?? o?.memberId;
    const built = await this.dineIn.buildSale(o, saleNo, 0, u, memberId ? { memberId: Number(memberId) } : undefined);
    const invNo = await this.dineIn.markPaidAndInvoice(o, saleNo, u);
    return { payment_status: settled.status, sale_no: saleNo, total: built.total, journal_no: built.journal_no, tax_invoice_no: invNo, paid: true };
  }
}

// The PromptPay settlement webhook is enabled (real, out-of-band) when a shared secret is configured.
function webhookSecret(): string | undefined {
  return process.env.PROMPTPAY_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || undefined;
}

// Optional HMAC signing secret (SOX-ICFR #5). When set, an HMAC-SHA256 signature over the raw body (with a
// replay-window timestamp) REPLACES the static-secret check — proving possession AND binding to the exact
// payload. Unset = legacy static shared secret (back-compat).
function webhookHmacSecret(): string | undefined {
  return process.env.PROMPTPAY_WEBHOOK_HMAC_SECRET || process.env.PAYMENT_WEBHOOK_HMAC_SECRET || undefined;
}
