import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { channelAdapters, channelWebhookEvents, dineInOrders, dineInOrderItems, menuItems } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { normalizeAggregatorPayload } from './mappers';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const PLATFORMS = ['grab', 'lineman', 'foodpanda', 'robinhood'];
// orderChannelEnum has grab|lineman but not foodpanda/robinhood → those map to 'web' (extSource keeps the real name).
const channelOf = (p: string) => (p === 'grab' || p === 'lineman' ? p : 'web');

// P2b — delivery-aggregator adapters over the existing channel base (dineInOrders.extSource/extOrderId +
// channelWebhookEvents idempotency). Real platform APIs plug into mappers + (mock) callbacks; menu sync-out
// + status round-trip are simulated until per-platform creds exist.
@Injectable()
export class ChannelAdapterService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

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

  // Menu that would be pushed to the platform (only available items).
  async menuSyncOut(platform: string, user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(menuItems).where(and(eq(menuItems.isAvailable, true), eq(menuItems.active, true)));
    void user;
    return { platform, items: rows.map((r: any) => ({ sku: r.sku, name: r.name, price: n(r.price), available: r.isAvailable })), count: rows.length, pushed: true };
  }

  // Inbound order webhook — PUBLIC. Idempotent on ext_event_id; tenant resolved from the adapter's store_ref.
  async ingestWebhook(platform: string, payload: any) {
    if (!PLATFORMS.includes(platform)) throw new BadRequestException({ code: 'BAD_PLATFORM', message: `Unknown platform ${platform}`, messageTh: 'แพลตฟอร์มไม่ถูกต้อง' });
    const norm = normalizeAggregatorPayload(platform, payload);
    const db = this.db as any;

    // idempotency: same ext_event_id already processed?
    if (norm.extEventId) {
      const [seen] = await db.select().from(channelWebhookEvents).where(and(eq(channelWebhookEvents.source, platform), eq(channelWebhookEvents.extEventId, norm.extEventId))).limit(1);
      if (seen) return { status: 'duplicate', order_no: seen.orderNo ?? null };
    }
    // resolve tenant from the registered adapter (store_ref)
    const [adapter] = await db.select().from(channelAdapters).where(and(eq(channelAdapters.platform, platform), norm.storeRef ? eq(channelAdapters.storeRef, norm.storeRef) : eq(channelAdapters.enabled, true))).limit(1);
    if (!adapter) throw new NotFoundException({ code: 'NO_ADAPTER', message: `No ${platform} adapter for store ${norm.storeRef ?? ''}`, messageTh: 'ไม่พบการตั้งค่าช่องทาง' });
    const tenantId = adapter.tenantId;

    // dedup on partner order id too
    if (norm.extOrderId) {
      const [dupOrder] = await db.select().from(dineInOrders).where(and(eq(dineInOrders.extSource, platform), eq(dineInOrders.extOrderId, norm.extOrderId))).limit(1);
      if (dupOrder) { await this.logEvent(platform, norm, dupOrder.orderNo, 'duplicate'); return { status: 'duplicate', order_no: dupOrder.orderNo }; }
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
    await this.logEvent(platform, norm, orderNo, 'processed');
    return { status: 'processed', order_no: orderNo, lines: norm.lines.length, subtotal };
  }

  private async logEvent(platform: string, norm: any, orderNo: string | null, status: string) {
    const db = this.db as any;
    const [adapter] = await db.select().from(channelAdapters).where(eq(channelAdapters.platform, platform)).limit(1);
    const extEventId = norm.extEventId ?? (norm.extOrderId ? `ord-${norm.extOrderId}` : `evt-${orderNo ?? 'na'}`);
    await db.insert(channelWebhookEvents).values({ tenantId: adapter?.tenantId ?? null, source: platform, extEventId, extOrderId: norm.extOrderId ?? null, orderNo, payload: norm.raw ?? {}, status }).catch(() => { /* best-effort log */ });
  }

  // Status callback — update fulfilment + (mock) post back to the platform.
  async updateStatus(orderNo: string, status: string) {
    const db = this.db as any;
    const [ord] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, orderNo)).limit(1);
    if (!ord) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบออเดอร์' });
    await db.update(dineInOrders).set({ fulfillmentStatus: status }).where(eq(dineInOrders.id, ord.id));
    return { order_no: orderNo, fulfillment_status: status, posted_to_platform: ord.extSource ?? null };
  }

  async listChannelOrders(limit = 50) {
    const db = this.db as any;
    const rows = await db.select().from(dineInOrders).where(eq(dineInOrders.fulfillmentType, 'delivery')).orderBy(desc(dineInOrders.id)).limit(limit);
    return { orders: rows.map((r: any) => ({ order_no: r.orderNo, platform: r.extSource, ext_order_id: r.extOrderId, status: r.status, fulfillment_status: r.fulfillmentStatus, total: n(r.total) })), count: rows.length };
  }
}
