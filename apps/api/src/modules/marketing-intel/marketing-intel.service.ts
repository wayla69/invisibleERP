import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miAnalyticsSnapshots, miBudgetPlans, customerProfiles, posMembers } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { CampaignsService } from '../campaigns/campaigns.service';
import { curvesFromMmm, predictSales, optimizeAllocation, type ResponseCurve } from './mmm-optimizer';

// Marketing Intelligence push-back store (docs/48 phase 3). The standalone Python platform computes
// advanced MMM / Sentiment-Weighted RFM / TOWS in its own warehouse and PUSHES the results into the ERP
// over the public API (scope analytics:write); the ERP owns the data it renders at /marketing-intel and
// never joins across databases. This service owns mi_analytics_snapshots (append-only history) and the
// per-customer mi_rfm_segment column, and turns an RFM segment into an ERP campaign (the action loop).
export const MI_SNAPSHOT_KINDS = ['mmm', 'rfm', 'tows'] as const;
export type MiSnapshotKind = (typeof MI_SNAPSHOT_KINDS)[number];

// An rfm snapshot MAY carry per-customer assignments (customer_no ⇒ segment) so the ERP can act on them
// (campaign targeting). Bounded so a runaway push can't balloon the request.
const RfmMember = z.object({ customer_no: z.string().min(1).max(120), segment: z.string().min(1).max(80) });
export const PushSnapshotsBody = z.object({
  snapshots: z.array(z.object({
    kind: z.enum(MI_SNAPSHOT_KINDS),
    payload: z.record(z.any()),
    model_run_ref: z.string().max(120).optional(),
    members: z.array(RfmMember).max(100_000).optional(), // rfm only — ignored for mmm/tows
  })).min(1).max(MI_SNAPSHOT_KINDS.length),
});
export type PushSnapshotsDto = z.infer<typeof PushSnapshotsBody>;

// Budget Optimizer (docs/60 Phase 1) request bodies.
export const SimulateBody = z.object({ allocation: z.record(z.number().nonnegative()).refine((a) => Object.keys(a).length > 0, 'allocation required') });
export const OptimizeBody = z.object({
  budget: z.number().positive().max(1e12),
  caps: z.record(z.number().nonnegative()).optional(),
});
export const StageBudgetPlanBody = z.object({
  total_budget: z.number().positive().max(1e12),
  allocation: z.record(z.number().nonnegative()).refine((a) => Object.keys(a).length > 0, 'allocation required'),
  note: z.string().max(500).optional(),
});
export const ApproveBudgetPlanBody = z.object({ plan_no: z.string().min(1).max(60), self_approval_reason: z.string().max(500).optional() });

@Injectable()
export class MarketingIntelService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly campaigns: CampaignsService,
  ) {}

  // WRITE (public API, scope analytics:write). APPEND-only snapshot + (for rfm) the per-customer segment
  // assignment into customer_profiles.mi_rfm_segment (a column SEPARATE from the ERP's own rfm_segment).
  async pushSnapshots(body: PushSnapshotsDto, user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) {
      throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'API key is not bound to a tenant', messageTh: 'คีย์ API ไม่ได้ผูกกับผู้เช่า' });
    }
    const principal = user.apiKeyPrefix ?? user.username ?? 'apikey';
    const written: string[] = [];
    let membersApplied = 0;
    for (const s of body.snapshots) {
      await this.db.insert(miAnalyticsSnapshots)
        .values({ tenantId, kind: s.kind, payload: s.payload, modelRunRef: s.model_run_ref ?? null, source: 'mi-platform', pushedBy: principal });
      if (s.kind === 'rfm' && s.members?.length) membersApplied += await this.applyRfmMembers(tenantId, s.members);
      written.push(s.kind);
    }
    return { pushed: written.length, kinds: written, members_applied: membersApplied };
  }

  // Map the pushed customer_no (== pos_members.member_code) to member_id and stamp mi_rfm_segment on the
  // profile. Reset the tenant's assignments first so a customer dropped from a segment is cleared, then
  // set the current membership one UPDATE per segment.
  private async applyRfmMembers(tenantId: number, members: { customer_no: string; segment: string }[]): Promise<number> {
    const codes = [...new Set(members.map((m) => m.customer_no))];
    const rows = await this.db.select({ id: posMembers.id, code: posMembers.memberCode })
      .from(posMembers).where(and(eq(posMembers.tenantId, tenantId), inArray(posMembers.memberCode, codes)));
    const idByCode = new Map(rows.map((r) => [r.code as string, Number(r.id)]));

    await this.db.update(customerProfiles).set({ miRfmSegment: null }).where(eq(customerProfiles.tenantId, tenantId));

    const idsBySegment = new Map<string, number[]>();
    for (const m of members) {
      const id = idByCode.get(m.customer_no);
      if (id == null) continue;
      (idsBySegment.get(m.segment) ?? idsBySegment.set(m.segment, []).get(m.segment)!).push(id);
    }
    let applied = 0;
    for (const [segment, ids] of idsBySegment) {
      if (!ids.length) continue;
      await this.db.update(customerProfiles).set({ miRfmSegment: segment })
        .where(and(eq(customerProfiles.tenantId, tenantId), inArray(customerProfiles.memberId, ids)));
      applied += ids.length;
    }
    return applied;
  }

  // READ (internal, /marketing-intel page). RLS scopes to the caller's tenant; returns the latest snapshot
  // per kind (append-only ⇒ pick the newest) + a freshness stamp for the "last updated" / empty state.
  async getSummary(_user: JwtUser) {
    const rows = await this.db.select({
      kind: miAnalyticsSnapshots.kind,
      payload: miAnalyticsSnapshots.payload,
      modelRunRef: miAnalyticsSnapshots.modelRunRef,
      source: miAnalyticsSnapshots.source,
      pushedAt: miAnalyticsSnapshots.pushedAt,
    }).from(miAnalyticsSnapshots)
      .where(inArray(miAnalyticsSnapshots.kind, [...MI_SNAPSHOT_KINDS]))
      .orderBy(desc(miAnalyticsSnapshots.pushedAt));

    const latest: Record<string, unknown> = {};
    let updatedAt: Date | null = null;
    for (const r of rows) {
      if (!(r.kind in latest)) latest[r.kind] = { payload: r.payload, model_run_ref: r.modelRunRef, source: r.source, pushed_at: r.pushedAt };
      if (r.pushedAt && (updatedAt === null || r.pushedAt > updatedAt)) updatedAt = r.pushedAt;
    }
    return {
      mmm: latest.mmm ?? null,
      rfm: latest.rfm ?? null,
      tows: latest.tows ?? null,
      updated_at: updatedAt,
      has_data: rows.length > 0,
    };
  }

  // READ — the MMM trend: the recent runs' headline metrics (R², spend, top channel) for period comparison.
  async getMmmHistory(_user: JwtUser, limit = 12) {
    const rows = await this.db.select({ payload: miAnalyticsSnapshots.payload, modelRunRef: miAnalyticsSnapshots.modelRunRef, pushedAt: miAnalyticsSnapshots.pushedAt })
      .from(miAnalyticsSnapshots)
      .where(eq(miAnalyticsSnapshots.kind, 'mmm'))
      .orderBy(desc(miAnalyticsSnapshots.pushedAt))
      .limit(Math.min(Math.max(limit, 1), 60));
    return {
      runs: rows.map((r) => {
        const p: any = r.payload ?? {};
        const channels: any[] = Array.isArray(p.channels) ? p.channels : [];
        const top = channels.length ? [...channels].sort((a, b) => (Number(b?.roi) || 0) - (Number(a?.roi) || 0))[0] : null;
        return {
          pushed_at: r.pushedAt,
          model_run_ref: r.modelRunRef,
          r2: p.r2 ?? null,
          total_spend: p.total_spend ?? null,
          top_channel: top ? String(top.channel) : null,
          top_channel_roi: top?.roi ?? null,
        };
      }),
    };
  }

  // How many members currently carry each pushed segment (for the "activate" affordance on the page).
  async segmentCounts(user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) return { segments: [] };
    const rows = await this.db.select({ segment: customerProfiles.miRfmSegment, count: customerProfiles.memberId })
      .from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId)));
    const counts = new Map<string, number>();
    for (const r of rows) { if (r.segment) counts.set(r.segment as string, (counts.get(r.segment as string) ?? 0) + 1); }
    return { segments: [...counts.entries()].map(([segment, members]) => ({ segment, members })).sort((a, b) => b.members - a.members) };
  }

  // ACTION LOOP — turn a pushed RFM segment into a DRAFT ERP campaign (audience=mi_segment). It reuses the
  // existing consent-gated campaign delivery; a human edits the body + sends (never auto-blasts).
  async activateSegment(dto: { segment: string; channel?: 'sms' | 'email' | 'line'; body?: string }, user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const seg = (dto.segment ?? '').trim();
    if (!seg) throw new BadRequestException({ code: 'NO_SEGMENT', message: 'segment required', messageTh: 'ต้องระบุกลุ่ม' });
    const present = await this.db.select({ id: customerProfiles.memberId }).from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.miRfmSegment, seg))).limit(1);
    if (!present.length) throw new BadRequestException({ code: 'EMPTY_SEGMENT', message: `no members in segment "${seg}" — push RFM first`, messageTh: 'ไม่มีสมาชิกในกลุ่มนี้ (ยังไม่ push RFM)' });
    return this.campaigns.upsertCampaign(user, {
      name: `MI · ${seg}`,
      channel: dto.channel ?? 'sms',
      audience: 'mi_segment',
      segment: seg,
      body: dto.body ?? `ข้อความถึงกลุ่ม ${seg} (แก้ไขก่อนส่ง)`,
    });
  }

  // ─── Budget Optimizer (docs/60 Phase 1, control MKT-17) ──────────────────────────────────────────────
  // Load the latest MMM snapshot's per-channel response curves (pushed saturation params, or a derived
  // fallback from spend/roi so the planner works before the platform pushes precise params).
  private async loadCurves(): Promise<{ curves: ResponseCurve[]; basis: string; anyDerived: boolean; hasData: boolean }> {
    const [row] = await this.db.select({ payload: miAnalyticsSnapshots.payload, modelRunRef: miAnalyticsSnapshots.modelRunRef })
      .from(miAnalyticsSnapshots).where(eq(miAnalyticsSnapshots.kind, 'mmm'))
      .orderBy(desc(miAnalyticsSnapshots.pushedAt)).limit(1);
    if (!row) return { curves: [], basis: 'none', anyDerived: false, hasData: false };
    const { curves, anyDerived } = curvesFromMmm(row.payload);
    return { curves, basis: anyDerived ? 'derived' : (row.modelRunRef ?? 'mmm'), anyDerived, hasData: curves.length > 0 };
  }

  // READ — the response curves + each channel's current spend/predicted, for the planner's charts.
  async responseCurves(_user: JwtUser) {
    const { curves, basis, anyDerived, hasData } = await this.loadCurves();
    const current = predictSales(Object.fromEntries(curves.map((c) => [c.channel, c.currentSpend])), curves);
    return {
      has_data: hasData,
      basis,
      derived: anyDerived,
      current_spend: curves.reduce((s, c) => s + c.currentSpend, 0),
      current_predicted_sales: current.total,
      channels: curves.map((c) => ({ channel: c.channel, current_spend: c.currentSpend, roi: c.roi, beta: c.beta, kappa: c.kappa, slope: c.slope, derived: c.derived })),
    };
  }

  // What-if: predicted incremental sales for a proposed allocation (deterministic, no external call).
  async simulate(_user: JwtUser, body: z.infer<typeof SimulateBody>) {
    const { curves, basis, hasData } = await this.loadCurves();
    if (!hasData) throw new BadRequestException({ code: 'NO_MMM_DATA', message: 'no MMM snapshot to simulate against — push an MMM run first', messageTh: 'ยังไม่มีผล MMM ให้จำลอง (ต้อง push MMM ก่อน)' });
    const pred = predictSales(body.allocation, curves);
    return { basis, total_budget: Object.values(body.allocation).reduce((s, v) => s + v, 0), predicted_sales: pred.total, per_channel: pred.perChannel };
  }

  // Optimise: the allocation of `budget` that maximises predicted incremental sales (greedy water-filling).
  async optimize(_user: JwtUser, body: z.infer<typeof OptimizeBody>) {
    const { curves, basis, hasData } = await this.loadCurves();
    if (!hasData) throw new BadRequestException({ code: 'NO_MMM_DATA', message: 'no MMM snapshot to optimise against — push an MMM run first', messageTh: 'ยังไม่มีผล MMM ให้ค้นหางบที่เหมาะสม (ต้อง push MMM ก่อน)' });
    const res = optimizeAllocation(body.budget, curves, { caps: body.caps });
    return { basis, ...res };
  }

  // STAGE a budget plan for approval (advisory — never posts spend). Maker-checker: a DIFFERENT user must
  // approve (approveBudgetPlan). Gated to the planning duties in the controller.
  async stageBudgetPlan(user: JwtUser, body: z.infer<typeof StageBudgetPlanBody>) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const { curves, basis, hasData } = await this.loadCurves();
    if (!hasData) throw new BadRequestException({ code: 'NO_MMM_DATA', message: 'no MMM snapshot — push an MMM run first', messageTh: 'ยังไม่มีผล MMM (ต้อง push ก่อน)' });
    const predicted = predictSales(body.allocation, curves).total;
    const todayCount = (await this.db.select({ id: miBudgetPlans.id }).from(miBudgetPlans).where(eq(miBudgetPlans.tenantId, tenantId))).length;
    const d = new Date();
    const planNo = `BP-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(todayCount + 1).padStart(3, '0')}`;
    await this.db.insert(miBudgetPlans).values({
      tenantId, planNo, totalBudget: String(body.total_budget), allocation: body.allocation,
      predictedSales: String(predicted), basis, status: 'Pending', note: body.note ?? null,
      requestedBy: user.username ?? 'user',
    });
    return { plan_no: planNo, status: 'Pending', predicted_sales: predicted, basis };
  }

  async listBudgetPlans(user: JwtUser, limit = 20) {
    const tenantId = user.tenantId;
    if (tenantId == null) return { plans: [] };
    const rows = await this.db.select().from(miBudgetPlans)
      .where(eq(miBudgetPlans.tenantId, tenantId)).orderBy(desc(miBudgetPlans.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
    return {
      plans: rows.map((r) => ({
        plan_no: r.planNo, status: r.status, total_budget: Number(r.totalBudget), predicted_sales: r.predictedSales == null ? null : Number(r.predictedSales),
        allocation: r.allocation, basis: r.basis, note: r.note, requested_by: r.requestedBy, approved_by: r.approvedBy, created_at: r.createdAt, decided_at: r.decidedAt,
      })),
    };
  }

  // APPROVE a staged plan. Maker-checker (MKT-17): the approver must differ from the requester.
  async approveBudgetPlan(user: JwtUser, body: z.infer<typeof ApproveBudgetPlanBody>) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const [plan] = await this.db.select().from(miBudgetPlans)
      .where(and(eq(miBudgetPlans.tenantId, tenantId), eq(miBudgetPlans.planNo, body.plan_no))).limit(1);
    if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: `budget plan ${body.plan_no} not found`, messageTh: `ไม่พบแผนงบ ${body.plan_no}` });
    if (plan.status !== 'Pending') throw new BadRequestException({ code: 'PLAN_NOT_PENDING', message: `plan is ${plan.status}`, messageTh: `แผนนี้สถานะ ${plan.status} แล้ว` });
    await assertMakerChecker(this.db, {
      user, maker: plan.requestedBy ?? '', event: 'marketing.budget_plan.approve', ref: plan.planNo,
      reason: body.self_approval_reason, code: 'SOD_SELF_APPROVAL',
      message: 'Maker-checker: a budget plan must be approved by a different user than the requester',
      messageTh: 'แบ่งแยกหน้าที่: แผนงบต้องอนุมัติโดยผู้ใช้ที่ต่างจากผู้ขอ', httpStatus: 400,
    });
    await this.db.update(miBudgetPlans).set({ status: 'Approved', approvedBy: user.username ?? 'user', decidedAt: new Date() })
      .where(and(eq(miBudgetPlans.tenantId, tenantId), eq(miBudgetPlans.planNo, body.plan_no)));
    return { plan_no: plan.planNo, status: 'Approved', approved_by: user.username ?? 'user' };
  }
}
