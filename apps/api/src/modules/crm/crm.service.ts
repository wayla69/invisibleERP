import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, isNotNull, desc, sql, gt, gte, lt, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, promoAudienceRules } from '../../database/schema/crm';
import { posMembers } from '../../database/schema/loyalty-members';
import { memberConsents } from '../../database/schema/member-consents';
import { auditLog } from '../../database/schema';
import { dineInOrders } from '../../database/schema/restaurant';
import { promotions } from '../../database/schema/marketing';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Predictive scoring (Growth Engine G3, docs/25) — EXPLAINABLE versioned weighted formula, deliberately
// not a trained model (SOX posture: coefficients are code-reviewed + documented in
// docs/ops/predictive-scoring.md; every stored score carries SCORE_VERSION). Null until ≥1 paid order.
export const SCORE_VERSION = 'v1';
export const SCORE_COEFFS = {
  assumedCadenceDays: 30, // cadence fallback when the member has exactly 1 order (assume monthly)
  ratioSoftness: 3,       // churn base = 100·r/(r+softness), r = recency ÷ personal cadence
  trendAdj: 10,           // ± adjustment when order count last 45d shrinks/grows vs the prior 45d
  ltvHorizonDays: 365,    // predicted LTV horizon (12 months)
} as const;
// churn_risk 0..100: how far past their OWN purchase rhythm a member is (a weekly customer 3 weeks quiet
// scores far higher than a quarterly one 3 weeks quiet), nudged by the frequency trend.
function churnScore(recencyDays: number, cadenceDays: number, last45: number, prior45: number): number {
  const r = recencyDays / Math.max(1, cadenceDays);
  const base = 100 * (r / (r + SCORE_COEFFS.ratioSoftness));
  const trend = last45 < prior45 ? SCORE_COEFFS.trendAdj : last45 > prior45 ? -SCORE_COEFFS.trendAdj : 0;
  return Math.max(0, Math.min(100, Math.round(base + trend)));
}

// RFM scoring — each dimension 1-5
function rfmScore(recencyDays: number, freq: number, monetary: number) {
  const r = recencyDays <= 7 ? 5 : recencyDays <= 14 ? 4 : recencyDays <= 30 ? 3 : recencyDays <= 60 ? 2 : 1;
  const f = freq >= 10 ? 5 : freq >= 5 ? 4 : freq >= 3 ? 3 : freq >= 2 ? 2 : 1;
  const m = monetary >= 5000 ? 5 : monetary >= 2000 ? 4 : monetary >= 1000 ? 3 : monetary >= 500 ? 2 : 1;
  const avg = (r + f + m) / 3;
  if (avg >= 4 && r >= 4) return 'Champions';
  if (avg >= 3) return 'Loyal';
  if (r <= 2 && (f >= 3 || m >= 3)) return 'At Risk';
  if (r <= 1) return 'Lost';
  return 'New';
}

@Injectable()
export class CrmService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Compute and upsert the customer_profile for one member.
  // Aggregates from dine_in_orders (channel/online/kiosk) where member_id is set.
  async refreshProfile(tenantId: number, memberId: number) {
    const db = this.db as any;
    const [mem] = await db.select({ id: posMembers.id, lifetime: posMembers.lifetime }).from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!mem) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });

    // Aggregate paid channel orders linked to this member
    const rows: any[] = await db.select({
      total: dineInOrders.total,
      openedAt: dineInOrders.openedAt,
      channel: dineInOrders.channel,
    }).from(dineInOrders).where(
      and(eq(dineInOrders.tenantId, tenantId), eq(dineInOrders.memberId, memberId), isNotNull(dineInOrders.saleNo))
    );

    const totalOrders = rows.length;
    const totalSpend = rows.reduce((s, r) => s + n(r.total), 0);

    const dates = rows.map(r => new Date(r.openedAt).getTime()).filter(Boolean);
    const lastOrderAt = dates.length ? new Date(Math.max(...dates)) : null;
    const firstOrderAt = dates.length ? new Date(Math.min(...dates)) : null;

    // RFM window: last 90 days
    const cutoffMs = Date.now() - 90 * 86400 * 1000;
    const recent = rows.filter(r => new Date(r.openedAt).getTime() >= cutoffMs);
    const rfmRecency = lastOrderAt ? Math.floor((Date.now() - lastOrderAt.getTime()) / 86400000) : 999;
    const rfmFrequency = recent.length;
    const rfmMonetary = recent.reduce((s, r) => s + n(r.total), 0);
    const segment = rfmScore(rfmRecency, rfmFrequency, rfmMonetary);

    // Preferred channel: most frequent channel in rows
    const channelCounts: Record<string, number> = {};
    for (const r of rows) { channelCounts[r.channel] = (channelCounts[r.channel] ?? 0) + 1; }
    const preferredChannel = Object.entries(channelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const avgOrderValue = totalOrders > 0 ? Math.round(totalSpend / totalOrders * 100) / 100 : 0;

    // G3 predictive scores — personal cadence = avg days between orders (fallback: assume monthly with a
    // single order); LTV = avg order value × orders/year at that cadence × survival (1 − churn). Estimates,
    // not bookkeeping: never posted anywhere, surfaced with the version stamp.
    let churnRisk: number | null = null;
    let predictedLtv: number | null = null;
    if (totalOrders > 0 && lastOrderAt) {
      const cadence = totalOrders >= 2 && firstOrderAt
        ? Math.max(1, (lastOrderAt.getTime() - firstOrderAt.getTime()) / 86_400_000 / (totalOrders - 1))
        : SCORE_COEFFS.assumedCadenceDays;
      const cut45 = Date.now() - 45 * 86_400_000, cut90 = Date.now() - 90 * 86_400_000;
      const last45 = rows.filter(r => new Date(r.openedAt).getTime() >= cut45).length;
      const prior45 = rows.filter(r => { const t = new Date(r.openedAt).getTime(); return t >= cut90 && t < cut45; }).length;
      churnRisk = churnScore(rfmRecency, cadence, last45, prior45);
      predictedLtv = Math.round(avgOrderValue * (SCORE_COEFFS.ltvHorizonDays / cadence) * (1 - churnRisk / 100) * 100) / 100;
    }

    const vals = {
      tenantId, memberId,
      totalOrders, totalSpend: String(totalSpend), lastOrderAt, firstOrderAt,
      rfmRecency, rfmFrequency, rfmMonetary: String(rfmMonetary), rfmSegment: segment,
      preferredChannel, visitCount: totalOrders,
      avgOrderValue: String(avgOrderValue),
      churnRisk, predictedLtv: predictedLtv != null ? String(predictedLtv) : null, scoreVersion: SCORE_VERSION,
      refreshedAt: new Date(),
    };

    await db.insert(customerProfiles).values(vals).onConflictDoUpdate({
      target: [customerProfiles.tenantId, customerProfiles.memberId],
      set: { ...vals },
    });

    return { member_id: memberId, rfm_segment: segment, total_orders: totalOrders, total_spend: totalSpend, rfm_recency: rfmRecency, rfm_frequency: rfmFrequency, rfm_monetary: rfmMonetary, churn_risk: churnRisk, predicted_ltv: predictedLtv, score_version: SCORE_VERSION };
  }

  // Phase F2 (docs/24) — bulk RFM re-profiling. Sweeps the tenant's ACTIVE members in id-keyed batches
  // through the single reviewed refreshProfile() path (no new scoring logic), so segments and analytics stop
  // drifting stale between orders. Idempotent (the profile is a pure upsert; a re-run with no new orders
  // reports 0 segment changes). Explicitly tenant-scoped — the BI scheduler also runs this under Admin
  // (RLS-bypassing), and an HQ/Admin caller must pass an explicit tenant_id.
  async refreshAllProfiles(user: JwtUser, opts: { tenantId?: number | null } = {}) {
    const db = this.db as any;
    const tenantId = user.role === 'Admin' || user.tenantId == null ? (opts.tenantId ?? user.tenantId) : user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'tenant_id required', messageTh: 'ต้องระบุร้านค้า' });
    const BATCH = 500; let lastId = 0, profiled = 0, segmentChanges = 0;
    for (let i = 0; i < 200; i++) { // safety cap: 200 batches (100k members)
      const batch = await db.select({ id: posMembers.id }).from(posMembers)
        .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true), gt(posMembers.id, lastId)))
        .orderBy(posMembers.id).limit(BATCH);
      if (!batch.length) break;
      for (const m of batch) {
        const memberId = Number(m.id);
        const [before] = await db.select({ seg: customerProfiles.rfmSegment }).from(customerProfiles)
          .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.memberId, memberId))).limit(1);
        const r = await this.refreshProfile(tenantId, memberId);
        profiled++;
        if ((before?.seg ?? null) !== r.rfm_segment) segmentChanges++;
      }
      lastId = Number(batch[batch.length - 1].id);
      if (batch.length < BATCH) break;
    }
    return { tenant_id: tenantId, profiled, segment_changes: segmentChanges };
  }

  // 360-degree customer view
  async profile(memberId: number, user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const [p] = await db.select().from(customerProfiles).where(and(eq(customerProfiles.memberId, memberId))).limit(1);
    const recent = await db.select({ orderNo: dineInOrders.orderNo, total: dineInOrders.total, channel: dineInOrders.channel, openedAt: dineInOrders.openedAt })
      .from(dineInOrders).where(and(eq(dineInOrders.memberId, memberId), isNotNull(dineInOrders.saleNo))).orderBy(desc(dineInOrders.openedAt)).limit(5);
    return {
      member: { id: Number(m.id), member_code: m.memberCode, name: m.name, phone: m.phone, balance: n(m.balance), lifetime: n(m.lifetime), tier: m.tier },
      crm: p ? {
        rfm_segment: p.rfmSegment, total_orders: p.totalOrders, total_spend: n(p.totalSpend),
        rfm_recency: p.rfmRecency, rfm_frequency: p.rfmFrequency, rfm_monetary: n(p.rfmMonetary),
        preferred_channel: p.preferredChannel, avg_order_value: n(p.avgOrderValue),
        churn_risk: p.churnRisk != null ? Number(p.churnRisk) : null,
        predicted_ltv: p.predictedLtv != null ? n(p.predictedLtv) : null,
        score_version: p.scoreVersion ?? null, refreshed_at: p.refreshedAt,
      } : null,
      recent_orders: recent.map((o: any) => ({ order_no: o.orderNo, total: n(o.total), channel: o.channel, opened_at: o.openedAt })),
    };
  }

  // CDP / data-integration export — a bulk, tenant-scoped snapshot of the member base (identity + RFM traits
  // + points + per-purpose consent) for loading into an external Customer Data Platform. Read-only; paginated.
  // Explicitly tenant-scoped (like loyalty analytics): HQ/Admin must pass tenant_id (no cross-tenant export).
  // Consent flags ship WITH each row so the downstream CDP can honour opt-outs — the export never itself
  // sends anything. (For a single data-subject access/erasure request, use the PDPA DSAR endpoints instead.)
  async exportForCdp(user: JwtUser, opts: { tenantId?: number | null; limit?: number; offset?: number }) {
    const db = this.db as any;
    const tenantId = opts.tenantId ?? user.tenantId;
    if (tenantId == null) return { error: { code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' } };
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const rows = await db.select({
      id: posMembers.id, code: posMembers.memberCode, name: posMembers.name, phone: posMembers.phone,
      email: posMembers.email, lineUserId: posMembers.lineUserId, tier: posMembers.tier,
      balance: posMembers.balance, lifetime: posMembers.lifetime, marketingOptIn: posMembers.marketingOptIn,
      segment: customerProfiles.rfmSegment, totalOrders: customerProfiles.totalOrders, totalSpend: customerProfiles.totalSpend,
      rfmRecency: customerProfiles.rfmRecency, rfmFrequency: customerProfiles.rfmFrequency, rfmMonetary: customerProfiles.rfmMonetary,
      preferredChannel: customerProfiles.preferredChannel, avgOrderValue: customerProfiles.avgOrderValue, lastOrderAt: customerProfiles.lastOrderAt,
    }).from(posMembers).leftJoin(customerProfiles, eq(customerProfiles.memberId, posMembers.id))
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true)))
      .orderBy(posMembers.id).limit(limit).offset(offset);

    // Per-purpose consent for exactly the members in this page (granted flag; withdrawn if withdrawnAt set).
    const ids = rows.map((r: any) => Number(r.id));
    const consentMap = new Map<number, Record<string, boolean>>();
    if (ids.length) {
      const cons = await db.select({ memberId: memberConsents.memberId, purpose: memberConsents.purpose, granted: memberConsents.granted })
        .from(memberConsents).where(and(eq(memberConsents.tenantId, tenantId), inArray(memberConsents.memberId, ids)));
      for (const c of cons) {
        const m = consentMap.get(Number(c.memberId)) ?? {};
        m[c.purpose] = c.granted === true;
        consentMap.set(Number(c.memberId), m);
      }
    }
    const [tot] = await db.select({ c: sql<number>`count(*)` }).from(posMembers).where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true)));

    // ICFR egress trail: a bulk PII export is a sensitive read — record who exported how much, when
    // (append-only auditLog, ITGC-AC-10). Best-effort: auditing never blocks the export.
    try {
      await db.insert(auditLog).values({
        actor: user?.username ?? null, tenantId, action: 'CRM.CDP_EXPORT', entity: 'member_export',
        entityId: null, status: 'success', meta: { rows: rows.length, total: Number(tot?.c ?? 0), limit, offset },
      });
    } catch { /* never throw from audit */ }

    return {
      tenant_id: tenantId, total: Number(tot?.c ?? 0), count: rows.length, limit, offset,
      members: rows.map((r: any) => {
        const c = consentMap.get(Number(r.id)) ?? {};
        return {
          member_code: r.code, name: r.name, phone: r.phone, email: r.email ?? null, has_line: !!r.lineUserId,
          tier: r.tier, points_balance: n(r.balance), lifetime_points: n(r.lifetime),
          rfm_segment: r.segment ?? null, total_orders: r.totalOrders ?? 0, total_spend: n(r.totalSpend),
          rfm: { recency: r.rfmRecency ?? null, frequency: r.rfmFrequency ?? null, monetary: n(r.rfmMonetary) },
          preferred_channel: r.preferredChannel ?? null, avg_order_value: n(r.avgOrderValue), last_order_at: r.lastOrderAt ?? null,
          // marketing opt-out drives the top-level flag; per-purpose consents (line/sms/email/profiling) fall
          // back to the marketing flag when not explicitly recorded, so the CDP has a safe default.
          consent: {
            marketing: c.marketing ?? (r.marketingOptIn === true),
            line: c.line ?? (r.marketingOptIn === true),
            sms: c.sms ?? (r.marketingOptIn === true),
            email: c.email ?? (r.marketingOptIn === true),
            profiling: c.profiling ?? true,
          },
        };
      }),
    };
  }

  // Personalized promos: filter active promos whose audience rules match this member's profile.
  async personalizedPromos(memberId: number, user: JwtUser) {
    const db = this.db as any;
    const [p] = await db.select().from(customerProfiles).where(eq(customerProfiles.memberId, memberId)).limit(1);
    const [m] = await db.select({ lifetime: posMembers.lifetime }).from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });

    const tenantId = user.tenantId!;
    if (tenantId == null) return { member_id: memberId, segment: 'New', promos: [] };
    const rules: any[] = await db.select().from(promoAudienceRules).where(
      and(eq(promoAudienceRules.tenantId, tenantId), eq(promoAudienceRules.active, true))
    );

    const lifetime = n(m.lifetime);
    const segment = p?.rfmSegment ?? 'New';
    const freq = p?.rfmFrequency ?? 0;
    const channel = p?.preferredChannel ?? null;

    const matchingPromoIds = rules.filter(r => {
      if (r.rfmSegment && r.rfmSegment !== segment) return false;
      if (r.minLifetime != null && lifetime < n(r.minLifetime)) return false;
      if (r.minFrequency != null && freq < Number(r.minFrequency)) return false;
      if (r.preferredChannel && channel && r.preferredChannel !== channel) return false;
      return true;
    }).map(r => Number(r.promoId));

    if (!matchingPromoIds.length) return { member_id: memberId, segment, promos: [] };

    const promoList: any[] = await db.select({
      id: promotions.id, promoName: promotions.promoName, promoType: promotions.promoType,
      discountPct: promotions.discountPct, discountAmt: promotions.discountAmt,
      startDate: promotions.startDate, endDate: promotions.endDate,
    }).from(promotions).where(
      and(eq(promotions.active, true), inArray(promotions.id, matchingPromoIds))
    );

    return {
      member_id: memberId, segment, promos: promoList.map((p: any) => ({
        promo_id: p.promoName, promo_type: p.promoType,
        discount_pct: n(p.discountPct), discount_amt: n(p.discountAmt),
      })),
    };
  }

  // Branch/store KPI dashboard — today's performance for the caller's tenant
  async branchKpi(user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId;
    if (tenantId == null) return { error: 'No tenant context' };

    // Bangkok midnight: offset UTC by 7h
    const now = new Date();
    const bkkOffset = 7 * 3600 * 1000;
    const todayStart = new Date(Math.floor((now.getTime() + bkkOffset) / 86400000) * 86400000 - bkkOffset);
    const todayEnd = new Date(todayStart.getTime() + 86400000);

    const todayRows: any[] = await db.select({ total: dineInOrders.total, channel: dineInOrders.channel, openedAt: dineInOrders.openedAt })
      .from(dineInOrders).where(
        and(eq(dineInOrders.tenantId, tenantId), isNotNull(dineInOrders.saleNo),
          gte(dineInOrders.openedAt, todayStart), lt(dineInOrders.openedAt, todayEnd))
      );

    const todayRevenue = todayRows.reduce((s, r) => s + n(r.total), 0);
    const todayOrders = todayRows.length;
    const avgOrderValue = todayOrders > 0 ? Math.round(todayRevenue / todayOrders * 100) / 100 : 0;

    // Channel breakdown
    const byChannel: Record<string, { count: number; revenue: number }> = {};
    for (const r of todayRows) {
      const ch = r.channel ?? 'unknown';
      if (!byChannel[ch]) byChannel[ch] = { count: 0, revenue: 0 };
      byChannel[ch].count++;
      byChannel[ch].revenue = Math.round((byChannel[ch].revenue + n(r.total)) * 100) / 100;
    }

    // Hourly distribution (BKK time)
    const hourly: number[] = new Array(24).fill(0);
    for (const r of todayRows) {
      const bkkHour = (new Date(r.openedAt).getHours() + 7 + 24) % 24;
      hourly[bkkHour] += n(r.total);
    }

    // Active members today
    const memberRows: any[] = await db.select({ memberId: dineInOrders.memberId }).from(dineInOrders).where(
      and(eq(dineInOrders.tenantId, tenantId), isNotNull(dineInOrders.memberId), isNotNull(dineInOrders.saleNo),
        gte(dineInOrders.openedAt, todayStart), lt(dineInOrders.openedAt, todayEnd))
    );
    const activeMembers = new Set(memberRows.map((r: any) => r.memberId)).size;

    return {
      date: todayStart.toISOString().slice(0, 10),
      today: { revenue: Math.round(todayRevenue * 100) / 100, orders: todayOrders, avg_order_value: avgOrderValue, active_members: activeMembers },
      by_channel: byChannel,
      hourly_revenue: hourly.map((v, h) => ({ hour: h, revenue: Math.round(v * 100) / 100 })),
    };
  }

  // Upsert a personalized promo rule
  async upsertAudienceRule(dto: { promo_id: number; rfm_segment?: string; min_lifetime?: number; min_frequency?: number; preferred_channel?: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId!;
    const [row] = await db.insert(promoAudienceRules).values({
      tenantId, promoId: dto.promo_id, rfmSegment: dto.rfm_segment ?? null,
      minLifetime: dto.min_lifetime != null ? String(dto.min_lifetime) : null,
      minFrequency: dto.min_frequency ?? null,
      preferredChannel: dto.preferred_channel ?? null, active: true,
    }).returning();
    return { id: Number(row.id), promo_id: dto.promo_id, rfm_segment: dto.rfm_segment ?? null };
  }
}
