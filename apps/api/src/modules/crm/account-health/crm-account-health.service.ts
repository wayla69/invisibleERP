import { Inject, Injectable, Optional, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { eq, and, ne, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmAccounts, crmOpportunities, crmActivities, crmAccountHealthSnapshots } from '../../../database/schema/crm-pipeline';
import { serviceCases } from '../../../database/schema/service-cases';
import { ymd } from '../../../database/queries';
import { type JwtUser } from '../../../common/decorators';
import { CollectionsService } from '../../finance/collections.service';

// docs/46 Phase 5 — split VERBATIM out of the single-file crm-account-health.module.ts (service/controller/
// module convention; no DI or behaviour change). DealTypeBody is exported for the controller.
// ── CRM-15 — B2B account HEALTH / churn + renewal-expansion pipeline (CRM-08, migration 0370) ────────
// A read-mostly DETECTIVE layer on the REV-17 CRM spine. A per-account health SCORE is computed from
// account-specific signals — engagement recency (last activity across the account's deals), open pipeline,
// open/escalated(P1-P2)/SLA-breached support cases (service_cases, SVC-4/5), and win/loss balance — and
// banded healthy | watch | at_risk to rank a CHURN WATCHLIST so a slipping strategic account surfaces before
// it lapses. RENEWAL/EXPANSION opportunities (crm_opportunities.deal_type) are a tracked forward pipeline, and
// an account with a won deal but NO open renewal is flagged a renewal GAP. A schedulable daily SNAPSHOT
// (crm_account_health_snapshots, mirrors project_health_snapshots) persists the score for trend + the BI job.
// The company AR/credit position (creditStatus) is surfaced as context (tenant-level, company_level=true) but
// NOT folded into the per-account score (it is uniform across accounts in the single-company model). No GL.
// The control (CRM-08): at-risk accounts + renewal gaps are systematically surfaced — none silently churns.

const HEALTHY_MIN = 70;
const WATCH_MIN = 40;

type Signals = {
  open_weighted: number; open_count: number; won_count: number; lost_count: number;
  open_renewal: number; days_since_activity: number | null;
  open_cases: number; escalated_cases: number; breached_cases: number;
  has_history: boolean;
};

export const DealTypeBody = z.object({ deal_type: z.enum(['new', 'renewal', 'expansion']) });

// EXPLAINABLE, code-reviewed scoring (mirrors the CRM-4 lead-score posture — no trained model). Base 60,
// clamped 0..100, with a per-factor breakdown so a score is always auditable.
function computeHealth(s: Signals): { score: number; band: string; breakdown: { factor: string; points: number; detail: string }[] } {
  if (!s.has_history) return { score: 0, band: 'no_data', breakdown: [{ factor: 'no_data', points: 0, detail: 'no deals, activity or cases yet' }] };
  const bd: { factor: string; points: number; detail: string }[] = [];
  let score = 60;
  const add = (factor: string, points: number, detail: string) => { score += points; bd.push({ factor, points, detail }); };

  // Engagement — recency of the last logged activity across the account's deals.
  if (s.days_since_activity == null) add('engagement', -10, 'no activity logged');
  else if (s.days_since_activity <= 14) add('engagement', 15, `active ${s.days_since_activity}d ago`);
  else if (s.days_since_activity <= 30) add('engagement', 5, `last activity ${s.days_since_activity}d ago`);
  else if (s.days_since_activity <= 60) add('engagement', 0, `quiet ${s.days_since_activity}d`);
  else add('engagement', -20, `stale — ${s.days_since_activity}d since any activity`);

  // Open pipeline — an account with no open opportunity is disengaging.
  if (s.open_weighted > 0) add('pipeline', 12, `open weighted ${Math.round(s.open_weighted)}`);
  else add('pipeline', -12, 'no open pipeline');

  // Support strain — open / escalated / SLA-breached cases weigh on health (capped).
  const casePenalty = Math.min(24, s.open_cases * 2 + s.escalated_cases * 6 + s.breached_cases * 8);
  if (casePenalty > 0) add('support', -casePenalty, `${s.open_cases} open / ${s.escalated_cases} escalated / ${s.breached_cases} SLA-breached cases`);

  // Win/loss balance — recent net losses signal disengagement.
  if (s.lost_count > 0 && s.lost_count > s.won_count) add('win_loss', -8, `${s.lost_count} lost vs ${s.won_count} won`);

  // Renewal engagement — an open renewal/expansion deal is a positive retention signal.
  if (s.open_renewal > 0) add('renewal', 8, `${s.open_renewal} open renewal/expansion deal(s)`);

  score = Math.max(0, Math.min(100, score));
  const band = score >= HEALTHY_MIN ? 'healthy' : score >= WATCH_MIN ? 'watch' : 'at_risk';
  return { score, band, breakdown: bd };
}
@Injectable()
export class CrmAccountHealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly collections?: CollectionsService,
  ) {}

  private async accountByNo(accountNo: string, user: JwtUser) {
    const conds = [eq(crmAccounts.accountNo, accountNo)];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const [a] = await this.db.select().from(crmAccounts).where(and(...conds)).limit(1);
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', messageTh: 'ไม่พบบัญชีลูกค้า' });
    return a;
  }

  // Batch-gather the per-account signals (optionally scoped to a set of account ids). Four grouped queries.
  private async gatherSignals(user: JwtUser, accountIds?: number[]): Promise<Map<number, Signals>> {
    const db = this.db;
    const tCond = (col: any) => (user.tenantId != null ? [eq(col, user.tenantId)] : []);
    const idCond = accountIds && accountIds.length ? [inArray(crmOpportunities.accountId, accountIds)] : [];

    const oppRows = await db.select({
      accountId: crmOpportunities.accountId,
      openWeighted: sql<string>`coalesce(sum(case when ${crmOpportunities.status} = 'Open' then ${crmOpportunities.amount} * ${crmOpportunities.probability} / 100.0 else 0 end), 0)`,
      openCount: sql<string>`sum(case when ${crmOpportunities.status} = 'Open' then 1 else 0 end)`,
      wonCount: sql<string>`sum(case when ${crmOpportunities.status} = 'Won' then 1 else 0 end)`,
      lostCount: sql<string>`sum(case when ${crmOpportunities.status} = 'Lost' then 1 else 0 end)`,
      openRenewal: sql<string>`sum(case when ${crmOpportunities.status} = 'Open' and ${crmOpportunities.dealType} in ('renewal','expansion') then 1 else 0 end)`,
    }).from(crmOpportunities).where(and(sql`${crmOpportunities.accountId} is not null`, ...tCond(crmOpportunities.tenantId), ...idCond)).groupBy(crmOpportunities.accountId);

    // Last activity per account: the account's deals (opp_no) ⋈ crm_activities.entity_no.
    const actRows = await db.select({
      accountId: crmOpportunities.accountId,
      lastAt: sql<string>`max(${crmActivities.createdAt})`,
    }).from(crmOpportunities)
      .innerJoin(crmActivities, and(eq(crmActivities.entityType, 'opportunity'), eq(crmActivities.entityNo, crmOpportunities.oppNo)))
      .where(and(sql`${crmOpportunities.accountId} is not null`, ...tCond(crmOpportunities.tenantId), ...idCond))
      .groupBy(crmOpportunities.accountId);

    const caseIdCond = accountIds && accountIds.length ? [inArray(serviceCases.accountId, accountIds)] : [];
    const caseRows = await db.select({
      accountId: serviceCases.accountId,
      openCases: sql<string>`sum(case when ${serviceCases.status} in ('new','open','pending') then 1 else 0 end)`,
      escalated: sql<string>`sum(case when ${serviceCases.status} in ('new','open','pending') and ${serviceCases.priority} in ('P1','P2') then 1 else 0 end)`,
      breached: sql<string>`sum(case when ${serviceCases.status} in ('new','open','pending') and (${serviceCases.responseBreached} or ${serviceCases.resolutionBreached}) then 1 else 0 end)`,
    }).from(serviceCases).where(and(sql`${serviceCases.accountId} is not null`, ...tCond(serviceCases.tenantId), ...caseIdCond)).groupBy(serviceCases.accountId);

    const now = Date.now();
    const map = new Map<number, Signals>();
    const ensure = (id: number): Signals => {
      let s = map.get(id);
      if (!s) { s = { open_weighted: 0, open_count: 0, won_count: 0, lost_count: 0, open_renewal: 0, days_since_activity: null, open_cases: 0, escalated_cases: 0, breached_cases: 0, has_history: false }; map.set(id, s); }
      return s;
    };
    for (const r of oppRows) {
      if (r.accountId == null) continue;
      const s = ensure(Number(r.accountId));
      s.open_weighted = Number(r.openWeighted ?? 0); s.open_count = Number(r.openCount ?? 0);
      s.won_count = Number(r.wonCount ?? 0); s.lost_count = Number(r.lostCount ?? 0); s.open_renewal = Number(r.openRenewal ?? 0);
      s.has_history = true;
    }
    for (const r of actRows) {
      if (r.accountId == null || !r.lastAt) continue;
      const s = ensure(Number(r.accountId));
      s.days_since_activity = Math.max(0, Math.floor((now - new Date(r.lastAt).getTime()) / 86_400_000));
      s.has_history = true;
    }
    for (const r of caseRows) {
      if (r.accountId == null) continue;
      const s = ensure(Number(r.accountId));
      s.open_cases = Number(r.openCases ?? 0); s.escalated_cases = Number(r.escalated ?? 0); s.breached_cases = Number(r.breached ?? 0);
      if (s.open_cases > 0) s.has_history = true;
    }
    return map;
  }

  private async companyAr(user: JwtUser) {
    if (user.tenantId == null || !this.collections) return null;
    try {
      const c = await this.collections.creditStatus(user.tenantId);
      return { company_level: true, open_balance: c.exposure, overdue: c.overdue, on_hold: c.on_hold, over_limit: c.over_limit, serious_overdue: c.serious_overdue };
    } catch { return null; }
  }

  // ── Single-account health ─────────────────────────────────────────────
  async accountHealth(accountNo: string, user: JwtUser) {
    const account = await this.accountByNo(accountNo, user);
    const map = await this.gatherSignals(user, [Number(account.id)]);
    const signals = map.get(Number(account.id)) ?? { open_weighted: 0, open_count: 0, won_count: 0, lost_count: 0, open_renewal: 0, days_since_activity: null, open_cases: 0, escalated_cases: 0, breached_cases: 0, has_history: false };
    const h = computeHealth(signals);
    const renewalGap = signals.won_count > 0 && signals.open_renewal === 0; // won before, but nothing renewing now
    return { account_no: account.accountNo, name: account.name, score: h.score, band: h.band, breakdown: h.breakdown, signals, renewal_gap: renewalGap, company_ar: await this.companyAr(user) };
  }

  // ── Portfolio churn watchlist ─────────────────────────────────────────
  async portfolio(q: { band?: string }, user: JwtUser) {
    const db = this.db;
    const conds = [ne(crmAccounts.status, 'merged')];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const accounts = await db.select({ id: crmAccounts.id, accountNo: crmAccounts.accountNo, name: crmAccounts.name }).from(crmAccounts).where(and(...conds)).limit(1000);
    const map = await this.gatherSignals(user); // all accounts in tenant
    const rows = accounts.map((a: any) => {
      const s = map.get(Number(a.id)) ?? { open_weighted: 0, open_count: 0, won_count: 0, lost_count: 0, open_renewal: 0, days_since_activity: null, open_cases: 0, escalated_cases: 0, breached_cases: 0, has_history: false };
      const h = computeHealth(s);
      return { account_no: a.accountNo, name: a.name, score: h.score, band: h.band, open_weighted: Math.round(s.open_weighted), open_cases: s.open_cases, days_since_activity: s.days_since_activity, renewal_gap: s.won_count > 0 && s.open_renewal === 0 };
    });
    const filtered = q.band ? rows.filter((r) => r.band === q.band) : rows;
    // Worst first (at_risk before watch before healthy before no_data), then by ascending score.
    const bandRank: Record<string, number> = { at_risk: 0, watch: 1, healthy: 2, no_data: 3 };
    filtered.sort((a, b) => ((bandRank[a.band] ?? 9) - (bandRank[b.band] ?? 9)) || (a.score - b.score));
    const counts = { healthy: 0, watch: 0, at_risk: 0, no_data: 0 } as Record<string, number>;
    for (const r of rows) counts[r.band] = (counts[r.band] ?? 0) + 1;
    return { accounts: filtered, count: filtered.length, band_counts: counts };
  }

  // ── Renewal / expansion pipeline ──────────────────────────────────────
  async renewalPipeline(user: JwtUser) {
    const db = this.db;
    const conds = [eq(crmOpportunities.status, 'Open'), inArray(crmOpportunities.dealType, ['renewal', 'expansion'])];
    if (user.tenantId != null) conds.push(eq(crmOpportunities.tenantId, user.tenantId));
    const rows = await db.select({ oppNo: crmOpportunities.oppNo, name: crmOpportunities.name, dealType: crmOpportunities.dealType, amount: crmOpportunities.amount, probability: crmOpportunities.probability, expectedCloseDate: crmOpportunities.expectedCloseDate, accountId: crmOpportunities.accountId })
      .from(crmOpportunities).where(and(...conds)).orderBy(crmOpportunities.expectedCloseDate);
    const opps = rows.map((o: any) => ({ opp_no: o.oppNo, name: o.name, deal_type: o.dealType, amount: Number(o.amount ?? 0), probability: Number(o.probability ?? 0), weighted: Math.round(Number(o.amount ?? 0) * Number(o.probability ?? 0) / 100), expected_close_date: o.expectedCloseDate }));
    const weighted = opps.reduce((a, o) => a + o.weighted, 0);
    // Renewal gaps: accounts with a won deal but no open renewal/expansion — the churn-risk queue.
    const sig = await this.gatherSignals(user);
    const gapIds: number[] = [];
    for (const [id, s] of sig) if (s.won_count > 0 && s.open_renewal === 0) gapIds.push(id);
    let gaps: any[] = [];
    if (gapIds.length) {
      const gConds = [inArray(crmAccounts.id, gapIds)];
      if (user.tenantId != null) gConds.push(eq(crmAccounts.tenantId, user.tenantId));
      const gRows = await db.select({ accountNo: crmAccounts.accountNo, name: crmAccounts.name }).from(crmAccounts).where(and(...gConds));
      gaps = gRows.map((g: any) => ({ account_no: g.accountNo, name: g.name }));
    }
    return { renewals: opps, count: opps.length, weighted, renewal_gaps: gaps, gap_count: gaps.length };
  }

  async setDealType(oppNo: string, dealType: 'new' | 'renewal' | 'expansion', user: JwtUser) {
    const conds = [eq(crmOpportunities.oppNo, oppNo)];
    if (user.tenantId != null) conds.push(eq(crmOpportunities.tenantId, user.tenantId));
    const res = await this.db.update(crmOpportunities).set({ dealType }).where(and(...conds)).returning({ oppNo: crmOpportunities.oppNo });
    if (!res.length) throw new NotFoundException({ code: 'OPPORTUNITY_NOT_FOUND', message: 'Opportunity not found', messageTh: 'ไม่พบโอกาสการขาย' });
    return { opp_no: oppNo, deal_type: dealType };
  }

  // ── Snapshot (schedulable via the BI report) + trend ──────────────────
  async captureAllHealth(user: JwtUser) {
    const db = this.db;
    const date = ymd();
    const conds = [ne(crmAccounts.status, 'merged')];
    if (user.tenantId != null) conds.push(eq(crmAccounts.tenantId, user.tenantId));
    const accounts = await db.select({ id: crmAccounts.id }).from(crmAccounts).where(and(...conds)).limit(1000);
    const map = await this.gatherSignals(user);
    let captured = 0;
    for (const a of accounts) {
      const s = map.get(Number(a.id)) ?? { open_weighted: 0, open_count: 0, won_count: 0, lost_count: 0, open_renewal: 0, days_since_activity: null, open_cases: 0, escalated_cases: 0, breached_cases: 0, has_history: false };
      const h = computeHealth(s);
      await db.insert(crmAccountHealthSnapshots).values({
        tenantId: user.tenantId ?? null, accountId: Number(a.id), snapshotDate: date, score: h.score, band: h.band, signals: s as unknown as Record<string, unknown>, createdBy: user.username,
      }).onConflictDoUpdate({ target: [crmAccountHealthSnapshots.tenantId, crmAccountHealthSnapshots.accountId, crmAccountHealthSnapshots.snapshotDate], set: { score: h.score, band: h.band, signals: s as unknown as Record<string, unknown>, createdAt: new Date() } });
      captured++;
    }
    return { as_of: date, scanned: accounts.length, captured };
  }

  async healthHistory(accountNo: string, user: JwtUser) {
    const account = await this.accountByNo(accountNo, user);
    const conds = [eq(crmAccountHealthSnapshots.accountId, Number(account.id))];
    if (user.tenantId != null) conds.push(eq(crmAccountHealthSnapshots.tenantId, user.tenantId));
    const rows = await this.db.select({ date: crmAccountHealthSnapshots.snapshotDate, score: crmAccountHealthSnapshots.score, band: crmAccountHealthSnapshots.band }).from(crmAccountHealthSnapshots).where(and(...conds)).orderBy(crmAccountHealthSnapshots.snapshotDate);
    return { account_no: account.accountNo, history: rows.map((r: any) => ({ date: r.date, score: r.score, band: r.band })) };
  }
}
