import { Inject, Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { channelAdapters, channelWebhookEvents, dineInOrders, dineInOrderItems, menuItems } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { RealtimeScope } from '../restaurant/realtime.scope';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { normalizeAggregatorPayload } from './mappers';
import { getPlatformProvider } from './providers';
import { safeEqualStr } from '../../common/crypto';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const PLATFORMS = ['grab', 'lineman', 'foodpanda', 'robinhood'];
// orderChannelEnum has grab|lineman but not foodpanda/robinhood → those map to 'web' (extSource keeps the real name).
const channelOf = (p: string) => (p === 'grab' || p === 'lineman' ? p : 'web');

// P2b — delivery-aggregator adapters over the existing channel base (dineInOrders.extSource/extOrderId +
// channelWebhookEvents idempotency). Real platform APIs plug into mappers + (mock) callbacks; menu sync-out
// + status round-trip are simulated until per-platform creds exist.
@Injectable()
export class ChannelAdapterService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService, private readonly scope: RealtimeScope) {}

  async listAdapters() {
    const db = this.db as any;
    const rows = await db.select().from(channelAdapters).orderBy(desc(channelAdapters.id));
    return { adapters: rows.map((r: any) => ({ id: r.id, platform: r.platform, store_ref: r.storeRef, enabled: r.enabled, auto_accept: r.autoAccept })), count: rows.length };
  }
  async upsertAdapter(dto: { id?: number; platform: string; store_ref?: string; enabled?: boolean; auto_accept?: boolean; config?: any }, user: JwtUser) {
    if (!PLATFORMS.includes(dto.platform)) throw new BadRequestException({ code: 'BAD_PLATFORM', message: `Unknown platform ${dto.platform}`, messageTh: 'แพลตฟอร์มไม่ถูกต้อง' });
    const db = this.db as any;
    const vals = { tenantId: user.tenantId ?? null, platform: dto.platform, storeRef: dto.store_ref ?? null, enabled: dto.enabled ?? true, autoAccept: dto.auto_accept ?? true, config: dto.config ?? null };
    if (dto.id) { await db.update(channelAdapters).set(vals).where(eq(channelAdapters.id, dto.id)); return { id: dto.id, updated: true }; }
    const [r] = await db.insert(channelAdapters).values({ ...vals, createdBy: user.username }).returning({ id: channelAdapters.id });
    return { id: r.id, created: true };
  }

  // Push the available menu to the platform via its outbound provider (real HTTP when configured, else mock).
  async menuSyncOut(platform: string, user: JwtUser) {
    if (!PLATFORMS.includes(platform)) throw new BadRequestException({ code: 'BAD_PLATFORM', message: `Unknown platform ${platform}`, messageTh: 'แพลตฟอร์มไม่ถูกต้อง' });
    const db = this.db as any;
    const rows = await db.select().from(menuItems).where(and(eq(menuItems.isAvailable, true), eq(menuItems.active, true)));
    const items = rows.map((r: any) => ({ sku: r.sku, name: r.name, price: n(r.price), available: r.isAvailable }));
    const [adapter] = await db.select().from(channelAdapters).where(eq(channelAdapters.platform, platform)).limit(1);
    void user;
    const provider = getPlatformProvider(platform);
    const res = await provider.pushMenu(adapter?.storeRef ?? null, items);
    return { platform, items, count: items.length, pushed: res.ok, provider: provider.name, ref: res.ref ?? null, error: res.error ?? null };
  }

  // Inbound order webhook — PUBLIC, authenticated by a per-platform shared secret (store_ref is a public,
  // enumerable slug → NOT an auth factor). Tenant resolved from the adapter via a controlled bypass read,
  // then ALL writes run RLS-scoped under scope.run(tenantId). Idempotent on ext_event_id.
  async ingestWebhook(platform: string, payload: any, secret?: string) {
    if (!PLATFORMS.includes(platform)) throw new BadRequestException({ code: 'BAD_PLATFORM', message: `Unknown platform ${platform}`, messageTh: 'แพลตฟอร์มไม่ถูกต้อง' });
    // Authenticate: per-platform shared secret, fail-CLOSED in production (a missing config rejects);
    // lenient only in dev/test so mock/local flows work — mirrors the restaurant aggregator webhook.
    const expected = process.env[`WEBHOOK_SECRET_${platform.toUpperCase()}`] || process.env.CHANNEL_WEBHOOK_SECRET;
    if (expected) { if (!secret || !safeEqualStr(secret, expected)) throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIG', message: 'Invalid webhook signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' }); }
    else if (process.env.NODE_ENV === 'production') throw new UnauthorizedException({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook secret not configured', messageTh: 'ยังไม่ได้ตั้งค่า webhook secret' });

    const norm = normalizeAggregatorPayload(platform, payload);

    // resolve tenant from the registered adapter (store_ref) via a controlled bypass read (no user → RLS
    // would otherwise see nothing); reads only the adapter row to discover which tenant owns the store.
    const adapter = await this.scope.bypassQuery(async () => {
      const db = this.db as any;
      const [a] = await db.select().from(channelAdapters).where(and(eq(channelAdapters.platform, platform), norm.storeRef ? eq(channelAdapters.storeRef, norm.storeRef) : eq(channelAdapters.enabled, true))).limit(1);
      return a ?? null;
    });
    if (!adapter) throw new NotFoundException({ code: 'NO_ADAPTER', message: `No ${platform} adapter for store ${norm.storeRef ?? ''}`, messageTh: 'ไม่พบการตั้งค่าช่องทาง' });
    const tenantId = Number(adapter.tenantId);

    // everything else RLS-scoped to the resolved tenant (bypass OFF) — a forged store_ref cannot write
    // into another tenant because the inserts run under that tenant's RLS policy.
    return this.scope.run(tenantId, async () => {
      const db = this.db as any;
      // idempotency: same ext_event_id already processed?
      if (norm.extEventId) {
        const [seen] = await db.select().from(channelWebhookEvents).where(and(eq(channelWebhookEvents.source, platform), eq(channelWebhookEvents.extEventId, norm.extEventId))).limit(1);
        if (seen) return { status: 'duplicate', order_no: seen.orderNo ?? null };
      }
      // dedup on partner order id too
      if (norm.extOrderId) {
        const [dupOrder] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.extSource, platform), eq(dineInOrders.extOrderId, norm.extOrderId))).limit(1);
        if (dupOrder) { await this.logEvent(tenantId, platform, norm, dupOrder.orderNo, 'duplicate'); return { status: 'duplicate', order_no: dupOrder.orderNo }; }
      }

      const orderNo = await this.docNo.nextDaily('DIN');
      const subtotal = round2(norm.lines.reduce((a, l) => a + l.qty * l.unit_price, 0));
      await db.transaction(async (tx: any) => {
        const [ord] = await tx.insert(dineInOrders).values({
          orderNo, tenantId, status: adapter.autoAccept ? 'sent_to_kitchen' : 'open',
          channel: channelOf(platform), fulfillmentType: 'delivery', fulfillmentStatus: adapter.autoAccept ? 'accepted' : 'received',
          extSource: platform, extOrderId: norm.extOrderId ?? null, deliveryFee: String(norm.deliveryFee ?? 0),
          subtotal: String(subtotal), total: String(round2(subtotal + (norm.deliveryFee ?? 0))), notes: norm.customerName ? `aggregator: ${norm.customerName}` : `aggregator ${platform}`,
          createdBy: `channel:${platform}`,
        }).returning({ id: dineInOrders.id });
        for (const l of norm.lines)
          await tx.insert(dineInOrderItems).values({ tenantId, orderId: ord.id, name: l.name, qty: String(l.qty), unitPrice: String(l.unit_price), amount: String(round2(l.qty * l.unit_price)), kdsStatus: adapter.autoAccept ? 'queued' : 'new', createdBy: `channel:${platform}` });
      });
      await this.logEvent(tenantId, platform, norm, orderNo, 'processed');
      return { status: 'processed', order_no: orderNo, lines: norm.lines.length, subtotal };
    });
  }

  // Caller is already inside scope.run(tenantId) — write the event with the resolved tenant.
  private async logEvent(tenantId: number | null, platform: string, norm: any, orderNo: string | null, status: string) {
    const db = this.db as any;
    const extEventId = norm.extEventId ?? (norm.extOrderId ? `ord-${norm.extOrderId}` : `evt-${orderNo ?? 'na'}`);
    await db.insert(channelWebhookEvents).values({ tenantId, source: platform, extEventId, extOrderId: norm.extOrderId ?? null, orderNo, payload: norm.raw ?? {}, status }).catch(() => { /* best-effort log */ });
  }

  // Status callback — update local fulfilment, then post the new status back to the platform.
  async updateStatus(orderNo: string, status: string) {
    const db = this.db as any;
    const [ord] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).limit(1);
    if (!ord) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    await db.update(dineInOrders).set({ fulfillmentStatus: status }).where(eq(dineInOrders.id, ord.id));
    const res = ord.extSource ? await getPlatformProvider(ord.extSource).updateStatus(ord.extOrderId, status) : { ok: false };
    return { order_no: orderNo, fulfillment_status: status, posted_to_platform: ord.extSource ?? null, post_ok: res.ok, post_ref: (res as any).ref ?? null };
  }

  // Accept a received (not auto-accepted) aggregator order: confirm to the platform, then route its lines
  // to the KDS (sent_to_kitchen / queued). Reject does the inverse and cancels the order.
  async acceptOrder(orderNo: string) { return this.decide(orderNo, true, ''); }
  async rejectOrder(orderNo: string, reason: string) { return this.decide(orderNo, false, reason); }

  private async decide(orderNo: string, accept: boolean, reason: string) {
    const db = this.db as any;
    const [ord] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).limit(1);
    if (!ord) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    if (!ord.extSource) throw new BadRequestException({ code: 'NOT_CHANNEL_ORDER', message: 'Not an aggregator order', messageTh: 'ไม่ใช่ออเดอร์จากแพลตฟอร์ม' });
    const provider = getPlatformProvider(ord.extSource);
    const res = accept ? await provider.acceptOrder(ord.extOrderId) : await provider.rejectOrder(ord.extOrderId, reason);
    await db.transaction(async (tx: any) => {
      if (accept) {
        await tx.update(dineInOrders).set({ status: 'sent_to_kitchen', fulfillmentStatus: 'accepted' }).where(eq(dineInOrders.id, ord.id));
        await tx.update(dineInOrderItems).set({ kdsStatus: 'queued' }).where(and(eq(dineInOrderItems.orderId, ord.id), eq(dineInOrderItems.kdsStatus, 'new')));
      } else {
        await tx.update(dineInOrders).set({ status: 'cancelled', fulfillmentStatus: 'rejected', notes: reason ? `rejected: ${reason}` : 'rejected' }).where(eq(dineInOrders.id, ord.id));
      }
    });
    return { order_no: orderNo, fulfillment_status: accept ? 'accepted' : 'rejected', routed_to_kds: accept, posted_to_platform: ord.extSource, post_ok: res.ok };
  }

  async listChannelOrders(limit = 50) {
    const db = this.db as any;
    const rows = await db.select().from(dineInOrders).where(eq(dineInOrders.fulfillmentType, 'delivery')).orderBy(desc(dineInOrders.id)).limit(limit);
    return { orders: rows.map((r: any) => ({ order_no: r.orderNo, platform: r.extSource, ext_order_id: r.extOrderId, status: r.status, fulfillment_status: r.fulfillmentStatus, total: n(r.total) })), count: rows.length };
  }
}
