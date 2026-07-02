import { Inject, Injectable, Optional, BadRequestException } from '@nestjs/common';
import { eq, and, sql, gt, lt, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { posMembers, posMemberLedger, loyaltyConfig, loyaltyRedemptions, memberCoupons, loyaltyPostingRuns, customerProfiles } from '../../../database/schema';
import { n } from '../../../database/queries';
import { BiLiveService } from '../../bi/bi-live.service';
import type { JwtUser } from '../../../common/decorators';

// CRM Phase 4 — loyalty analytics (the "liability + redemption funnel + churn" gap). Read-only aggregation
// over the existing tables; NO new schema. EVERY query is explicitly tenant-scoped (RLS is bypassed for
// Admin/HQ, who must pass an explicit tenant_id — there is no cross-tenant sum).
@Injectable()
export class LoyaltyAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly live?: BiLiveService,
  ) {}

  // Recent live points ticks (earn/redeem) for the caller's tenant — powers the analytics screen's live feed
  // by polling the shared BiLive ring buffer. Filtered to the tenant + `loyalty_points` events only.
  liveFeed(user: JwtUser, explicitTenant?: number | null, limit = 15) {
    const tenantId = this.tid(user, explicitTenant);
    const events = (this.live?.recent(tenantId, 200) ?? []).filter((e) => e.type === 'loyalty_points').slice(0, Math.min(50, Math.max(1, limit)));
    return { tenant_id: tenantId, available: !!this.live, events };
  }

  private tid(user: JwtUser, explicit?: number | null): number {
    const t = explicit ?? user.tenantId;
    if (t == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id for analytics', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' });
    return Number(t);
  }

  // At-risk = active member, still holds points, dormant past the cutoff. Shared by the overview KPI
  // count and the churn drill-down so the headline number always matches the list. Built with the typed
  // operators (NOT a raw `sql` template) so Drizzle runs the timestamp column's encoder on `cutoff`
  // (Date → ISO string); a raw `${cutoff}` would hand postgres-js a bare Date and crash on serialization.
  private atRiskWhere(cutoff: Date) {
    return and(eq(posMembers.active, true), gt(posMembers.balance, '0'), lt(posMembers.lastUpdated, cutoff));
  }

  async overview(user: JwtUser, explicitTenant?: number | null) {
    const db = this.db as any; const tenantId = this.tid(user, explicitTenant);
    const cutoff90 = new Date(Date.now() - 90 * 86_400_000); // dormant threshold

    // Members + tier mix + balances.
    const [mem] = await db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`count(*) filter (where ${posMembers.active} = true)`,
      optedIn: sql<number>`count(*) filter (where ${posMembers.marketingOptIn} = true)`,
      balance: sql<string>`coalesce(sum(${posMembers.balance}),0)`,
      lifetime: sql<string>`coalesce(sum(${posMembers.lifetime}),0)`,
      atRisk: sql<number>`count(*) filter (where ${this.atRiskWhere(cutoff90)})`,
    }).from(posMembers).where(eq(posMembers.tenantId, tenantId));
    const tierRows = await db.select({ tier: posMembers.tier, c: sql<number>`count(*)` }).from(posMembers).where(eq(posMembers.tenantId, tenantId)).groupBy(posMembers.tier);
    const tierMix: Record<string, number> = {}; for (const r of tierRows) tierMix[r.tier ?? 'None'] = Number(r.c);

    // Points movements by ledger type (Earn +, Redeem/Expire −, Adjust ±).
    const movRows = await db.select({ t: posMemberLedger.txnType, pts: sql<string>`coalesce(sum(${posMemberLedger.points}),0)` }).from(posMemberLedger).where(eq(posMemberLedger.tenantId, tenantId)).groupBy(posMemberLedger.txnType);
    const mov: Record<string, number> = {}; for (const r of movRows) mov[r.t] = n(r.pts);
    const earned = mov['Earn'] ?? 0, adjusted = mov['Adjust'] ?? 0;
    const redeemed = Math.abs(mov['Redeem'] ?? 0), expired = Math.abs(mov['Expire'] ?? 0);

    // Redemption funnel (rewards + coupons).
    const [rdm] = await db.select({ issued: sql<number>`count(*)`, used: sql<number>`count(*) filter (where ${loyaltyRedemptions.status} = 'used')` }).from(loyaltyRedemptions).where(eq(loyaltyRedemptions.tenantId, tenantId));
    const [cpn] = await db.select({ issued: sql<number>`count(*)`, used: sql<number>`count(*) filter (where ${memberCoupons.status} = 'used')` }).from(memberCoupons).where(eq(memberCoupons.tenantId, tenantId));

    // Liability (acct 2250) — latest posted run + fair value.
    const [cfg] = await db.select({ bpp: loyaltyConfig.bahtPerPoint }).from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
    const [run] = await db.select({ posted: loyaltyPostingRuns.targetLiability }).from(loyaltyPostingRuns).where(eq(loyaltyPostingRuns.tenantId, tenantId)).orderBy(desc(loyaltyPostingRuns.id)).limit(1);
    const bahtPerPoint = n(cfg?.bpp); const openPoints = n(mem.balance);
    const liabilityFairValue = round2(openPoints * bahtPerPoint);

    const totalIssued = Number(rdm?.issued ?? 0) + Number(cpn?.issued ?? 0);
    const totalUsed = Number(rdm?.used ?? 0) + Number(cpn?.used ?? 0);
    const activeTotal = Number(mem.active ?? 0);
    return {
      tenant_id: tenantId,
      members: { total: Number(mem.total ?? 0), active: activeTotal, opted_in: Number(mem.optedIn ?? 0), at_risk: Number(mem.atRisk ?? 0) },
      tier_mix: tierMix,
      points: { open_balance: openPoints, lifetime: n(mem.lifetime), earned, adjusted, redeemed, expired },
      redemption: { rewards_issued: Number(rdm?.issued ?? 0), rewards_used: Number(rdm?.used ?? 0), coupons_issued: Number(cpn?.issued ?? 0), coupons_used: Number(cpn?.used ?? 0), redemption_rate_pct: pct(totalUsed, totalIssued) },
      liability: { open_points: openPoints, baht_per_point: bahtPerPoint, fair_value: liabilityFairValue, posted_2250: n(run?.posted) },
      breakage_rate_pct: pct(expired, earned + adjusted),
      churn_rate_pct: pct(Number(mem.atRisk ?? 0), activeTotal),
      active_rate_pct: pct(activeTotal, Number(mem.total ?? 0)),
    };
  }

  // RFM segment distribution — the "Customer Segmentation / Insights" view. Aggregates the materialised
  // customer_profiles (populated by CrmService.refreshProfile) by rfm_segment: member count, total + average
  // spend, total orders. Tenant-scoped like the rest; canonical five segments always present (0-filled) so
  // the UI renders a stable set even before profiles are built. Members with no profile row group under
  // 'Unsegmented' so the counts reconcile against the member base.
  async segmentMix(user: JwtUser, explicitTenant?: number | null) {
    const db = this.db as any; const tenantId = this.tid(user, explicitTenant);
    const rows = await db.select({
      segment: sql<string>`coalesce(${customerProfiles.rfmSegment}, 'Unsegmented')`,
      members: sql<number>`count(*)`,
      totalSpend: sql<string>`coalesce(sum(${customerProfiles.totalSpend}),0)`,
      totalOrders: sql<string>`coalesce(sum(${customerProfiles.totalOrders}),0)`,
    }).from(customerProfiles).where(eq(customerProfiles.tenantId, tenantId))
      .groupBy(sql`coalesce(${customerProfiles.rfmSegment}, 'Unsegmented')`);

    const CANON = ['Champions', 'Loyal', 'At Risk', 'Lost', 'New'];
    const byKey = new Map<string, { members: number; total_spend: number; total_orders: number }>();
    for (const r of rows) byKey.set(r.segment, { members: Number(r.members), total_spend: n(r.totalSpend), total_orders: Number(r.totalOrders) });
    const keys = [...CANON, ...[...byKey.keys()].filter((k) => !CANON.includes(k))]; // canonical order, extras (incl. Unsegmented) after
    const segments = keys.map((seg) => {
      const v = byKey.get(seg) ?? { members: 0, total_spend: 0, total_orders: 0 };
      return { segment: seg, members: v.members, total_spend: round2(v.total_spend), total_orders: v.total_orders, avg_spend: v.members > 0 ? round2(v.total_spend / v.members) : 0 };
    });
    const profiled = segments.filter((s) => s.segment !== 'Unsegmented').reduce((a, s) => a + s.members, 0);
    const totalSpend = segments.reduce((a, s) => a + s.total_spend, 0);
    // G3 — value at churn risk: Σ predicted_ltv of high-risk members (churn_risk ≥ 70). An ESTIMATE from the
    // versioned scoring formula (docs/ops/predictive-scoring.md), for prioritising win-back — never posted.
    const [risk] = await db.select({
      members: sql<number>`count(*)`,
      value: sql<string>`coalesce(sum(${customerProfiles.predictedLtv}),0)`,
    }).from(customerProfiles).where(and(eq(customerProfiles.tenantId, tenantId), sql`${customerProfiles.churnRisk} >= 70`));
    return { tenant_id: tenantId, profiled_members: profiled, total_spend: round2(totalSpend), segments,
      at_risk_value: { members: Number(risk?.members ?? 0), predicted_ltv: round2(n(risk?.value)), threshold: 70 } };
  }

  // At-risk members (dormant ≥90d with points worth retaining) — for win-back campaigns.
  async churnList(user: JwtUser, explicitTenant?: number | null, limit = 100) {
    const db = this.db as any; const tenantId = this.tid(user, explicitTenant);
    const cutoff90 = new Date(Date.now() - 90 * 86_400_000);
    const rows = await db.select({ id: posMembers.id, code: posMembers.memberCode, name: posMembers.name, tier: posMembers.tier, balance: posMembers.balance, lastUpdated: posMembers.lastUpdated })
      .from(posMembers).where(and(eq(posMembers.tenantId, tenantId), this.atRiskWhere(cutoff90)))
      .orderBy(desc(posMembers.balance)).limit(Math.min(500, Math.max(1, limit)));
    return { tenant_id: tenantId, at_risk: rows.map((r: any) => ({ id: Number(r.id), member_code: r.code, name: r.name, tier: r.tier, balance: n(r.balance), last_activity: r.lastUpdated })) };
  }
}

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
