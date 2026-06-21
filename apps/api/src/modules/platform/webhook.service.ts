import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHmac } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { webhooks, webhookDeliveries, users } from '../../database/schema';
import { encrypt, decrypt } from '../../common/crypto';
import type { JwtUser } from '../../common/decorators';

export interface RegisterWebhookDto { url: string; events?: string[] }

@Injectable()
export class WebhookService {
  private readonly logger = new Logger('WebhookService');
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async tenantOf(user: JwtUser): Promise<number | null> {
    const db = this.db as any;
    const [u] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.username, user.username)).limit(1);
    return u?.tenantId ?? null;
  }

  async register(dto: RegisterWebhookDto, user: JwtUser) {
    const db = this.db as any;
    const tenantId = await this.tenantOf(user);
    const secret = randomBytes(24).toString('hex');
    const events = (dto.events ?? []).join(',');
    const [row] = await db.insert(webhooks).values({
      tenantId, url: dto.url, events, secret: encrypt(secret), active: true, // ciphertext at rest
    }).returning({ id: webhooks.id });
    return { id: Number(row.id), url: dto.url, events: dto.events ?? [], secret }; // plaintext to caller, once
  }

  async list(tenantId: number | null) {
    const db = this.db as any;
    const rows = await db.select({
      id: webhooks.id, url: webhooks.url, events: webhooks.events, active: webhooks.active, createdAt: webhooks.createdAt,
    }).from(webhooks)
      .where(tenantId == null ? undefined : eq(webhooks.tenantId, tenantId))
      .orderBy(desc(webhooks.createdAt));
    return rows.map((r: any) => ({ ...r, id: Number(r.id), events: r.events ? String(r.events).split(',').filter(Boolean) : [] }));
  }

  async listForUser(user: JwtUser) {
    return this.list(await this.tenantOf(user));
  }

  // best-effort fan-out: insert delivery (pending) แล้ว POST แบบ signed; ล้มเหลว → status 'failed'
  async deliver(event: string, payload: unknown, tenantId: number | null) {
    const db = this.db as any;
    const conds = [eq(webhooks.active, true)];
    if (tenantId != null) conds.push(eq(webhooks.tenantId, tenantId));
    // subscribed = events ว่าง (รับทุก event) หรือมี event นี้อยู่ใน csv
    conds.push(sql`(coalesce(${webhooks.events},'') = '' or ${event} = ANY(string_to_array(${webhooks.events}, ',')))`);
    const hooks = await db.select().from(webhooks).where(and(...conds));

    let delivered = 0;
    for (const h of hooks) {
      const [d] = await db.insert(webhookDeliveries).values({
        webhookId: Number(h.id), event, payload: payload as any, status: 'pending', attempts: 0,
      }).returning({ id: webhookDeliveries.id });
      // Bind the unique delivery id + timestamp into the SIGNED body → replay-evident.
      // Receiver: recompute HMAC(secret, `${X-IERP-Timestamp}.${rawBody}`), constant-time compare to
      // X-IERP-Signature, reject if |now - timestamp| > 300s, and dedupe on X-IERP-Delivery.
      const timestamp = new Date().toISOString();
      const deliveryId = Number(d.id);
      const body = JSON.stringify({ id: deliveryId, event, payload, ts: timestamp });
      const secret = decrypt(h.secret);
      const signature = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
      try {
        const res = await fetch(h.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-IERP-Signature': signature,
            'X-IERP-Timestamp': timestamp,
            'X-IERP-Delivery': String(deliveryId),
            'X-IERP-Event': event,
          },
          body,
        });
        const ok = res.ok;
        await db.update(webhookDeliveries).set({
          status: ok ? 'delivered' : 'failed', statusCode: res.status, attempts: 1,
        }).where(eq(webhookDeliveries.id, d.id));
        if (ok) delivered++;
      } catch (err) {
        this.logger.warn(`webhook ${h.id} delivery failed: ${(err as Error).message}`);
        await db.update(webhookDeliveries).set({ status: 'failed', attempts: 1 }).where(eq(webhookDeliveries.id, d.id));
      }
    }
    return { matched: hooks.length, delivered };
  }
}
