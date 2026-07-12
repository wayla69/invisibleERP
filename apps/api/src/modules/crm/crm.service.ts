import { Inject, Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, and, isNotNull, desc, sql, gt, gte, lt, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, promoAudienceRules } from '../../database/schema/crm';
import { posMembers } from '../../database/schema/loyalty-members';
import { memberConsents } from '../../database/schema/member-consents';
import { auditLog, audienceExports } from '../../database/schema';
import { dineInOrders } from '../../database/schema/restaurant';
import { npsResponses, recoveryCases } from '../../database/schema/nps';
import { promotions } from '../../database/schema/marketing';
import { crmAccounts, crmOpportunities } from '../../database/schema/crm-pipeline';
import { quotes } from '../../database/schema/cpq';
import { orders } from '../../database/schema/sales';
import { n } from '../../database/queries';
import { CrmAccountsService } from './accounts/crm-accounts.module';
import { FinanceService } from '../finance/finance.service';
import { CollectionsService } from '../finance/collections.service';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round(x * 100) / 100;

// Predictive scoring (Growth Engine G3, docs/25) — EXPLAINABLE versioned weighted formula, deliberately
// not a trained model (SOX posture: coefficients are code-reviewed + documented in
// docs/ops/predictive-scoring.md; every stored score carries SCORE_VERSION). Null until ≥1 paid order.
export const SCORE_VERSION = 'v2'; // v2 adds preferred_hour (H3, docs/26) — churn/LTV formulas unchanged from v1
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
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    // CRM-3 Customer 360 (docs/42) — reuse the existing account/finance services rather than re-deriving.
    // @Optional so partial harnesses that construct CrmService without the finance graph still boot.
    @Optional() private readonly accounts?: CrmAccountsService,
    @Optional() private readonly finance?: FinanceService,
    @Optional() private readonly collections?: CollectionsService,
  ) {}

  // Compute and upsert the customer_profile for one member.
  // Aggregates from dine_in_orders (channel/online/kiosk) where member_id is set.
  async refreshProfile(tenantId: number, memberId: number) {
    const db = this.db;
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
    // H3 (docs/26) — preferred send hour: histogram MODE of paid-order hours in Asia/Bangkok (ties →
    // earliest hour); null under 3 orders (no signal — journey falls back to its default hour).
    let preferredHour: number | null = null;
    if (totalOrders >= 3) {
      const histo = new Array(24).fill(0);
      for (const r of rows) histo[(new Date(r.openedAt).getUTCHours() + 7) % 24]++;
      preferredHour = histo.indexOf(Math.max(...histo));
    }
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
      churnRisk, predictedLtv: predictedLtv != null ? String(predictedLtv) : null, scoreVersion: SCORE_VERSION, preferredHour,
      refreshedAt: new Date(),
    };

    await db.insert(customerProfiles).values(vals).onConflictDoUpdate({
      target: [customerProfiles.tenantId, customerProfiles.memberId],
      set: { ...vals },
    });

    return { member_id: memberId, rfm_segment: segment, total_orders: totalOrders, total_spend: totalSpend, rfm_recency: rfmRecency, rfm_frequency: rfmFrequency, rfm_monetary: rfmMonetary, churn_risk: churnRisk, predicted_ltv: predictedLtv, score_version: SCORE_VERSION, preferred_hour: preferredHour };
  }

  // Phase F2 (docs/27) — bulk RFM re-profiling. Sweeps the tenant's ACTIVE members in id-keyed batches
  // through the single reviewed refreshProfile() path (no new scoring logic), so segments and analytics stop
  // drifting stale between orders. Idempotent (the profile is a pure upsert; a re-run with no new orders
  // reports 0 segment changes). Explicitly tenant-scoped — the BI scheduler also runs this under Admin
  // (RLS-bypassing), and an HQ/Admin caller must pass an explicit tenant_id.
  async refreshAllProfiles(user: JwtUser, opts: { tenantId?: number | null } = {}) {
    const db = this.db;
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
      lastId = Number(batch[batch.length - 1]!.id);
      if (batch.length < BATCH) break;
    }
    return { tenant_id: tenantId, profiled, segment_changes: segmentChanges };
  }

  // 360-degree customer view
  async profile(memberId: number, user: JwtUser) {
    const db = this.db;
    const [m] = await db.select().from(posMembers).where(eq(posMembers.id, memberId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found', messageTh: 'ไม่พบสมาชิก' });
    const [p] = await db.select().from(customerProfiles).where(and(eq(customerProfiles.memberId, memberId))).limit(1);
    const recent = await db.select({ orderNo: dineInOrders.orderNo, total: dineInOrders.total, channel: dineInOrders.channel, openedAt: dineInOrders.openedAt })
      .from(dineInOrders).where(and(eq(dineInOrders.memberId, memberId), isNotNull(dineInOrders.saleNo))).orderBy(desc(dineInOrders.openedAt)).limit(5);
    // W3 (docs/27): latest NPS answer — the 360 shows a detractor at a glance (service recovery).
    const [lastNps] = await db.select().from(npsResponses)
      .where(and(eq(npsResponses.memberId, memberId), isNotNull(npsResponses.respondedAt)))
      .orderBy(desc(npsResponses.respondedAt)).limit(1);
    // V2 (docs/29): an unresolved recovery case is front-and-centre on the 360.
    const [openCase] = await db.select().from(recoveryCases)
      .where(and(eq(recoveryCases.memberId, memberId), sql`${recoveryCases.status} IN ('Open','Contacted')`))
      .orderBy(desc(recoveryCases.id)).limit(1);
    return {
      member: { id: Number(m.id), member_code: m.memberCode, name: m.name, phone: m.phone, balance: n(m.balance), lifetime: n(m.lifetime), tier: m.tier },
      nps: lastNps ? { score: Number(lastNps.score), detractor: Number(lastNps.score) <= 6, comment: lastNps.comment ?? null, responded_at: lastNps.respondedAt } : null,
      recovery_case: openCase ? { id: Number(openCase.id), status: openCase.status, response_due_at: openCase.responseDueAt, overdue: openCase.status === 'Open' && openCase.responseDueAt != null && new Date(openCase.responseDueAt).getTime() < Date.now() } : null,
      crm: p ? {
        rfm_segment: p.rfmSegment, total_orders: p.totalOrders, total_spend: n(p.totalSpend),
        rfm_recency: p.rfmRecency, rfm_frequency: p.rfmFrequency, rfm_monetary: n(p.rfmMonetary),
        preferred_channel: p.preferredChannel, avg_order_value: n(p.avgOrderValue),
        churn_risk: p.churnRisk != null ? Number(p.churnRisk) : null,
        predicted_ltv: p.predictedLtv != null ? n(p.predictedLtv) : null,
        score_version: p.scoreVersion ?? null, preferred_hour: p.preferredHour != null ? Number(p.preferredHour) : null, refreshed_at: p.refreshedAt,
      } : null,
      recent_orders: recent.map((o: any) => ({ order_no: o.orderNo, total: n(o.total), channel: o.channel, opened_at: o.openedAt })),
    };
  }

  // CRM-3 Customer 360 (docs/42) — the single pre-call screen that JOINS a CRM-1 account to the money.
  // Read-only aggregator keyed on account_no: reuses CrmAccountsService (account + contacts + deals +
  // activities), the member-360 profile() (loyalty + NPS + recovery + recent orders, via a member-linked
  // contact), CollectionsService.creditStatus + FinanceService.customerStatement (AR open balance/aging +
  // credit holds + statement + last payments) and the CPQ quotes tied to the account's opportunities — so
  // a salesperson sees receivables, credit holds, open deals, quotes and loyalty in ONE payload
  // ("CRM ไม่เห็นเงิน" — the CRM can now see the money). Reuses services; never posts anything.
  // NB: AR / credit / sales-orders are tenant-scoped in the single-company model (there is no per-customer
  // AR sub-ledger), so they are surfaced as the COMPANY position and clearly labelled company_level=true.
  async customer360(accountNo: string, user: JwtUser) {
    const db = this.db;
    if (!this.accounts) throw new BadRequestException({ code: 'UNAVAILABLE', message: 'Customer 360 is unavailable in this deployment', messageTh: 'ฟีเจอร์ลูกค้า 360 ไม่พร้อมใช้งาน' });

    // 1. Account core — reuses CRM-2's account page (account fields + contacts + opportunities + activities).
    const { contacts, opportunities, opportunity_count, recent_activities, ...account } = await this.accounts.get(accountNo, user);
    const opps = opportunities ?? [];

    // 2. Deals — open vs closed, with pipeline value + probability-weighted forecast value.
    const openDeals = opps.filter((o: any) => o.status === 'Open');
    const deals = {
      count: opps.length,
      open_count: openDeals.length,
      open_value: round2(openDeals.reduce((a: number, o: any) => a + Number(o.amount ?? 0), 0)),
      weighted_value: round2(openDeals.reduce((a: number, o: any) => a + Number(o.amount ?? 0) * Number(o.probability ?? 0) / 100, 0)),
      open: openDeals,
    };

    // 3. Quotes — CPQ quotes tied to this account's opportunities (via crm_opportunity_id).
    const accConds = [eq(crmAccounts.accountNo, accountNo)];
    if (user.tenantId != null) accConds.push(eq(crmAccounts.tenantId, user.tenantId));
    const [acc] = await db.select({ id: crmAccounts.id }).from(crmAccounts).where(and(...accConds)).limit(1);
    const oppIdRows = acc ? await db.select({ id: crmOpportunities.id }).from(crmOpportunities).where(eq(crmOpportunities.accountId, Number(acc.id))) : [];
    const oppIds = oppIdRows.map((o: any) => Number(o.id));
    const quoteRows = oppIds.length
      ? await db.select({ quoteNo: quotes.quoteNo, status: quotes.status, total: quotes.total, currency: quotes.currency, issuedDate: quotes.issuedDate, expiresDate: quotes.expiresDate, createdAt: quotes.createdAt })
          .from(quotes).where(inArray(quotes.crmOpportunityId, oppIds)).orderBy(desc(quotes.id)).limit(50)
      : [];
    const quoteList = quoteRows.map((q: any) => ({ quote_no: q.quoteNo, status: q.status, total: n(q.total), currency: q.currency ?? 'THB', issued_date: q.issuedDate, expires_date: q.expiresDate, created_at: q.createdAt }));

    // 4. Loyalty — first member-linked contact → reuse the member 360 (loyalty + NPS + recovery + orders).
    const linkedMemberIds = (contacts ?? []).map((c: any) => c.member_id).filter((id: any): id is number => id != null);
    let loyalty: Awaited<ReturnType<CrmService['profile']>> | null = null;
    if (linkedMemberIds.length) {
      try { loyalty = await this.profile(linkedMemberIds[0]!, user); } catch { loyalty = null; }
    }

    // 5. Finance — the COMPANY AR position + statement summary + last payments (tenant-level; see note above).
    let finance: any = null;
    if (user.tenantId != null && this.collections) {
      const credit = await this.collections.creditStatus(user.tenantId);
      let statement: any = null;
      let lastPayments: any[] = [];
      if (this.finance) {
        const st = await this.finance.customerStatement(user.tenantId);
        statement = { opening_balance: st.opening_balance, closing_balance: st.closing_balance, total_charges: st.total_charges, total_payments: st.total_payments, reporting_currency: st.reporting_currency };
        lastPayments = (st.lines ?? []).filter((l: any) => l.type === 'receipt').slice(-5).reverse()
          .map((l: any) => ({ date: l.date, ref: l.ref, amount: l.payment, currency: l.doc_currency }));
      }
      finance = {
        company_level: true, // tenant-scoped AR/credit — no per-customer sub-ledger in this model
        open_balance: credit.exposure, overdue: credit.overdue, max_overdue_days: credit.max_overdue_days,
        credit_limit: credit.credit_limit, available_credit: credit.available_credit, credit_term: credit.credit_term,
        on_hold: credit.on_hold, hold_reason: credit.hold_reason, over_limit: credit.over_limit, serious_overdue: credit.serious_overdue,
        statement, last_payments: lastPayments,
      };
    }

    // 6. Sales orders & deliveries — recent COMPANY sales orders with fulfilment status (tenant-level).
    const soRows = user.tenantId != null
      ? await db.select({ orderNo: orders.orderNo, status: orders.status, orderDate: orders.orderDate, estimatedDelivery: orders.estimatedDelivery, currency: orders.currency })
          .from(orders).where(eq(orders.tenantId, user.tenantId)).orderBy(desc(orders.id)).limit(5)
      : [];
    const salesOrders = { company_level: true, recent: soRows.map((o: any) => ({ order_no: o.orderNo, status: o.status, order_date: o.orderDate, estimated_delivery: o.estimatedDelivery, currency: o.currency ?? 'THB' })) };

    return { account, contacts: contacts ?? [], opportunity_count, recent_activities: recent_activities ?? [], deals, quotes: quoteList, loyalty, finance, sales_orders: salesOrders };
  }

  // CDP / data-integration export — a bulk, tenant-scoped snapshot of the member base (identity + RFM traits
  // + points + per-purpose consent) for loading into an external Customer Data Platform. Read-only; paginated.
  // Explicitly tenant-scoped (like loyalty analytics): HQ/Admin must pass tenant_id (no cross-tenant export).
  // Consent flags ship WITH each row so the downstream CDP can honour opt-outs — the export never itself
  // sends anything. (For a single data-subject access/erasure request, use the PDPA DSAR endpoints instead.)

  // G3 (docs/45, PDPA-05) — the ads-activation export: SHA-256-hashed phone/email rows in the Meta Custom
  // Audiences / Google Customer Match ingest format. STRICTER than exportForCdp BY DESIGN:
  //   • consent is FILTERED, not carried — only members with a LIVE marketing consent row in
  //     member_consents (granted, not withdrawn) are included. NO fallback to the legacy marketingOptIn
  //     flag: the consent ledger is the legal basis, and a member with no row is EXCLUDED (fail-closed).
  //   • raw PII never leaves — email is trim+lowercased, phone normalized to E.164 digits (Thai 0x → 66x),
  //     then each is SHA-256 hashed (the exact normalization both ad platforms specify). Rows with neither
  //     identifier are skipped. No names, no member codes, no traits.
  async exportForCustomerMatch(user: JwtUser, opts: { tenantId?: number | null; limit?: number; offset?: number } = {}) {
    const db = this.db;
    const tenantId = opts.tenantId ?? user.tenantId;
    if (tenantId == null) return { error: { code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' } };
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const liveConsent = and(
      eq(memberConsents.tenantId, tenantId), eq(memberConsents.purpose, 'marketing'),
      eq(memberConsents.granted, true), sql`${memberConsents.withdrawnAt} IS NULL`,
    );
    const consentedIds = db.select({ id: memberConsents.memberId }).from(memberConsents).where(liveConsent);
    const rows = await db.select({ id: posMembers.id, phone: posMembers.phone, email: posMembers.email })
      .from(posMembers)
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true), inArray(posMembers.id, consentedIds)))
      .orderBy(posMembers.id).limit(limit).offset(offset);

    const [tot] = await db.select({ c: sql<number>`count(*)` }).from(posMembers)
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true)));
    const [cons] = await db.select({ c: sql<number>`count(*)` }).from(posMembers)
      .where(and(eq(posMembers.tenantId, tenantId), eq(posMembers.active, true), inArray(posMembers.id, consentedIds)));

    const sha = (v: string) => createHash('sha256').update(v).digest('hex');
    const normPhone = (raw: string): string | null => {
      const digits = String(raw).replace(/\D/g, '').replace(/^00/, '');
      if (digits.length < 7) return null;
      return digits.startsWith('0') ? `66${digits.slice(1)}` : digits; // Thai-first E.164, no '+'
    };
    const members = rows.flatMap((r: any) => {
      const em = r.email ? String(r.email).trim().toLowerCase() : null;
      const ph = r.phone ? normPhone(r.phone) : null;
      if (!em && !ph) return [];
      return [{ ...(em ? { hashed_email: sha(em) } : {}), ...(ph ? { hashed_phone: sha(ph) } : {}) }];
    });

    // ICFR/PDPA egress trail (ITGC-AC-10): a hashed-audience export is still a sensitive egress — record it.
    try {
      await db.insert(auditLog).values({
        actor: user?.username ?? null, tenantId, action: 'CRM.AUDIENCE_EXPORT', entity: 'audience_export',
        entityId: null, status: 'success', meta: { rows: members.length, consented: Number(cons?.c ?? 0), total: Number(tot?.c ?? 0), limit, offset },
      });
    } catch { /* never throw from audit */ }

    return {
      tenant_id: tenantId, hash_alg: 'sha256', consent_basis: 'member_consents:marketing',
      total_active: Number(tot?.c ?? 0), consented: Number(cons?.c ?? 0),
      count: members.length, limit, offset, members,
    };
  }

  // G3 — the append-only export register (PDPA-05 evidence surface).
  async audienceExportRegister(user: JwtUser, limit = 50) {
    const db = this.db;
    const rows = await db.select().from(audienceExports).orderBy(desc(audienceExports.id)).limit(Math.min(limit, 200));
    return {
      exports: rows.map((r: any) => ({
        id: r.id, purpose: r.purpose, consent_basis: r.consentBasis, target: r.target, hash_alg: r.hashAlg,
        members_considered: Number(r.membersConsidered), members_consented: Number(r.membersConsented), rows_pushed: Number(r.rowsPushed),
        status: r.status, error: r.error, ropa_activity_id: r.ropaActivityId, created_by: r.createdBy, created_at: r.createdAt,
      })),
      count: rows.length,
    };
  }

  async exportForCdp(user: JwtUser, opts: { tenantId?: number | null; limit?: number; offset?: number }) {
    const db = this.db;
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
    const db = this.db;
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
    const db = this.db;
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
      hourly[bkkHour]! += n(r.total);
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
    const db = this.db;
    const tenantId = user.tenantId!;
    const [row] = await db.insert(promoAudienceRules).values({
      tenantId, promoId: dto.promo_id, rfmSegment: dto.rfm_segment ?? null,
      minLifetime: dto.min_lifetime != null ? String(dto.min_lifetime) : null,
      minFrequency: dto.min_frequency ?? null,
      preferredChannel: dto.preferred_channel ?? null, active: true,
    }).returning();
    return { id: Number(row!.id), promo_id: dto.promo_id, rfm_segment: dto.rfm_segment ?? null };
  }
}
