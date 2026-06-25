import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posMembers, customerProfiles, automationCampaigns, campaignSends } from '../../database/schema';
import { n } from '../../database/queries';
import { resolveMessageGateway } from '../messaging/gateways';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const rand = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const WINBACK_SEGMENTS = ['At Risk', 'Lost'];

type Trigger = 'lapsed' | 'birthday' | 'winback' | 'all';

// LINE marketing automation — closed loop: a behaviour trigger picks the audience, a per-member coupon is
// pushed over LINE (consent-respecting), and the redemption is tracked back to the sale so the campaign's
// revenue is attributable. Builds on the LINE-CRM identity + the messaging gateway.
@Injectable()
export class MarketingAutomationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'No tenant context', messageTh: 'ไม่พบบริบทร้านค้า' });
    return user.tenantId;
  }

  // Resolve the audience for a trigger: active, opted-in members (LINE channel ⇒ must have a linked LINE id).
  private async audience(tenantId: number, trigger: Trigger, channel: string, opts?: { lapsed_days?: number }) {
    const db = this.db as any;
    const lapsedDays = Math.max(1, Math.floor(opts?.lapsed_days ?? 30));
    const rows = await db.select({
      id: posMembers.id, name: posMembers.name, lineUserId: posMembers.lineUserId, phone: posMembers.phone, email: posMembers.email,
      optIn: posMembers.marketingOptIn, active: posMembers.active, birthday: posMembers.birthday,
      recency: customerProfiles.rfmRecency, segment: customerProfiles.rfmSegment,
    }).from(posMembers).leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id))
      .where(eq(posMembers.tenantId, tenantId));

    const bkk = new Date(Date.now() + 7 * 3600 * 1000);
    const mo = bkk.getUTCMonth() + 1, day = bkk.getUTCDate();
    return rows.filter((m: any) => {
      if (m.active === false) return false;
      if (trigger === 'lapsed') return n(m.recency) >= lapsedDays;
      if (trigger === 'winback') return WINBACK_SEGMENTS.includes(String(m.segment));
      if (trigger === 'birthday') { if (!m.birthday) return false; const d = new Date(m.birthday + 'T00:00:00Z'); return d.getUTCMonth() + 1 === mo && d.getUTCDate() === day; }
      return true; // 'all'
    });
  }

  // Preview the audience size for a trigger without sending (planning).
  async preview(dto: { trigger: Trigger; channel?: string; lapsed_days?: number }, user: JwtUser) {
    const tenantId = this.tid(user);
    const aud = await this.audience(tenantId, dto.trigger, dto.channel ?? 'line', { lapsed_days: dto.lapsed_days });
    const reachable = aud.filter((m: any) => m.optIn !== false && (dto.channel === 'email' ? m.email : dto.channel === 'sms' ? m.phone : m.lineUserId));
    return { trigger: dto.trigger, audience: aud.length, reachable: reachable.length };
  }

  // Run a campaign: create it, generate a per-member coupon, push it (consent-respecting), record each send.
  async run(dto: { name: string; trigger: Trigger; channel?: string; coupon_prefix?: string; discount_type?: 'amount' | 'percent'; discount_value?: number; lapsed_days?: number }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = this.tid(user);
    const channel = (dto.channel ?? 'line') as 'line' | 'sms' | 'email';
    const prefix = (dto.coupon_prefix || dto.trigger.toUpperCase()).replace(/[^A-Z0-9]/gi, '').slice(0, 10) || 'PROMO';
    const dValue = r2(dto.discount_value ?? 0);
    const [camp] = await db.insert(automationCampaigns).values({
      tenantId, name: dto.name, trigger: dto.trigger, channel, couponPrefix: prefix,
      discountType: dto.discount_type ?? 'amount', discountValue: String(dValue), status: 'sent', createdBy: user.username,
    }).returning({ id: automationCampaigns.id });
    const campaignId = Number(camp.id);

    const aud = await this.audience(tenantId, dto.trigger, channel, { lapsed_days: dto.lapsed_days });
    const gw = resolveMessageGateway(channel);
    const offer = dto.discount_type === 'percent' ? `${dValue}%` : `${dValue} บาท`;
    let sent = 0, skipped = 0, failed = 0;
    for (const m of aud) {
      const recipient = channel === 'email' ? m.email : channel === 'sms' ? m.phone : m.lineUserId;
      const coupon = `${prefix}-${m.id}-${rand()}`;
      // consent first — an opted-out member is recorded 'skipped', never contacted
      if (m.optIn === false) { await this.record(tenantId, campaignId, m.id, coupon, channel, null, 'skipped', 'opted out', user.username); skipped++; continue; }
      if (!recipient) { await this.record(tenantId, campaignId, m.id, coupon, channel, null, 'failed', 'no recipient contact', user.username); failed++; continue; }
      const body = `🎁 ส่วนลดพิเศษ ${offer} สำหรับคุณ! ใช้โค้ด ${coupon} ที่ร้านเรา`;
      const res = await gw.send(recipient, body);
      await this.record(tenantId, campaignId, m.id, coupon, channel, recipient, res.status === 'sent' ? 'sent' : 'failed', res.error ?? null, user.username);
      if (res.status === 'sent') sent++; else failed++;
    }
    return { campaign_id: campaignId, name: dto.name, trigger: dto.trigger, channel, offer, targeted: aud.length, sent, skipped, failed };
  }

  private async record(tenantId: number, campaignId: number, memberId: number, coupon: string, channel: string, recipient: string | null, status: string, error: string | null, by: string) {
    const db = this.db as any;
    await db.insert(campaignSends).values({ tenantId, campaignId, memberId, couponCode: coupon, channel, recipient, status, error, createdBy: by });
  }

  // Close the loop: redeem a coupon against a sale. Idempotent — a re-presented coupon returns the original
  // redemption rather than double-counting. Returns the discount to apply.
  async redeem(dto: { coupon_code: string; sale_no?: string; value?: number }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = this.tid(user);
    const [send] = await db.select().from(campaignSends).where(and(eq(campaignSends.tenantId, tenantId), eq(campaignSends.couponCode, dto.coupon_code))).limit(1);
    if (!send) throw new NotFoundException({ code: 'COUPON_NOT_FOUND', message: 'Coupon not found', messageTh: 'ไม่พบคูปอง' });
    if (send.status !== 'sent') throw new BadRequestException({ code: 'COUPON_NOT_SENT', message: 'Coupon was never delivered', messageTh: 'คูปองนี้ยังไม่ถูกส่ง' });
    if (send.redeemedAt) return { coupon_code: dto.coupon_code, already_redeemed: true, redeemed_at: send.redeemedAt, redeemed_value: n(send.redeemedValue), sale_no: send.redeemedSaleNo };
    const [camp] = await db.select().from(automationCampaigns).where(eq(automationCampaigns.id, Number(send.campaignId))).limit(1);
    const value = dto.value != null ? r2(dto.value) : n(camp?.discountValue);
    await db.update(campaignSends).set({ redeemedAt: new Date(), redeemedSaleNo: dto.sale_no ?? null, redeemedValue: String(value) }).where(eq(campaignSends.id, Number(send.id)));
    return { coupon_code: dto.coupon_code, redeemed: true, campaign_id: Number(send.campaignId), member_id: Number(send.memberId), discount_type: camp?.discountType ?? 'amount', redeemed_value: value, sale_no: dto.sale_no ?? null };
  }

  // Closed-loop report: delivery + redemption rate + attributed revenue.
  async report(campaignId: number, user: JwtUser) {
    const db = this.db as any;
    this.tid(user);
    const [camp] = await db.select().from(automationCampaigns).where(eq(automationCampaigns.id, campaignId)).limit(1);
    if (!camp) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found', messageTh: 'ไม่พบแคมเปญ' });
    const sends = await db.select().from(campaignSends).where(eq(campaignSends.campaignId, campaignId));
    const sent = sends.filter((s: any) => s.status === 'sent').length;
    const redeemed = sends.filter((s: any) => s.redeemedAt != null).length;
    const attributed = r2(sends.reduce((a: number, s: any) => a + (s.redeemedAt ? n(s.redeemedValue) : 0), 0));
    return {
      campaign_id: campaignId, name: camp.name, trigger: camp.trigger, channel: camp.channel,
      sent, skipped: sends.filter((s: any) => s.status === 'skipped').length, failed: sends.filter((s: any) => s.status === 'failed').length,
      redeemed, redemption_rate_pct: sent > 0 ? r2((redeemed / sent) * 100) : 0, attributed_revenue: attributed,
    };
  }

  async list(user: JwtUser, limit = 50) {
    const db = this.db as any;
    this.tid(user);
    const camps = await db.select().from(automationCampaigns).orderBy(desc(automationCampaigns.id)).limit(limit);
    if (!camps.length) return { campaigns: [], count: 0 };
    const ids = camps.map((c: any) => Number(c.id));
    const sends = await db.select({ campaignId: campaignSends.campaignId, status: campaignSends.status, redeemedAt: campaignSends.redeemedAt, redeemedValue: campaignSends.redeemedValue }).from(campaignSends).where(inArray(campaignSends.campaignId, ids));
    const byCamp = new Map<number, any[]>();
    for (const s of sends) { const k = Number(s.campaignId); (byCamp.get(k) ?? byCamp.set(k, []).get(k))!.push(s); }
    return {
      campaigns: camps.map((c: any) => {
        const ss = byCamp.get(Number(c.id)) ?? [];
        const sent = ss.filter((s: any) => s.status === 'sent').length;
        const redeemed = ss.filter((s: any) => s.redeemedAt != null).length;
        return { id: Number(c.id), name: c.name, trigger: c.trigger, channel: c.channel, sent, redeemed, redemption_rate_pct: sent > 0 ? r2((redeemed / sent) * 100) : 0, attributed_revenue: r2(ss.reduce((a: number, s: any) => a + (s.redeemedAt ? n(s.redeemedValue) : 0), 0)), created_at: c.createdAt };
      }),
      count: camps.length,
    };
  }
}
