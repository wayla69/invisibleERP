import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miAnalyticsSnapshots, miGovernanceSettings, miBudgetPlans, miCampaignExperiments } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { BiLiveService } from '../bi/bi-live.service';

// Model Governance (docs/60 Phase 4, control MKT-20). Because the pushed analytics now DRIVE spend and
// customer contact, this puts ITGC-grade governance around them:
//   · maker-checker — a pushed run must be APPROVED by a second person (≠ the pusher) before activate /
//     budget-plan can consume it (opt-in per tenant via mi_governance_settings.require_approval);
//   · model cards — each run carries {model_version, training_window, features, metrics} surfaced in-ERP;
//   · drift/quality — a new run's R² is compared to the prior approved run; a material drop is flagged
//     (into the GOV-01 center + the SSE attention bus) and BLOCKS consumption until approved-with-reason;
//   · audit trail — recommendation (run) → action (budget plan / campaign) → outcome (Phase-3 lift), linked.
// Back-compat: default status 'Approved' + governance OFF ⇒ existing tenants unchanged.

export const GovernanceSettingsBody = z.object({
  require_approval: z.boolean().optional(),
  drift_r2_drop: z.number().min(0).max(1).optional(),
});
export const ApproveRunBody = z.object({ id: z.number().int().positive(), reason: z.string().max(500).optional() });

const DEFAULT_DRIFT_DROP = 0.15;

@Injectable()
export class MiGovernanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly live?: BiLiveService,
  ) {}

  // ── settings ─────────────────────────────────────────────────────────────────────────────────────
  async isGoverned(tenantId: number | null): Promise<{ require: boolean; driftDrop: number }> {
    if (tenantId == null) return { require: false, driftDrop: DEFAULT_DRIFT_DROP };
    const [s] = await this.db.select().from(miGovernanceSettings).where(eq(miGovernanceSettings.tenantId, tenantId)).limit(1);
    return { require: !!s?.requireApproval, driftDrop: s?.driftR2Drop == null ? DEFAULT_DRIFT_DROP : Number(s.driftR2Drop) };
  }

  // True ⇒ consumers (loadCurves / activateSegment) must use only Approved runs.
  async approvedOnly(tenantId: number | null): Promise<boolean> {
    return (await this.isGoverned(tenantId)).require;
  }

  async getSettings(user: JwtUser) {
    const g = await this.isGoverned(user.tenantId ?? null);
    return { require_approval: g.require, drift_r2_drop: g.driftDrop };
  }

  async updateSettings(user: JwtUser, body: z.infer<typeof GovernanceSettingsBody>) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const [existing] = await this.db.select({ id: miGovernanceSettings.id }).from(miGovernanceSettings).where(eq(miGovernanceSettings.tenantId, tenantId)).limit(1);
    const patch: Record<string, unknown> = { updatedBy: user.username ?? 'user', updatedAt: new Date() };
    if (body.require_approval != null) patch.requireApproval = body.require_approval;
    if (body.drift_r2_drop != null) patch.driftR2Drop = String(body.drift_r2_drop);
    if (existing) await this.db.update(miGovernanceSettings).set(patch).where(eq(miGovernanceSettings.tenantId, tenantId));
    else await this.db.insert(miGovernanceSettings).values({ tenantId, requireApproval: body.require_approval ?? false, driftR2Drop: String(body.drift_r2_drop ?? DEFAULT_DRIFT_DROP), updatedBy: user.username ?? 'user' });
    return this.getSettings(user);
  }

  // ── push evaluation (called from MarketingIntelService.pushSnapshots) ───────────────────────────────
  // Decide a snapshot's initial status + compute its quality/drift vs the prior APPROVED run of the same
  // kind. Governed ⇒ 'Pending'; a material R² drop (mmm) flags drift + blocks consumption until approved.
  async evaluatePush(tenantId: number, kind: string, payload: any): Promise<{ status: string; quality: Record<string, unknown> }> {
    const { require, driftDrop } = await this.isGoverned(tenantId);
    const quality: Record<string, unknown> = {};
    if (kind === 'mmm') {
      const r2 = num(payload?.r2);
      quality.r2 = r2;
      const [prev] = await this.db.select({ payload: miAnalyticsSnapshots.payload }).from(miAnalyticsSnapshots)
        .where(and(eq(miAnalyticsSnapshots.kind, 'mmm'), eq(miAnalyticsSnapshots.status, 'Approved')))
        .orderBy(desc(miAnalyticsSnapshots.pushedAt)).limit(1);
      if (prev) {
        const prevR2 = num((prev.payload as { r2?: unknown } | null)?.r2);
        quality.prev_r2 = prevR2;
        const drop = prevR2 - r2;
        quality.r2_drop = round4(drop);
        quality.drift = drop > driftDrop;
      }
    }
    const blocked = quality.drift === true;
    quality.blocked = blocked;
    const status = require ? 'Pending' : 'Approved';
    if (blocked && this.live) this.live.publish({ type: 'mi.model_drift', tenant_id: tenantId, kind, r2_drop: quality.r2_drop });
    return { status, quality };
  }

  // ── runs / approval ────────────────────────────────────────────────────────────────────────────────
  async listRuns(user: JwtUser, limit = 30) {
    const tenantId = user.tenantId;
    if (tenantId == null) return { runs: [] };
    const rows = await this.db.select().from(miAnalyticsSnapshots)
      .where(eq(miAnalyticsSnapshots.tenantId, tenantId)).orderBy(desc(miAnalyticsSnapshots.pushedAt)).limit(Math.min(Math.max(limit, 1), 100));
    return {
      runs: rows.map((r) => ({
        id: r.id, kind: r.kind, status: r.status, model_run_ref: r.modelRunRef,
        model_card: r.modelCard ?? null, quality: r.quality ?? null,
        pushed_by: r.pushedBy, pushed_at: r.pushedAt, approved_by: r.approvedBy, approved_at: r.approvedAt,
      })),
    };
  }

  // Maker-checker (MKT-20): the approver must differ from the pusher; a drift-BLOCKED run needs a reason.
  async approveRun(user: JwtUser, body: z.infer<typeof ApproveRunBody>) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const [run] = await this.db.select().from(miAnalyticsSnapshots)
      .where(and(eq(miAnalyticsSnapshots.tenantId, tenantId), eq(miAnalyticsSnapshots.id, body.id))).limit(1);
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: `analytics run ${body.id} not found`, messageTh: `ไม่พบผลวิเคราะห์ ${body.id}` });
    if (run.status === 'Approved') throw new BadRequestException({ code: 'ALREADY_APPROVED', message: 'run already approved', messageTh: 'อนุมัติแล้ว' });
    if ((run.quality as { blocked?: boolean } | null)?.blocked === true && !body.reason) {
      throw new BadRequestException({ code: 'DRIFT_REASON_REQUIRED', message: 'this run drifted materially — an approval reason is required', messageTh: 'ผลวิเคราะห์เปลี่ยนแปลงมาก ต้องระบุเหตุผลในการอนุมัติ' });
    }
    await assertMakerChecker(this.db, {
      user, maker: run.pushedBy ?? '', event: 'marketing.analytics_run.approve', ref: String(run.id),
      reason: body.reason, code: 'SOD_SELF_APPROVAL',
      message: 'Maker-checker: an analytics run must be approved by a different user than the one that pushed it',
      messageTh: 'แบ่งแยกหน้าที่: ผลวิเคราะห์ต้องอนุมัติโดยผู้ใช้ที่ต่างจากผู้ push', httpStatus: 400,
    });
    await this.db.update(miAnalyticsSnapshots).set({ status: 'Approved', approvedBy: user.username ?? 'user', approvedAt: new Date() })
      .where(and(eq(miAnalyticsSnapshots.tenantId, tenantId), eq(miAnalyticsSnapshots.id, body.id)));
    return { id: run.id, kind: run.kind, status: 'Approved', approved_by: user.username ?? 'user' };
  }

  // ── end-to-end audit trail: recommendation (run) → action (budget plan) → outcome (experiment lift) ──
  async auditTrail(user: JwtUser) {
    const tenantId = user.tenantId;
    if (tenantId == null) return { runs: [], plans: [], experiments: [] };
    const runs = await this.db.select({ id: miAnalyticsSnapshots.id, kind: miAnalyticsSnapshots.kind, status: miAnalyticsSnapshots.status, modelRunRef: miAnalyticsSnapshots.modelRunRef, pushedBy: miAnalyticsSnapshots.pushedBy, approvedBy: miAnalyticsSnapshots.approvedBy, pushedAt: miAnalyticsSnapshots.pushedAt })
      .from(miAnalyticsSnapshots).where(eq(miAnalyticsSnapshots.tenantId, tenantId)).orderBy(desc(miAnalyticsSnapshots.pushedAt)).limit(30);
    const plans = await this.db.select({ planNo: miBudgetPlans.planNo, status: miBudgetPlans.status, basis: miBudgetPlans.basis, requestedBy: miBudgetPlans.requestedBy, approvedBy: miBudgetPlans.approvedBy, createdAt: miBudgetPlans.createdAt })
      .from(miBudgetPlans).where(eq(miBudgetPlans.tenantId, tenantId)).orderBy(desc(miBudgetPlans.createdAt)).limit(30);
    const experiments = await this.db.select({ experimentNo: miCampaignExperiments.experimentNo, segment: miCampaignExperiments.segment, status: miCampaignExperiments.status, liftPct: miCampaignExperiments.liftPct, incrementalRevenue: miCampaignExperiments.incrementalRevenue, measuredAt: miCampaignExperiments.measuredAt })
      .from(miCampaignExperiments).where(eq(miCampaignExperiments.tenantId, tenantId)).orderBy(desc(miCampaignExperiments.startedAt)).limit(30);
    return {
      runs: runs.map((r) => ({ id: r.id, kind: r.kind, status: r.status, model_run_ref: r.modelRunRef, pushed_by: r.pushedBy, approved_by: r.approvedBy, pushed_at: r.pushedAt })),
      plans: plans.map((p) => ({ plan_no: p.planNo, status: p.status, basis: p.basis, requested_by: p.requestedBy, approved_by: p.approvedBy, created_at: p.createdAt })),
      experiments: experiments.map((e) => ({ experiment_no: e.experimentNo, segment: e.segment, status: e.status, lift_pct: e.liftPct == null ? null : Number(e.liftPct), incremental_revenue: e.incrementalRevenue == null ? null : Number(e.incrementalRevenue), measured_at: e.measuredAt })),
    };
  }
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
