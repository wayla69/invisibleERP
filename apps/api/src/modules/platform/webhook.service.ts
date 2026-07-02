import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes, createHmac } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { webhooks, webhookDeliveries, users } from '../../database/schema';
import { encrypt, decrypt } from '../../common/crypto';
import { assertPublicUrl, isPublicUrl } from '../../common/net-guard';
import type { JwtUser } from '../../common/decorators';

// Allow plain http webhook targets only in dev/test (local receivers); production is https-only.
const ALLOW_HTTP = process.env.NODE_ENV !== 'production';
import { AutomationService } from '../automation/automation.service';

export interface RegisterWebhookDto { url: string; events?: string[] }

// Catalog of business events a tenant can subscribe to. Emitting code calls emit(<key>, payload, user);
// a subscription with an empty `events` list receives all of them.
export const WEBHOOK_EVENTS = [
  { key: 'po.approved', label: 'ใบสั่งซื้อได้รับอนุมัติ', label_en: 'Purchase order approved' },
  { key: 'po.rejected', label: 'ใบสั่งซื้อถูกปฏิเสธ', label_en: 'Purchase order rejected' },
  { key: 'alert.fired', label: 'กฎแจ้งเตือนทำงาน', label_en: 'Alert rule fired' },
  { key: 'loyalty.enrolled', label: 'สมัครสมาชิกใหม่', label_en: 'Loyalty member enrolled' },
  { key: 'loyalty.earned', label: 'สะสมแต้ม', label_en: 'Loyalty points earned' },
  { key: 'loyalty.redeemed', label: 'แลกแต้ม', label_en: 'Loyalty points redeemed' },
  { key: 'loyalty.points_expiring', label: 'แต้มใกล้หมดอายุ', label_en: 'Loyalty points expiring soon' }, // W1 (docs/27)
] as const;

const MAX_ATTEMPTS = 3;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger('WebhookService');
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly automation: AutomationService,
  ) {}

  events() { return { events: WEBHOOK_EVENTS }; }

  private async tenantOf(user: JwtUser): Promise<number | null> {
    const db = this.db as any;
    const [u] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.username, user.username)).limit(1);
    return u?.tenantId ?? null;
  }

  async register(dto: RegisterWebhookDto, user: JwtUser) {
    await assertPublicUrl(dto.url, { allowHttp: ALLOW_HTTP }); // SSRF: reject internal/metadata/loopback targets
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const secret = randomBytes(24).toString('hex');
    const events = (dto.events ?? []).join(',');
    const [row] = await db.insert(webhooks).values({
      tenantId, url: dto.url, events, secret: encrypt(secret), active: true, createdBy: user.username, // ciphertext at rest
    }).returning({ id: webhooks.id });
    return { id: Number(row.id), url: dto.url, events: dto.events ?? [], secret }; // plaintext to caller, once
  }

  async list(tenantId: number | null) {
    const db = this.db as any;
    const rows = await db.select({
      id: webhooks.id, url: webhooks.url, events: webhooks.events, active: webhooks.active, createdBy: webhooks.createdBy, createdAt: webhooks.createdAt,
    }).from(webhooks)
      .where(tenantId == null ? undefined : eq(webhooks.tenantId, tenantId))
      .orderBy(desc(webhooks.createdAt));
    return rows.map((r: any) => ({ ...r, id: Number(r.id), events: r.events ? String(r.events).split(',').filter(Boolean) : [] }));
  }

  async listForUser(user: JwtUser) {
    return this.list(await this.tenantOf(user));
  }

  async remove(id: number, user: JwtUser) {
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const [hook] = await db.select({ id: webhooks.id }).from(webhooks)
      .where(and(eq(webhooks.id, id), tenantId == null ? (undefined as any) : eq(webhooks.tenantId, tenantId)));
    if (!hook) throw new NotFoundException({ code: 'WEBHOOK_NOT_FOUND', message: 'Webhook not found', messageTh: 'ไม่พบ webhook' });
    // remove its delivery history first (FK), then the endpoint
    await db.transaction(async (tx: any) => {
      await tx.delete(webhookDeliveries).where(eq(webhookDeliveries.webhookId, id));
      await tx.delete(webhooks).where(eq(webhooks.id, id));
    });
    return { id, deleted: true };
  }

  // ── delivery ───────────────────────────────────────────────────────────────
  // Sign one delivery and POST it (10s bound); record the outcome on the delivery row. Returns ok.
  private async sendOnce(hook: any, delivery: any): Promise<boolean> {
    const db = this.db as any;
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ id: Number(delivery.id), event: delivery.event, payload: delivery.payload, ts: timestamp });
    const secret = decrypt(hook.secret);
    // Receiver: recompute HMAC(secret, `${X-IERP-Timestamp}.${rawBody}`), constant-time compare to the
    // X-IERP-Signature header, reject if |now - timestamp| > 300s, and dedupe on X-IERP-Delivery.
    const signature = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const attempts = (Number(delivery.attempts) || 0) + 1;
    // Re-validate the target right before sending — defeats DNS-rebinding (a host that was public at register
    // time may now resolve to an internal IP). On block, record a failed delivery rather than firing the request.
    if (!(await isPublicUrl(hook.url, { allowHttp: ALLOW_HTTP }))) {
      this.logger.warn(`webhook ${hook.id} blocked: target is not a public address (${hook.url})`);
      await db.update(webhookDeliveries).set({
        status: 'failed', attempts, error: 'blocked: target is not a public address', nextRetryAt: null,
      }).where(eq(webhookDeliveries.id, delivery.id));
      return false;
    }
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-IERP-Signature': signature,
          'X-IERP-Timestamp': timestamp,
          'X-IERP-Delivery': String(Number(delivery.id)),
          'X-IERP-Event': delivery.event,
        },
        body,
        signal: AbortSignal.timeout(10_000), // a hung subscriber must not block; deliveries are sequential
      });
      const ok = res.ok;
      await db.update(webhookDeliveries).set({
        status: ok ? 'delivered' : 'failed', statusCode: res.status, attempts,
        error: ok ? null : `HTTP ${res.status}`, deliveredAt: ok ? new Date() : null,
        nextRetryAt: ok || attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + 3600_000),
      }).where(eq(webhookDeliveries.id, delivery.id));
      return ok;
    } catch (err) {
      this.logger.warn(`webhook ${hook.id} delivery failed: ${(err as Error).message}`);
      await db.update(webhookDeliveries).set({
        status: 'failed', attempts, error: String((err as Error).message).slice(0, 500),
        nextRetryAt: attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + 3600_000),
      }).where(eq(webhookDeliveries.id, delivery.id));
      return false;
    }
  }

  // Best-effort fan-out: for every active subscription matching the event, insert a delivery and POST it.
  async deliver(event: string, payload: unknown, tenantId: number | null) {
    const db = this.db as any;
    const conds = [eq(webhooks.active, true)];
    if (tenantId != null) conds.push(eq(webhooks.tenantId, tenantId));
    // subscribed = events empty (all) or this event present in the csv
    conds.push(sql`(coalesce(${webhooks.events},'') = '' or ${event} = ANY(string_to_array(${webhooks.events}, ',')))`);
    const hooks = await db.select().from(webhooks).where(and(...conds));
    let delivered = 0;
    for (const h of hooks) {
      const [d] = await db.insert(webhookDeliveries).values({ webhookId: Number(h.id), event, payload: payload as any, status: 'pending', attempts: 0 }).returning();
      if (await this.sendOnce(h, d)) delivered++;
    }
    return { matched: hooks.length, delivered };
  }

  // Emit a domain event from business logic — resolves the actor's tenant, never throws (best-effort).
  async emit(event: string, payload: unknown, user: JwtUser) {
    try {
      const tenantId = await this.tenantOf(user);
      const res = await this.deliver(event, payload, tenantId);
      // Same event drives the no-code automation engine (Phase 13 — A4); it must never break webhook emit.
      try { await this.automation.runEvent(event, payload as any, user); } catch { /* best-effort */ }
      return res;
    } catch (err) {
      this.logger.warn(`webhook emit('${event}') failed: ${(err as Error).message}`);
      return { matched: 0, delivered: 0 };
    }
  }

  async deliveries(user: JwtUser, limit = 100) {
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const rows = await db.select({
      id: webhookDeliveries.id, webhookId: webhookDeliveries.webhookId, event: webhookDeliveries.event,
      status: webhookDeliveries.status, statusCode: webhookDeliveries.statusCode, attempts: webhookDeliveries.attempts,
      error: webhookDeliveries.error, createdAt: webhookDeliveries.createdAt, deliveredAt: webhookDeliveries.deliveredAt,
    }).from(webhookDeliveries).innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .where(tenantId == null ? (undefined as any) : eq(webhooks.tenantId, tenantId))
      .orderBy(desc(webhookDeliveries.id)).limit(limit);
    return { deliveries: rows.map((r: any) => ({ id: Number(r.id), webhook_id: Number(r.webhookId), event: r.event, status: r.status, status_code: r.statusCode, attempts: r.attempts ?? 0, error: r.error, created_at: r.createdAt, delivered_at: r.deliveredAt })) };
  }

  // Re-send one delivery on demand (tenant-scoped via its webhook).
  async redeliver(deliveryId: number, user: JwtUser) {
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const [row] = await db.select({ d: webhookDeliveries, h: webhooks }).from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .where(and(eq(webhookDeliveries.id, deliveryId), tenantId == null ? (undefined as any) : eq(webhooks.tenantId, tenantId)));
    if (!row) throw new NotFoundException({ code: 'DELIVERY_NOT_FOUND', message: 'Delivery not found', messageTh: 'ไม่พบรายการส่ง' });
    const ok = await this.sendOnce(row.h, row.d);
    return { id: deliveryId, status: ok ? 'delivered' : 'failed' };
  }

  // Cron-callable: re-attempt failed deliveries that have not yet exhausted their retries (tenant-scoped).
  async dispatchPending(user: JwtUser) {
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const rows = await db.select({ d: webhookDeliveries, h: webhooks }).from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .where(and(eq(webhookDeliveries.status, 'failed'), sql`coalesce(${webhookDeliveries.attempts},0) < ${MAX_ATTEMPTS}`, tenantId == null ? (undefined as any) : eq(webhooks.tenantId, tenantId)))
      .limit(200);
    let delivered = 0;
    for (const r of rows) if (await this.sendOnce(r.h, r.d)) delivered++;
    return { scanned: rows.length, delivered, still_failed: rows.length - delivered };
  }
}
