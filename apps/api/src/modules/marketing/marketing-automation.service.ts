import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, inArray, gte, isNotNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { posMembers, customerProfiles, automationCampaigns, campaignSends } from '../../database/schema';
import { dineInOrders } from '../../database/schema/restaurant';
import { n } from '../../database/queries';
import { resolveMessageGateway } from '../messaging/gateways';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const rand = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const WINBACK_SEGMENTS = ['At Risk', 'Lost'];

// Deterministic A/B/holdout assignment (Phase G2, docs/25): FNV-1a over "campaignId:memberId" → 0..99.
// No RNG — the same member always lands in the same bucket for a campaign (reproducible, harness-testable,
// and a retry can never flip groups).
export function bucketPct(campaignId: number, memberId: number): number {
  const s = `${campaignId}:${memberId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % 100;
}

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
  async run(dto: { name: string; trigger: Trigger; channel?: string; coupon_prefix?: string; discount_type?: 'amount' | 'percent'; discount_value?: number; lapsed_days?: number; variant_b_body?: string; split_b_pct?: number; holdout_pct?: number; window_days?: number }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = this.tid(user);
    const channel = (dto.channel ?? 'line') as 'line' | 'sms' | 'email';
    const prefix = (dto.coupon_prefix || dto.trigger.toUpperCase()).replace(/[^A-Z0-9]/gi, '').slice(0, 10) || 'PROMO';
    const dValue = r2(dto.discount_value ?? 0);
    // A/B + holdout config (G2): B needs a body; holdout needs no config beyond its %. Bounds guarded here
    // and in the zod schema. holdout + B can't exceed 90% (someone must get variant A).
    const splitB = dto.variant_b_body ? Math.min(90, Math.max(0, Math.floor(dto.split_b_pct ?? 0))) : 0;
    const holdout = Math.min(50, Math.max(0, Math.floor(dto.holdout_pct ?? 0)));
    if (splitB + holdout > 90) throw new BadRequestException({ code: 'BAD_SPLIT', message: 'split_b_pct + holdout_pct must leave ≥10% for variant A', messageTh: 'สัดส่วน B + holdout ต้องเหลือให้กลุ่ม A อย่างน้อย 10%' });
    const [camp] = await db.insert(automationCampaigns).values({
      tenantId, name: dto.name, trigger: dto.trigger, channel, couponPrefix: prefix,
      discountType: dto.discount_type ?? 'amount', discountValue: String(dValue),
      variantBBody: dto.variant_b_body ?? null, splitBPct: splitB, holdoutPct: holdout,
      windowDays: Math.min(365, Math.max(1, Math.floor(dto.window_days ?? 30))),
      status: 'sent', createdBy: user.username,
    }).returning({ id: automationCampaigns.id });
    const campaignId = Number(camp.id);

    const aud = await this.audience(tenantId, dto.trigger, channel, { lapsed_days: dto.lapsed_days });
    const gw = resolveMessageGateway(channel);
    const offer = dto.discount_type === 'percent' ? `${dValue}%` : `${dValue} บาท`;
    let sent = 0, skipped = 0, failed = 0, held = 0;
    for (const m of aud) {
      // Deterministic assignment FIRST (before consent) so the groups are comparable populations:
      // 0..holdout-1 → holdout (no message, no coupon — the baseline), next splitB → B, rest → A.
      const pct = bucketPct(campaignId, Number(m.id));
      const variant = pct < holdout ? 'holdout' : pct < holdout + splitB ? 'B' : 'A';
      if (variant === 'holdout') {
        await this.record(tenantId, campaignId, m.id, null, channel, null, 'holdout', null, user.username, 'holdout');
        held++; continue;
      }
      const recipient = channel === 'email' ? m.email : channel === 'sms' ? m.phone : m.lineUserId;
      const coupon = `${prefix}-${m.id}-${rand()}`;
      // consent first — an opted-out member is recorded 'skipped', never contacted
      if (m.optIn === false) { await this.record(tenantId, campaignId, m.id, coupon, channel, null, 'skipped', 'opted out', user.username, variant); skipped++; continue; }
      if (!recipient) { await this.record(tenantId, campaignId, m.id, coupon, channel, null, 'failed', 'no recipient contact', user.username, variant); failed++; continue; }
      const body = variant === 'B' && dto.variant_b_body
        ? `${dto.variant_b_body} ใช้โค้ด ${coupon} ที่ร้านเรา`
        : `🎁 ส่วนลดพิเศษ ${offer} สำหรับคุณ! ใช้โค้ด ${coupon} ที่ร้านเรา`;
      const res = await gw.send(recipient, body);
      await this.record(tenantId, campaignId, m.id, coupon, channel, recipient, res.status === 'sent' ? 'sent' : 'failed', res.error ?? null, user.username, variant);
      if (res.status === 'sent') sent++; else failed++;
    }
    return { campaign_id: campaignId, name: dto.name, trigger: dto.trigger, channel, offer, targeted: aud.length, sent, skipped, failed, holdout: held };
  }

  private async record(tenantId: number, campaignId: number, memberId: number, coupon: string | null, channel: string, recipient: string | null, status: string, error: string | null, by: string, variant: string | null = null) {
    const db = this.db as any;
    await db.insert(campaignSends).values({ tenantId, campaignId, memberId, couponCode: coupon, channel, recipient, status, error, variant, createdBy: by });
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
    // Per-group A/B/holdout tallies (G2). Lift v1 is the messaged groups' redemption rate vs the holdout's —
    // with coupons the holdout redeems 0 BY CONSTRUCTION, so this measures redemptions attributable to being
    // messaged, not organic-purchase lift (see lift_note; organic baseline is a v2 refinement).
    const group = (v: string) => {
      const g = sends.filter((s: any) => s.variant === v);
      const gSent = g.filter((s: any) => s.status === 'sent').length;
      const gRed = g.filter((s: any) => s.redeemedAt != null).length;
      return { count: g.length, sent: gSent, redeemed: gRed, redemption_rate_pct: gSent > 0 ? r2((gRed / gSent) * 100) : 0, attributed_revenue: r2(g.reduce((a: number, s: any) => a + (s.redeemedAt ? n(s.redeemedValue) : 0), 0)) };
    };
    // H2 (docs/26) — organic-purchase baseline: join each group's members to their ACTUAL paid orders
    // (sale_no set) within window_days after THEIR send. The holdout's purchase rate/revenue is what
    // "doing nothing" earns — organic lift = messaged rate − holdout rate. Group sizes are rendered next to
    // the rates (small holdouts ⇒ noisy baseline; the reader judges — no p-value pretence).
    const windowDays = Number(camp.windowDays ?? 30);
    const withVariant = sends.filter((s: any) => s.variant != null && s.memberId != null);
    const memberIds = Array.from(new Set<number>(withVariant.map((s: any) => Number(s.memberId))));
    let organic: any = null;
    if (withVariant.length && memberIds.length) {
      const earliest = new Date(Math.min(...withVariant.map((s: any) => new Date(s.sentAt).getTime())));
      const orders = await db.select({ memberId: dineInOrders.memberId, total: dineInOrders.total, openedAt: dineInOrders.openedAt })
        .from(dineInOrders).where(and(eq(dineInOrders.tenantId, Number(camp.tenantId)), inArray(dineInOrders.memberId, memberIds),
          isNotNull(dineInOrders.saleNo), gte(dineInOrders.openedAt, earliest)));
      const sendAt = new Map<number, number>(withVariant.map((s: any) => [Number(s.memberId), new Date(s.sentAt).getTime()]));
      const inWindow = (o: any) => {
        const t0 = sendAt.get(Number(o.memberId));
        if (t0 == null) return false;
        const t = new Date(o.openedAt).getTime();
        return t >= t0 && t <= t0 + windowDays * 86_400_000;
      };
      const grpOrganic = (vs: string[]) => {
        const members = new Set(withVariant.filter((s: any) => vs.includes(s.variant)).map((s: any) => Number(s.memberId)));
        const gOrders = orders.filter((o: any) => members.has(Number(o.memberId)) && inWindow(o));
        const purchasers = new Set(gOrders.map((o: any) => Number(o.memberId))).size;
        return { members: members.size, purchasers, purchase_rate_pct: members.size > 0 ? r2((purchasers / members.size) * 100) : 0, order_revenue: r2(gOrders.reduce((a: number, o: any) => a + n(o.total), 0)) };
      };
      const messaged = grpOrganic(['A', 'B']);
      const holdoutG = grpOrganic(['holdout']);
      organic = {
        window_days: windowDays, a: grpOrganic(['A']), b: grpOrganic(['B']), holdout: holdoutG, messaged,
        organic_lift: holdoutG.members > 0 ? {
          purchase_rate_pp: r2(messaged.purchase_rate_pct - holdoutG.purchase_rate_pct),
          incremental_revenue: r2(messaged.order_revenue - (holdoutG.order_revenue * (holdoutG.members > 0 ? messaged.members / holdoutG.members : 0))),
        } : null,
        note: 'baseline = ยอดซื้อจริงของกลุ่ม holdout ในหน้าต่างเดียวกัน — กลุ่มเล็กค่าจะแกว่ง ดูขนาดกลุ่มประกอบ',
      };
    }
    const hasAb = (Number(camp.splitBPct ?? 0) > 0 || Number(camp.holdoutPct ?? 0) > 0) && sends.some((s: any) => s.variant != null);
    const abReport = hasAb ? (() => {
      const a = group('A'), b = group('B'), h = group('holdout');
      const messagedRate = sent > 0 ? r2((redeemed / sent) * 100) : 0;
      return { a, b, holdout: { count: h.count }, lift_redemption_rate_pct: messagedRate,
        lift_note: 'holdout ไม่ได้รับคูปอง จึงมีอัตราแลก 0 โดยนิยาม — ตัวเลขนี้คือการแลกที่เกิดจาก "การถูกส่งข้อความ" (ยังไม่หัก organic baseline)' };
    })() : null;
    return {
      campaign_id: campaignId, name: camp.name, trigger: camp.trigger, channel: camp.channel,
      sent, skipped: sends.filter((s: any) => s.status === 'skipped').length, failed: sends.filter((s: any) => s.status === 'failed').length,
      holdout: sends.filter((s: any) => s.status === 'holdout').length,
      redeemed, redemption_rate_pct: sent > 0 ? r2((redeemed / sent) * 100) : 0, attributed_revenue: attributed,
      split_b_pct: Number(camp.splitBPct ?? 0), holdout_pct: Number(camp.holdoutPct ?? 0), ab: abReport, organic,
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
