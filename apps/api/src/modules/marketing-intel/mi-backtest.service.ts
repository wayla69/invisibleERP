import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miBudgetPlans } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { MmmModelService } from '../mmm/mmm-model.service';
import { MarketingIntelService } from './marketing-intel.service';
import { computePlanBacktest, type PlanBacktest } from './plan-backtest';

// Plan-vs-actual budget reconciliation (docs/62 Phase 2, NEW detective control MKT-26). An APPROVED
// mi_budget_plans allocation is reconciled against the ACTUAL per-channel marketing spend — the latest
// MMM model run's recorded spend (`mmm_channel_results`, via the owning MmmModelService read) when a run
// exists, else the platform-pushed MMM snapshot's channel spend (the same store getSummary reads). The
// variance table + adherence% + flags come from the pure `plan-backtest.ts` core; predicted sales are
// compared against the MMM run's attributed revenue when available. Read-only and fail-honest: a plan
// that is not Approved cannot be "reconciled" (PLAN_NOT_APPROVED), and no actuals at all → NO_ACTUALS —
// a backtest never invents a baseline.

@Injectable()
export class MiBacktestService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly mmm: MmmModelService,
    private readonly mi: MarketingIntelService,
  ) {}

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }

  // Actual spend per channel: MMM run first (the recorded actuals), pushed snapshot second.
  private async loadActuals(user: JwtUser): Promise<{ basis: 'mmm_run' | 'pushed' | 'none'; ref: string | null; byChannel: Record<string, { spend: number; roi: number | null }>; attributedTotal: number | null }> {
    const latest: any = await this.mmm.latestSummary(user);
    if (latest?.has_run && Array.isArray(latest.results) && latest.results.length) {
      const byChannel: Record<string, { spend: number; roi: number | null }> = {};
      let attributed = 0;
      for (const r of latest.results) {
        byChannel[String(r.channel)] = { spend: Number(r.spend) || 0, roi: r.roi == null ? null : Number(r.roi) };
        attributed += Number(r.attributed_revenue) || 0;
      }
      return { basis: 'mmm_run', ref: latest.run_no ?? null, byChannel, attributedTotal: attributed };
    }
    const summary: any = await this.mi.getSummary(user);
    const chans: any[] = Array.isArray(summary?.mmm?.payload?.channels) ? summary.mmm.payload.channels : [];
    if (chans.length) {
      const byChannel: Record<string, { spend: number; roi: number | null }> = {};
      for (const c of chans) byChannel[String(c.channel)] = { spend: Number(c.spend) || 0, roi: c.roi == null ? null : Number(c.roi) };
      return { basis: 'pushed', ref: summary?.mmm?.model_run_ref ?? null, byChannel, attributedTotal: null };
    }
    return { basis: 'none', ref: null, byChannel: {}, attributedTotal: null };
  }

  // MKT-26 — backtest ONE approved plan.
  async backtestPlan(user: JwtUser, planNo: string, opts?: { flag_pct?: number }): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const [plan] = await this.db.select().from(miBudgetPlans)
      .where(and(eq(miBudgetPlans.tenantId, tenantId), eq(miBudgetPlans.planNo, planNo))).limit(1);
    if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: `plan ${planNo} not found`, messageTh: `ไม่พบแผน ${planNo}` });
    if (plan.status !== 'Approved') throw new BadRequestException({ code: 'PLAN_NOT_APPROVED', message: `plan is ${plan.status} — only an approved plan is reconciled`, messageTh: `แผนนี้สถานะ ${plan.status} — ตรวจสอบได้เฉพาะแผนที่อนุมัติแล้ว` });

    const actuals = await this.loadActuals(user);
    if (actuals.basis === 'none') throw new BadRequestException({ code: 'NO_ACTUALS', message: 'no actual spend source (no MMM run and no pushed MMM snapshot) — nothing to reconcile against', messageTh: 'ยังไม่มีข้อมูลการใช้จ่ายจริง (ไม่มีผลรัน MMM) — ยังตรวจสอบไม่ได้' });

    const backtest: PlanBacktest = computePlanBacktest(
      (plan.allocation ?? {}) as Record<string, unknown>,
      actuals.byChannel,
      { flagPct: opts?.flag_pct },
    );
    const predicted = plan.predictedSales == null ? null : Number(plan.predictedSales);
    return {
      plan_no: plan.planNo,
      status: plan.status,
      approved_by: plan.approvedBy,
      decided_at: plan.decidedAt,
      actuals_basis: actuals.basis,      // 'mmm_run' | 'pushed'
      actuals_ref: actuals.ref,
      ...backtest,
      predicted_sales: predicted,
      attributed_revenue: actuals.attributedTotal, // MMM-run attributed revenue total (null on 'pushed')
      note: 'Plan-vs-actual reconciliation (MKT-26, detective). Variances are findings for review — nothing here moves money; re-allocation stays the maker-checker plan flow.',
    };
  }

  // The schedulable sweep (report type mkt_plan_backtest): reconcile every Approved plan; list the flagged.
  async backtestAllApproved(user: JwtUser): Promise<Record<string, unknown>> {
    const tenantId = this.assertTenant(user);
    const plans = await this.db.select().from(miBudgetPlans)
      .where(and(eq(miBudgetPlans.tenantId, tenantId), eq(miBudgetPlans.status, 'Approved')));
    const results: Array<Record<string, unknown>> = [];
    let skipped = 0;
    for (const p of plans) {
      try {
        results.push(await this.backtestPlan(user, p.planNo));
      } catch {
        skipped += 1; // NO_ACTUALS etc. — the sweep reports coverage honestly, never throws per-plan
      }
    }
    const flagged = results.filter((r) => Number(r.flagged_count) > 0);
    return { plans: results.length, skipped, flagged: flagged.length, flagged_plans: flagged.map((r) => r.plan_no), results };
  }
}
