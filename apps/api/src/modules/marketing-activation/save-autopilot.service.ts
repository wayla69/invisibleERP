import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, posMembers, miSavePolicies, miSaveRuns, miSaveTargets } from '../../database/schema';
import { assertMakerChecker } from '../../common/control-profile';
import type { JwtUser } from '../../common/decorators';
import { measureLiftDetailed } from '../../common/lift-math';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CrmService } from '../crm/crm.service';
import { computeSavePnl, type SaveCustomer, type SavePolicy } from './save-offer';

// Churn-Save Autopilot (docs/61 Phase 5, control MKT-24) — protect the base + PROVE the saved revenue. The
// save-offer POLICY (churn threshold, min CLV, offer rate, and a hard OFFER CAP) is MAKER-CHECKER approved: a
// Pending policy must be approved by a DIFFERENT user before it is Active. A sweep applies the Active policy
// to at-risk customers, computes a CAPPED win-back offer (the cap is enforced in the pure core), assigns a
// randomised HOLDOUT arm (MKT-19), and records a retention P&L (expected saved revenue vs offer cost). The
// draft is consent-gated + draft-only — nothing auto-sends. Reads customer_profiles + pos_members in
// separate queries (no cross-domain join). A read/orchestration model — no GL posting.

export interface PolicyInput { churn_threshold?: number; min_clv?: number; offer_rate?: number; offer_cap?: number; note?: string }

// Measurement window (days) after a run is staged before its realized P&L may be measured. Clamped 1..90.
const clampWindowDays = (v: unknown): number => Math.min(Math.max(Math.round(Number(v ?? 14) || 14), 1), 90);

@Injectable()
export class SaveAutopilotService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly campaigns: CampaignsService,
    private readonly crm: CrmService,
  ) {}

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }

  // STAGE a save-offer policy (Pending). The hard OFFER CAP must be a positive number — the control.
  async stagePolicy(user: JwtUser, body: PolicyInput): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const cap = Number(body?.offer_cap);
    if (!Number.isFinite(cap) || cap <= 0) throw new BadRequestException({ code: 'INVALID_OFFER_CAP', message: 'offer_cap must be a positive number (the control)', messageTh: 'เพดานข้อเสนอต้องเป็นจำนวนบวก' });
    const churn = clamp01(body?.churn_threshold ?? 0.5);
    const rate = Math.max(0, Number(body?.offer_rate ?? 0.1) || 0);
    const minClv = Math.max(0, Number(body?.min_clv ?? 0) || 0);
    const todayCount = (await this.db.select({ id: miSavePolicies.id }).from(miSavePolicies).where(eq(miSavePolicies.tenantId, tenantId))).length;
    const d = new Date();
    const policyNo = `SAVEPOL-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(todayCount + 1).padStart(3, '0')}`;
    await this.db.insert(miSavePolicies).values({
      tenantId, policyNo, churnThreshold: String(churn), minClv: String(minClv), offerRate: String(rate), offerCap: String(cap),
      status: 'Pending', note: body?.note ?? null, requestedBy: user.username ?? 'user',
    });
    return { policy_no: policyNo, status: 'Pending', churn_threshold: churn, min_clv: minClv, offer_rate: rate, offer_cap: cap };
  }

  // APPROVE a policy — maker-checker (approver ≠ requester). The newly-Active policy supersedes the prior one.
  async approvePolicy(user: JwtUser, body: { policy_no: string; self_approval_reason?: string }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const [pol] = await this.db.select().from(miSavePolicies)
      .where(and(eq(miSavePolicies.tenantId, tenantId), eq(miSavePolicies.policyNo, body.policy_no))).limit(1);
    if (!pol) throw new NotFoundException({ code: 'POLICY_NOT_FOUND', message: `policy ${body.policy_no} not found`, messageTh: `ไม่พบนโยบาย ${body.policy_no}` });
    if (pol.status !== 'Pending') throw new BadRequestException({ code: 'POLICY_NOT_PENDING', message: `policy is ${pol.status}`, messageTh: `นโยบายนี้สถานะ ${pol.status} แล้ว` });
    await assertMakerChecker(this.db, {
      user, maker: pol.requestedBy ?? '', event: 'marketing.save_policy.approve', ref: pol.policyNo,
      reason: body.self_approval_reason, code: 'SOD_SELF_APPROVAL',
      message: 'Maker-checker: a save-offer policy must be approved by a different user than the requester',
      messageTh: 'แบ่งแยกหน้าที่: นโยบายข้อเสนอรักษาลูกค้าต้องอนุมัติโดยผู้ใช้ที่ต่างจากผู้ขอ', httpStatus: 400,
    });
    await this.db.update(miSavePolicies).set({ status: 'Superseded' }).where(and(eq(miSavePolicies.tenantId, tenantId), eq(miSavePolicies.status, 'Active')));
    await this.db.update(miSavePolicies).set({ status: 'Active', approvedBy: user.username ?? 'user', approvedAt: new Date() })
      .where(and(eq(miSavePolicies.tenantId, tenantId), eq(miSavePolicies.id, pol.id)));
    return { policy_no: pol.policyNo, status: 'Active', approved_by: user.username ?? 'user' };
  }

  private async activePolicy(tenantId: number): Promise<{ policyNo: string; policy: SavePolicy }> {
    const [pol] = await this.db.select().from(miSavePolicies)
      .where(and(eq(miSavePolicies.tenantId, tenantId), eq(miSavePolicies.status, 'Active'))).orderBy(desc(miSavePolicies.approvedAt)).limit(1);
    if (!pol) throw new BadRequestException({ code: 'NO_ACTIVE_POLICY', message: 'no Active save-offer policy — stage one and have a different user approve it', messageTh: 'ยังไม่มีนโยบายที่อนุมัติแล้ว' });
    return { policyNo: pol.policyNo, policy: { churn_threshold: Number(pol.churnThreshold), min_clv: Number(pol.minClv), offer_rate: Number(pol.offerRate), offer_cap: Number(pol.offerCap) } };
  }

  private async loadCustomers(tenantId: number, segment?: string): Promise<SaveCustomer[]> {
    const seg = (segment ?? '').trim();
    const profiles = await this.db.select({ memberId: customerProfiles.memberId, clv: customerProfiles.miClv, churn: customerProfiles.miChurnRisk })
      .from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), isNotNull(customerProfiles.memberId), isNotNull(customerProfiles.miChurnRisk), seg ? eq(customerProfiles.miRfmSegment, seg) : isNotNull(customerProfiles.miChurnRisk)));
    const memberIds = profiles.map((p) => Number(p.memberId)).filter((n) => Number.isFinite(n));
    const optIn = new Map<number, boolean>();
    if (memberIds.length) {
      const mems = await this.db.select({ id: posMembers.id, optIn: posMembers.marketingOptIn, active: posMembers.active })
        .from(posMembers).where(and(eq(posMembers.tenantId, tenantId), inArray(posMembers.id, memberIds)));
      for (const m of mems) optIn.set(Number(m.id), m.optIn !== false && m.active !== false);
    }
    return profiles.map((p) => ({ member_id: Number(p.memberId), clv: p.clv == null ? null : Number(p.clv), churn_risk: p.churn == null ? null : Number(p.churn), opt_in: optIn.get(Number(p.memberId)) === true }));
  }

  // ADVISORY preview — the retention P&L for the Active policy, without persisting or contacting.
  async preview(user: JwtUser, opts?: { segment?: string; control_pct?: number }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const { policyNo, policy } = await this.activePolicy(tenantId);
    const customers = await this.loadCustomers(tenantId, opts?.segment);
    const pnl = computeSavePnl(customers, policy, { controlPct: opts?.control_pct });
    return {
      policy_no: policyNo, policy, segment: opts?.segment ?? null, swept: customers.length,
      eligible: pnl.eligible, treatment_count: pnl.treatment_count, control_count: pnl.control_count,
      offer_cost: pnl.offer_cost, expected_saved_revenue: pnl.expected_saved_revenue, net_benefit: pnl.net_benefit, roi: pnl.roi,
      targets: pnl.targets.slice(0, 100),
      note: 'Advisory retention P&L (MKT-24). Every offer is capped by the approved policy. Stage a run to create a consent-gated draft — nothing auto-sends; the control arm is never contacted.',
    };
  }

  // STAGE a run — apply the Active policy, create a consent-gated DRAFT for the treatment arm, record the P&L
  // AND persist the per-member holdout arms (mi_save_targets) so the run's realized P&L is measurable later
  // (the control arm is never contacted and exists nowhere else).
  async stageRun(user: JwtUser, opts?: { segment?: string; control_pct?: number; window_days?: number }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const { policyNo, policy } = await this.activePolicy(tenantId);
    const customers = await this.loadCustomers(tenantId, opts?.segment);
    const pnl = computeSavePnl(customers, policy, { controlPct: opts?.control_pct });
    if (!pnl.treatment_count && !pnl.control_count) throw new BadRequestException({ code: 'NO_AT_RISK_TARGETS', message: 'no at-risk, save-worthy, consented customers to act on', messageTh: 'ไม่มีลูกค้าเสี่ยงที่ควรรักษาและยินยอม' });

    const treatmentIds = pnl.targets.filter((t) => t.arm === 'treatment').map((t) => t.member_id);
    let campaignId: number | null = null;
    if (treatmentIds.length) {
      const camp = await this.campaigns.upsertCampaign(user, {
        name: `SAVE · ${policyNo}${opts?.segment ? ` · ${opts.segment}` : ''}`, channel: 'sms', audience: 'members',
        member_ids: treatmentIds, body: `ข้อเสนอรักษาลูกค้า (แก้ไขก่อนส่ง)`,
      });
      campaignId = camp && typeof camp === 'object' && 'id' in camp ? Number((camp as { id: unknown }).id) : null;
    }

    const todayCount = (await this.db.select({ id: miSaveRuns.id }).from(miSaveRuns).where(eq(miSaveRuns.tenantId, tenantId))).length;
    const d = new Date();
    const runNo = `SAVE-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(todayCount + 1).padStart(3, '0')}`;
    const measureAfter = new Date(d.getTime() + clampWindowDays(opts?.window_days) * 86400_000);
    const [head] = await this.db.insert(miSaveRuns).values({
      tenantId, runNo, policyNo, segment: opts?.segment ?? null, treatmentCount: pnl.treatment_count, controlCount: pnl.control_count,
      offerCost: String(pnl.offer_cost), expectedSavedRevenue: String(pnl.expected_saved_revenue), netBenefit: String(pnl.net_benefit),
      campaignId, requestedBy: user.username ?? 'user', measureAfter,
    }).returning({ id: miSaveRuns.id });
    if (!head) throw new BadRequestException({ code: 'STAGE_FAILED', message: 'could not stage save run', messageTh: 'สร้างรอบรักษาลูกค้าไม่สำเร็จ' });
    const runId = Number(head.id);

    // Persist BOTH arms — the audit evidence of the sweep and the basis for realized measurement.
    const targetRows = pnl.targets.map((t) => ({
      tenantId, runId, memberId: t.member_id, arm: t.arm,
      offer: String(t.offer), expectedSaved: String(t.expected_saved),
    }));
    for (let i = 0; i < targetRows.length; i += 500) await this.db.insert(miSaveTargets).values(targetRows.slice(i, i + 500));

    return { run_no: runNo, policy_no: policyNo, campaign_id: campaignId, treatment_count: pnl.treatment_count, control_count: pnl.control_count, offer_cost: pnl.offer_cost, expected_saved_revenue: pnl.expected_saved_revenue, net_benefit: pnl.net_benefit, roi: pnl.roi, measure_after: measureAfter, note: 'A consent-gated DRAFT was created for the treatment arm — a human edits + sends; the control arm is never contacted, so the save can be measured.' };
  }

  // MEASURE the realized retention P&L once the window has elapsed: per-arm REAL POS revenue in
  // [created_at, now] via the CrmService read API (no cross-domain join), the shared MKT-19 lift math, and
  // realized_net_benefit = incremental (realized saved revenue) − offer_cost. Idempotent-guarded.
  async measureRun(user: JwtUser, body: { run_no: string }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const [run] = await this.db.select().from(miSaveRuns)
      .where(and(eq(miSaveRuns.tenantId, tenantId), eq(miSaveRuns.runNo, body.run_no))).limit(1);
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: `save run ${body.run_no} not found`, messageTh: `ไม่พบรอบ ${body.run_no}` });
    if (run.measuredAt) throw new BadRequestException({ code: 'ALREADY_MEASURED', message: 'save run already measured', messageTh: 'รอบนี้วัดผลแล้ว' });
    const now = new Date();
    if (run.measureAfter && now < new Date(run.measureAfter)) throw new BadRequestException({ code: 'WINDOW_NOT_ELAPSED', message: 'measurement window has not elapsed yet', messageTh: 'ยังไม่ครบช่วงวัดผล' });
    if (Number(run.controlCount) <= 0) throw new BadRequestException({ code: 'NO_CONTROL', message: 'no control arm to measure lift against', messageTh: 'ไม่มีกลุ่มควบคุมให้เทียบ' });

    const armRows = await this.db.select({ memberId: miSaveTargets.memberId, arm: miSaveTargets.arm })
      .from(miSaveTargets).where(and(eq(miSaveTargets.tenantId, tenantId), eq(miSaveTargets.runId, run.id)));
    if (!armRows.length) throw new BadRequestException({ code: 'NO_TARGETS_RECORDED', message: 'this run has no persisted holdout arms (staged before realized measurement existed)', messageTh: 'รอบนี้ไม่มีรายชื่อกลุ่มทดลอง/ควบคุมบันทึกไว้' });
    const treatment = armRows.filter((a) => a.arm === 'treatment').map((a) => Number(a.memberId));
    const control = armRows.filter((a) => a.arm === 'control').map((a) => Number(a.memberId));

    const from = run.createdAt ? new Date(run.createdAt) : now;
    const rev = await this.crm.revenueByMembers(tenantId, [...treatment, ...control], from, now);
    // Per-member detailed lift (docs/62 Phase 3): 95% CI + weak-evidence flag ride along, display-only.
    const lift = measureLiftDetailed(treatment.map((id) => rev.get(id) ?? 0), control.map((id) => rev.get(id) ?? 0));
    const tRev = lift.treatment_per_head * treatment.length;
    const cRev = lift.control_per_head * control.length;
    const realizedNet = lift.incremental_revenue - Number(run.offerCost ?? 0);

    await this.db.update(miSaveRuns).set({
      treatmentRevenue: String(round2(tRev)), controlRevenue: String(round2(cRev)),
      treatmentPerHead: String(round2(lift.treatment_per_head)), controlPerHead: String(round2(lift.control_per_head)),
      realizedLiftPct: lift.lift_pct == null ? null : String(round2(lift.lift_pct)),
      incrementalRevenue: String(round2(lift.incremental_revenue)), realizedNetBenefit: String(round2(realizedNet)),
      liftCiLowPct: lift.lift_ci_low_pct == null ? null : String(round2(lift.lift_ci_low_pct)),
      liftCiHighPct: lift.lift_ci_high_pct == null ? null : String(round2(lift.lift_ci_high_pct)),
      weakEvidence: lift.weak_evidence,
      measuredAt: now, measuredBy: user.username ?? 'user',
    }).where(and(eq(miSaveRuns.tenantId, tenantId), eq(miSaveRuns.id, run.id)));

    return {
      run_no: run.runNo, policy_no: run.policyNo, segment: run.segment, measured: true,
      treatment_count: treatment.length, control_count: control.length,
      treatment_per_head: round2(lift.treatment_per_head), control_per_head: round2(lift.control_per_head),
      realized_lift_pct: lift.lift_pct == null ? null : round2(lift.lift_pct),
      lift_ci_low_pct: lift.lift_ci_low_pct == null ? null : round2(lift.lift_ci_low_pct),
      lift_ci_high_pct: lift.lift_ci_high_pct == null ? null : round2(lift.lift_ci_high_pct),
      weak_evidence: lift.weak_evidence,
      realized_saved_revenue: round2(lift.incremental_revenue),
      offer_cost: run.offerCost == null ? null : Number(run.offerCost),
      realized_net_benefit: round2(realizedNet),
      note: 'Realized retention P&L on real POS revenue (MKT-19 discipline): saved revenue = treatment-vs-control incremental; net = saved − offer cost. Feeds the Segment×Channel ROI ranking (⑤).',
    };
  }

  async listPolicies(user: JwtUser, limit = 20): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const rows = await this.db.select().from(miSavePolicies).where(eq(miSavePolicies.tenantId, tenantId)).orderBy(desc(miSavePolicies.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
    return { policies: rows.map((r) => ({ policy_no: r.policyNo, status: r.status, churn_threshold: Number(r.churnThreshold), min_clv: Number(r.minClv), offer_rate: Number(r.offerRate), offer_cap: Number(r.offerCap), requested_by: r.requestedBy, approved_by: r.approvedBy, created_at: r.createdAt })) };
  }

  async listRuns(user: JwtUser, limit = 20): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const rows = await this.db.select().from(miSaveRuns).where(eq(miSaveRuns.tenantId, tenantId)).orderBy(desc(miSaveRuns.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
    return { runs: rows.map((r) => ({
      run_no: r.runNo, policy_no: r.policyNo, segment: r.segment, treatment_count: r.treatmentCount, control_count: r.controlCount,
      offer_cost: r.offerCost == null ? null : Number(r.offerCost),
      expected_saved_revenue: r.expectedSavedRevenue == null ? null : Number(r.expectedSavedRevenue),
      net_benefit: r.netBenefit == null ? null : Number(r.netBenefit),
      campaign_id: r.campaignId, created_at: r.createdAt,
      measure_after: r.measureAfter, measured_at: r.measuredAt, measured_by: r.measuredBy,
      realized_lift_pct: r.realizedLiftPct == null ? null : Number(r.realizedLiftPct),
      lift_ci_low_pct: r.liftCiLowPct == null ? null : Number(r.liftCiLowPct),
      lift_ci_high_pct: r.liftCiHighPct == null ? null : Number(r.liftCiHighPct),
      weak_evidence: r.weakEvidence ?? null,
      realized_saved_revenue: r.incrementalRevenue == null ? null : Number(r.incrementalRevenue),
      realized_net_benefit: r.realizedNetBenefit == null ? null : Number(r.realizedNetBenefit),
    })) };
  }
}

const clamp01 = (v: unknown): number => Math.max(0, Math.min(1, Number(v) || 0));
const round2 = (v: number): number => Math.round(v * 100) / 100;
