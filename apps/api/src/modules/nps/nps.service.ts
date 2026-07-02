import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ConflictException, GoneException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { eq, and, sql, gte, isNotNull, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { npsResponses, posMembers, dineInOrders } from '../../database/schema';
import { MessagingService } from '../messaging/messaging.service';
import { WebhookService } from '../platform/webhook.service';
import { AutomationService } from '../automation/automation.service';
import type { JwtUser } from '../../common/decorators';
import { isUniqueViolation } from '../../common/db-error';

const SURVEY_TTL_DAYS = 7;

// W3 (docs/27) — the CX closed loop: every purchase can become a promoter. A tokenized micro-survey is sent
// post-purchase (staff/scheduler-triggered; the message rides MessagingService's consent path as the
// transactional-exempt 'nps' campaign — a service follow-up, not marketing); the member answers the 0–10
// question on a public single-use link (`/api/nps/:token` — the random token is the ONLY key in the URL,
// no PII per the CWE-598 lesson). A detractor (≤6) fires `loyalty.nps_detractor` into the webhook fan-out +
// the no-code automation catalog → wire to a service-recovery journey. Rides MKT-04/12 — no new control.
@Injectable()
export class NpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly messaging: MessagingService,
    // Optional so partial harnesses still construct; the detractor event is best-effort.
    @Optional() private readonly webhooks?: WebhookService,
    @Optional() private readonly automation?: AutomationService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // Send one survey to a member (idempotent per member × sale_ref via the unique index). The link body is
  // the tokenized public URL; the send respects consent + the member's reachable channel.
  async sendSurvey(user: JwtUser, dto: { member_id: number; sale_ref?: string; channel?: 'line' | 'sms' | 'email' }) {
    const db = this.db;
    const tenantId = this.tid(user);
    const [m] = await db.select().from(posMembers).where(and(eq(posMembers.id, dto.member_id), eq(posMembers.tenantId, tenantId))).limit(1);
    if (!m || m.active === false) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const token = randomBytes(16).toString('hex');
    let row: typeof npsResponses.$inferSelect;
    try {
      const ins = await db.insert(npsResponses).values({
        tenantId, memberId: dto.member_id, token, saleRef: dto.sale_ref ?? null,
        channel: dto.channel ?? (m.lineUserId ? 'line' : 'sms'),
        expiresAt: new Date(Date.now() + SURVEY_TTL_DAYS * 86400_000), createdBy: user.username,
      }).returning();
      row = ins[0]!;
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException({ code: 'NPS_ALREADY_SENT', message: 'A survey for this member/sale was already sent', messageTh: 'ส่งแบบสอบถามสำหรับบิลนี้แล้ว' });
      throw e;
    }
    const base = (process.env.WEB_PUBLIC_URL ?? '').replace(/\/$/, '');
    const link = `${base}/nps/${token}`;
    const body = `ขอบคุณที่ใช้บริการ! ให้คะแนนเราหน่อย (0–10): ${link}`;
    // 'nps' is on the transactional exempt list (a service follow-up) — consent still applies.
    const res: any = await this.messaging.send({ member_id: dto.member_id, channel: (row.channel ?? 'sms') as 'line' | 'sms' | 'email', body, campaign: 'nps' }, user);
    return { id: Number(row.id), member_id: dto.member_id, token, link, send_status: res?.status ?? 'failed', expires_at: row.expiresAt };
  }

  // Scheduled post-purchase trigger (rides the BI report scheduler, like ar_collections_dunning): survey
  // every member with a PAID order in the last `windowDays` who hasn't been surveyed for that sale yet.
  // Idempotent via the (member_id, sale_ref) unique index — a re-run inserts nothing new.
  async sendDue(user: JwtUser, windowDays = 1) {
    const db = this.db;
    const tenantId = this.tid(user);
    const since = new Date(Date.now() - windowDays * 86400_000);
    const orders = await db.select({ memberId: dineInOrders.memberId, saleNo: dineInOrders.saleNo })
      .from(dineInOrders)
      .where(and(eq(dineInOrders.tenantId, tenantId), isNotNull(dineInOrders.memberId), isNotNull(dineInOrders.saleNo), gte(dineInOrders.openedAt, since)));
    let sent = 0, skipped = 0;
    for (const o of orders) {
      try {
        const r = await this.sendSurvey(user, { member_id: Number(o.memberId), sale_ref: String(o.saleNo) });
        if (r.send_status === 'sent') sent++; else skipped++;
      } catch (e: any) {
        if (e?.response?.code === 'NPS_ALREADY_SENT' || e?.code === 'NPS_ALREADY_SENT' || e instanceof ConflictException) skipped++;
        else skipped++;
      }
    }
    return { window_days: windowDays, orders: orders.length, sent, skipped };
  }

  // ── Public (tokenized) ──────────────────────────────────────────────────────
  // The token is the ONLY identifier — the response carries the question + state, never member PII.
  async getSurvey(token: string) {
    const db = this.db;
    const [r] = await db.select().from(npsResponses).where(eq(npsResponses.token, token)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NPS_NOT_FOUND', message: 'Survey not found', messageTh: 'ไม่พบแบบสอบถาม' });
    const expired = r.expiresAt != null && new Date(r.expiresAt).getTime() < Date.now();
    return {
      question: 'คุณจะแนะนำเราให้เพื่อนหรือไม่? (0 = ไม่แนะนำเลย, 10 = แนะนำแน่นอน)',
      answered: r.respondedAt != null,
      expired,
    };
  }

  async submit(token: string, dto: { score: number; comment?: string }) {
    const db = this.db;
    const score = Number(dto.score);
    if (!Number.isInteger(score) || score < 0 || score > 10) throw new BadRequestException({ code: 'BAD_SCORE', message: 'score must be an integer 0–10', messageTh: 'คะแนนต้องเป็น 0–10' });
    const [r] = await db.select().from(npsResponses).where(eq(npsResponses.token, token)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NPS_NOT_FOUND', message: 'Survey not found', messageTh: 'ไม่พบแบบสอบถาม' });
    if (r.expiresAt != null && new Date(r.expiresAt).getTime() < Date.now()) throw new GoneException({ code: 'NPS_EXPIRED', message: 'Survey link expired', messageTh: 'ลิงก์หมดอายุแล้ว' });
    // Single-use: an atomic guarded UPDATE (responded_at must still be NULL) — a concurrent/second submit
    // updates 0 rows and is rejected, so a score can never be overwritten.
    const upd = await db.update(npsResponses)
      .set({ score, comment: dto.comment ? String(dto.comment).slice(0, 500) : null, respondedAt: new Date() })
      .where(and(eq(npsResponses.token, token), sql`${npsResponses.respondedAt} IS NULL`))
      .returning();
    if (!upd.length) throw new ConflictException({ code: 'NPS_ALREADY_ANSWERED', message: 'Survey already answered', messageTh: 'ตอบแบบสอบถามนี้แล้ว' });
    const row = upd[0]!;
    // Detractor (≤6) → service-recovery signal into webhooks + the automation catalog (best-effort).
    if (score <= 6) {
      const payload = { member_id: Number(row.memberId), score, comment: row.comment ?? null, sale_ref: row.saleRef ?? null };
      const sysUser = { username: 'system:nps', tenantId: row.tenantId != null ? Number(row.tenantId) : null, role: 'System' } as unknown as JwtUser;
      try { await this.webhooks?.deliver('loyalty.nps_detractor', payload, row.tenantId != null ? Number(row.tenantId) : null); } catch { /* best-effort */ }
      try { await this.automation?.runEvent('loyalty.nps_detractor', payload, sysUser); } catch { /* best-effort */ }
    }
    return { answered: true, score, detractor: score <= 6 };
  }

  // ── Staff analytics ─────────────────────────────────────────────────────────
  // NPS = %promoters (9–10) − %detractors (0–6) over answered surveys; monthly trend for the last N months.
  async summary(user: JwtUser, months = 6) {
    const db = this.db;
    const tenantId = this.tid(user);
    const since = new Date(Date.now() - months * 30 * 86400_000);
    const rows = await db.select({ score: npsResponses.score, at: npsResponses.respondedAt })
      .from(npsResponses)
      .where(and(eq(npsResponses.tenantId, tenantId), isNotNull(npsResponses.respondedAt), gte(npsResponses.respondedAt, since)));
    const calc = (list: any[]) => {
      const total = list.length;
      if (!total) return { responses: 0, promoters: 0, passives: 0, detractors: 0, nps: null as number | null };
      const promoters = list.filter((r) => Number(r.score) >= 9).length;
      const detractors = list.filter((r) => Number(r.score) <= 6).length;
      return { responses: total, promoters, passives: total - promoters - detractors, detractors, nps: Math.round(((promoters - detractors) / total) * 100) };
    };
    const byMonth = new Map<string, any[]>();
    for (const r of rows) {
      if (!r.at) continue;
      const k = new Date(new Date(r.at).getTime() + 7 * 3600_000).toISOString().slice(0, 7); // BKK month
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k)!.push(r);
    }
    const [pending] = await db.select({ c: sql<number>`count(*)` }).from(npsResponses)
      .where(and(eq(npsResponses.tenantId, tenantId), sql`${npsResponses.respondedAt} IS NULL`));
    return {
      ...calc(rows),
      awaiting_response: Number(pending?.c ?? 0),
      trend: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, list]) => ({ month, ...calc(list) })),
    };
  }

  // Latest NPS answer for a member — surfaces on the member 360.
  async lastForMember(user: JwtUser, memberId: number) {
    const db = this.db;
    const tenantId = this.tid(user);
    const [r] = await db.select().from(npsResponses)
      .where(and(eq(npsResponses.tenantId, tenantId), eq(npsResponses.memberId, memberId), isNotNull(npsResponses.respondedAt)))
      .orderBy(desc(npsResponses.respondedAt)).limit(1);
    if (!r) return { member_id: memberId, score: null, responded_at: null, detractor: false };
    return { member_id: memberId, score: Number(r.score), comment: r.comment ?? null, responded_at: r.respondedAt, detractor: Number(r.score) <= 6, sale_ref: r.saleRef ?? null };
  }
}
