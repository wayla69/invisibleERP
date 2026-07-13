import { eq, and, gte } from 'drizzle-orm';
import type { DrizzleDb } from '../../../database/database.module';
import { crmLeads, crmOpportunities, crmActivities, crmStageHistory } from '../../../database/schema';
import { n } from '../../../database/queries';
import type { JwtUser } from './../../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// docs/46 Phase 4b cut 1 — the read-only pipeline ANALYTICS cluster (weighted summary, win/loss, CRM-5
// funnel/velocity, source ROI, forecast categories), moved VERBATIM out of crm-pipeline.service.ts. A plain
// class constructed in the CrmPipelineService constructor BODY (docs/38 recipe); the facade keeps thin
// delegators, so the public API — and the BI providers that ride it — are byte-identical. Fully
// self-contained: pure reads over the CRM spine, tenant-scoped by RLS, no ports.
export class CrmPipelineAnalyticsService {
  constructor(private readonly db: DrizzleDb) {}

  // Weighted pipeline forecast: open opportunities by stage (count + amount + Σ amount×probability), plus
  // won/lost totals. The weighted figure is the revenue forecast finance can rely on. Open/won/lost is
  // decided by the derived status (so a custom tenant stage flagged is_won/is_lost buckets correctly).
  async pipelineSummary(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(crmOpportunities);
    const byStage: Record<string, { count: number; amount: number; weighted: number }> = {};
    let openAmount = 0, weightedForecast = 0, wonAmount = 0, lostAmount = 0;
    for (const o of rows) {
      const amt = n(o.amount); const prob = Number(o.probability) || 0;
      const s = o.stage;
      byStage[s] = byStage[s] ?? { count: 0, amount: 0, weighted: 0 };
      byStage[s].count++; byStage[s].amount = round2(byStage[s].amount + amt); byStage[s].weighted = round2(byStage[s].weighted + amt * prob / 100);
      if (o.status === 'Won') wonAmount = round2(wonAmount + amt);
      else if (o.status === 'Lost') lostAmount = round2(lostAmount + amt);
      else { openAmount = round2(openAmount + amt); weightedForecast = round2(weightedForecast + amt * prob / 100); }
    }
    const closed = wonAmount + lostAmount;
    return { by_stage: byStage, open_amount: openAmount, weighted_forecast: weightedForecast, won_amount: wonAmount, lost_amount: lostAmount, win_rate: closed > 0 ? round2(wonAmount / closed) : 0 };
  }

  // Win/loss analytics for the dashboard: the headline summary plus breakdowns by loss reason, by owner (with
  // each owner's win rate), and a monthly won/lost/win-rate trend — everything a sales leader needs to see why
  // deals are won or lost. Tenant-scoped by RLS.
  async winLoss(user: JwtUser, dto?: { months?: number }) {
    const db = this.db;
    // CRM-5: bound the scan by created_at SERVER-SIDE (was a full-history table scan). The `months` window
    // is now enforced in SQL, not just used to slice the monthly array — so the query cost is O(window), and
    // the by-owner / loss-reason breakdowns reflect the same period as the monthly trend. Tenant-scoped by RLS.
    const { months, since } = this.analyticsWindow(dto?.months);
    const rows = await db.select().from(crmOpportunities).where(gte(crmOpportunities.createdAt, since));
    const lossReasons: Record<string, { count: number; amount: number }> = {};
    const byOwner: Record<string, { won: number; lost: number; open: number; won_amount: number; lost_amount: number }> = {};
    const byMonth: Record<string, { month: string; won: number; lost: number; created: number; won_amount: number }> = {};
    for (const o of rows) {
      const amt = n(o.amount), s = o.status, owner = o.owner || 'unassigned';
      byOwner[owner] = byOwner[owner] ?? { won: 0, lost: 0, open: 0, won_amount: 0, lost_amount: 0 };
      if (s === 'Won') { byOwner[owner].won++; byOwner[owner].won_amount = round2(byOwner[owner].won_amount + amt); }
      else if (s === 'Lost') {
        byOwner[owner].lost++; byOwner[owner].lost_amount = round2(byOwner[owner].lost_amount + amt);
        const reason = o.lostReason || 'ไม่ระบุ (unspecified)';
        lossReasons[reason] = lossReasons[reason] ?? { count: 0, amount: 0 };
        lossReasons[reason].count++; lossReasons[reason].amount = round2(lossReasons[reason].amount + amt);
      } else byOwner[owner].open++;
      // Monthly velocity, keyed on the creation month (YYYY-MM).
      const m = o.createdAt ? new Date(o.createdAt).toISOString().slice(0, 7) : null;
      if (m) {
        byMonth[m] = byMonth[m] ?? { month: m, won: 0, lost: 0, created: 0, won_amount: 0 };
        byMonth[m].created++;
        if (s === 'Won') { byMonth[m].won++; byMonth[m].won_amount = round2(byMonth[m].won_amount + amt); }
        else if (s === 'Lost') byMonth[m].lost++;
      }
    }
    const loss_reasons = Object.entries(lossReasons).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.amount - a.amount);
    const by_owner = Object.entries(byOwner).map(([owner, v]) => {
      const decided = v.won + v.lost;
      return { owner, ...v, win_rate: decided > 0 ? round2((v.won / decided) * 100) : 0 };
    }).sort((a, b) => b.won_amount - a.won_amount);
    const monthly = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)).slice(-months)
      .map((m) => ({ ...m, win_rate_pct: (m.won + m.lost) > 0 ? round2((m.won / (m.won + m.lost)) * 100) : 0 }));
    return { window_months: months, summary: await this.pipelineSummary(user), loss_reasons, by_owner, monthly };
  }

  // ── CRM-5 — analytics that answer "why" (funnel, velocity, source ROI, forecast categories) ────────────
  // Read-only aggregators on the CRM spine (crm_leads / crm_opportunities / crm_stage_history / crm_activities),
  // surfaced as BI report types (crm_funnel / crm_source_roi / crm_forecast). Every scan is bounded by a
  // SERVER-SIDE created_at/changed_at window (default 6 months, clamped 1..24) and tenant-scoped by RLS.
  private analyticsWindow(months?: number): { months: number; since: Date } {
    const m = Math.max(1, Math.min(24, Math.trunc(Number(months)) || 6));
    const since = new Date();
    since.setMonth(since.getMonth() - m);
    return { months: m, since };
  }

  // Funnel conversion (lead → qualified → opportunity → won) plus stage-to-stage progression and
  // time-in-stage VELOCITY, both derived from the crm_stage_history audit trail (CRM-1). Answers "where in the
  // funnel do deals stall, and how long do they sit in each stage?".
  async funnel(user: JwtUser, dto?: { months?: number }) {
    const db = this.db;
    const { months, since } = this.analyticsWindow(dto?.months);
    const pct = (num: number, den: number) => den > 0 ? round2((num / den) * 100) : 0;

    const leads = await db.select({ status: crmLeads.status }).from(crmLeads).where(gte(crmLeads.createdAt, since));
    let leadTotal = 0, qualified = 0, convertedLeads = 0;
    for (const l of leads) {
      leadTotal++;
      if (l.status === 'qualified' || l.status === 'converted') qualified++;
      if (l.status === 'converted') convertedLeads++;
    }

    const opps = await db.select({ status: crmOpportunities.status, amount: crmOpportunities.amount, createdAt: crmOpportunities.createdAt, closedAt: crmOpportunities.closedAt })
      .from(crmOpportunities).where(gte(crmOpportunities.createdAt, since));
    let oppTotal = 0, won = 0, wonAmount = 0;
    for (const o of opps) { oppTotal++; if (o.status === 'Won') { won++; wonAmount = round2(wonAmount + n(o.amount)); } }

    const funnel = [
      { stage: 'leads', label: 'ลูกค้ามุ่งหวัง (Leads)', count: leadTotal, conv_from_prev_pct: 100 },
      { stage: 'qualified', label: 'ผ่านคุณสมบัติ (Qualified)', count: qualified, conv_from_prev_pct: pct(qualified, leadTotal) },
      { stage: 'opportunities', label: 'โอกาสการขาย (Opportunities)', count: oppTotal, conv_from_prev_pct: pct(oppTotal, qualified || leadTotal) },
      { stage: 'won', label: 'ปิดการขายได้ (Won)', count: won, conv_from_prev_pct: pct(won, oppTotal) },
    ];

    // Stage-to-stage progression + time-in-stage velocity from the append-only audit trail.
    const hist = await db.select({ opportunityId: crmStageHistory.opportunityId, toStage: crmStageHistory.toStage, changedAt: crmStageHistory.changedAt })
      .from(crmStageHistory).where(gte(crmStageHistory.changedAt, since))
      .orderBy(crmStageHistory.opportunityId, crmStageHistory.changedAt, crmStageHistory.id);
    const byOpp = new Map<number, { to: string; at: number }[]>();
    for (const h of hist) {
      const oid = Number(h.opportunityId);
      const at = h.changedAt ? new Date(h.changedAt as unknown as string).getTime() : 0;
      const arr = byOpp.get(oid) ?? [];
      arr.push({ to: h.toStage, at });
      byOpp.set(oid, arr);
    }
    const reached: Record<string, number> = {};
    const stageDur: Record<string, { total_ms: number; samples: number }> = {};
    for (const seq of byOpp.values()) {
      const seen = new Set<string>();
      for (let i = 0; i < seq.length; i++) {
        const cur = seq[i]!;
        if (!seen.has(cur.to)) { reached[cur.to] = (reached[cur.to] ?? 0) + 1; seen.add(cur.to); }
        const next = seq[i + 1];
        if (next && next.at >= cur.at) {
          const d = stageDur[cur.to] ?? { total_ms: 0, samples: 0 };
          d.total_ms += next.at - cur.at; d.samples++;
          stageDur[cur.to] = d;
        }
      }
    }
    const stage_progression = Object.entries(reached)
      .map(([stage, count]) => ({ stage, opportunities_reached: count }))
      .sort((a, b) => b.opportunities_reached - a.opportunities_reached);
    const velocity = Object.entries(stageDur)
      .map(([stage, v]) => ({ stage, avg_days_in_stage: round2(v.total_ms / v.samples / 86400000), samples: v.samples }))
      .sort((a, b) => b.avg_days_in_stage - a.avg_days_in_stage);

    // Overall sales cycle: average days from creation to close for deals won in the window.
    const cycleDays = opps
      .filter((o) => o.status === 'Won' && o.createdAt && o.closedAt)
      .map((o) => (new Date(o.closedAt as unknown as string).getTime() - new Date(o.createdAt as unknown as string).getTime()) / 86400000)
      .filter((d) => d >= 0);
    const avg_sales_cycle_days = cycleDays.length ? round2(cycleDays.reduce((s, d) => s + d, 0) / cycleDays.length) : 0;

    return {
      window_months: months,
      funnel,
      overall_conversion_pct: pct(won, leadTotal),   // lead → won
      lead_to_opp_pct: pct(convertedLeads, leadTotal),
      won_amount: wonAmount,
      stage_progression,
      velocity,
      avg_sales_cycle_days,
    };
  }

  // Source ROI: lead source → won revenue (and win rate / average deal size per source). Opportunities carry a
  // lead_no provenance link; an opp with no originating lead is bucketed 'direct'. Answers "which channels
  // actually convert to revenue?".
  async sourceRoi(user: JwtUser, dto?: { months?: number }) {
    const db = this.db;
    const { months, since } = this.analyticsWindow(dto?.months);
    const leads = await db.select({ leadNo: crmLeads.leadNo, source: crmLeads.source, createdAt: crmLeads.createdAt }).from(crmLeads);
    const srcByLead = new Map<string, string>();
    const leadCount: Record<string, number> = {};
    for (const l of leads) {
      const src = (l.source || 'direct').trim() || 'direct';
      if (l.leadNo) srcByLead.set(l.leadNo, src);
      if (l.createdAt && new Date(l.createdAt as unknown as string) >= since) leadCount[src] = (leadCount[src] ?? 0) + 1;
    }
    const opps = await db.select({ leadNo: crmOpportunities.leadNo, status: crmOpportunities.status, amount: crmOpportunities.amount })
      .from(crmOpportunities).where(gte(crmOpportunities.createdAt, since));
    const bySrc: Record<string, { source: string; leads: number; opps: number; won: number; lost: number; won_amount: number; open_amount: number }> = {};
    const bucket = (src: string) => (bySrc[src] = bySrc[src] ?? { source: src, leads: leadCount[src] ?? 0, opps: 0, won: 0, lost: 0, won_amount: 0, open_amount: 0 });
    for (const src of Object.keys(leadCount)) bucket(src); // sources with leads but no opp yet
    for (const o of opps) {
      const src = (o.leadNo && srcByLead.get(o.leadNo)) || 'direct';
      const b = bucket(src);
      b.opps++;
      const amt = n(o.amount);
      if (o.status === 'Won') { b.won++; b.won_amount = round2(b.won_amount + amt); }
      else if (o.status === 'Lost') b.lost++;
      else b.open_amount = round2(b.open_amount + amt);
    }
    const sources = Object.values(bySrc).map((b) => {
      const decided = b.won + b.lost;
      return {
        ...b,
        win_rate_pct: decided > 0 ? round2((b.won / decided) * 100) : 0,
        avg_won_deal: b.won > 0 ? round2(b.won_amount / b.won) : 0,
        lead_to_won_pct: b.leads > 0 ? round2((b.won / b.leads) * 100) : 0,
      };
    }).sort((a, b) => b.won_amount - a.won_amount);
    const total_won = round2(sources.reduce((s, r) => s + r.won_amount, 0));
    return { window_months: months, sources, total_won };
  }

  // Forecast categories (commit / best-case / pipeline) from OPEN opportunities by probability band, plus
  // quota attainment per owner (won-in-window vs an optional per-owner quota supplied in the report filters)
  // and an activity leaderboard. Answers "what will we close, and who is carrying it?".
  async forecast(user: JwtUser, dto?: { months?: number; quotas?: Record<string, number> }) {
    const db = this.db;
    const { months, since } = this.analyticsWindow(dto?.months);

    // Forecast categories: open pipeline split by the row's forecast weight (probability).
    const open = await db.select({ amount: crmOpportunities.amount, probability: crmOpportunities.probability })
      .from(crmOpportunities).where(eq(crmOpportunities.status, 'Open'));
    const mk = () => ({ count: 0, amount: 0, weighted: 0 });
    const categories = { commit: mk(), best_case: mk(), pipeline: mk() };
    for (const o of open) {
      const amt = n(o.amount), p = Number(o.probability) || 0;
      const b = p >= 70 ? categories.commit : p >= 40 ? categories.best_case : categories.pipeline;
      b.count++; b.amount = round2(b.amount + amt); b.weighted = round2(b.weighted + amt * p / 100);
    }
    // Commit is booked at full value; best-case + pipeline enter the forecast at their weighted (risk-adjusted) value.
    const forecast_amount = round2(categories.commit.amount + categories.best_case.weighted + categories.pipeline.weighted);

    // Quota attainment: won amount per owner within the window vs an optional per-owner quota (filters.quotas).
    const wonRows = await db.select({ owner: crmOpportunities.owner, amount: crmOpportunities.amount })
      .from(crmOpportunities).where(and(eq(crmOpportunities.status, 'Won'), gte(crmOpportunities.createdAt, since)));
    const wonByOwner: Record<string, number> = {};
    for (const o of wonRows) { const owner = o.owner || 'unassigned'; wonByOwner[owner] = round2((wonByOwner[owner] ?? 0) + n(o.amount)); }
    const quotas = dto?.quotas ?? {};
    const quota_attainment = Object.entries(wonByOwner).map(([owner, wonAmt]) => {
      const quota = Number(quotas[owner]) || 0;
      return { owner, won_amount: wonAmt, quota, attainment_pct: quota > 0 ? round2((wonAmt / quota) * 100) : null };
    }).sort((a, b) => b.won_amount - a.won_amount);

    // Activity leaderboard: logged CRM activities per owner within the window (total + completed).
    const acts = await db.select({ owner: crmActivities.owner, done: crmActivities.done }).from(crmActivities).where(gte(crmActivities.createdAt, since));
    const actByOwner: Record<string, { owner: string; total: number; done: number }> = {};
    for (const a of acts) { const owner = a.owner || 'unassigned'; const e = actByOwner[owner] ?? { owner, total: 0, done: 0 }; e.total++; if (a.done) e.done++; actByOwner[owner] = e; }
    const activity_leaderboard = Object.values(actByOwner)
      .map((v) => ({ ...v, completion_pct: v.total > 0 ? round2((v.done / v.total) * 100) : 0 }))
      .sort((a, b) => b.total - a.total);

    return { window_months: months, categories, forecast_amount, quota_attainment, activity_leaderboard };
  }
}
