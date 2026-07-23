import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerProfiles, miCampaignExperiments, miJourneys, miSaveRuns } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { MarketingIntelService } from '../marketing-intel/marketing-intel.service';
import { rankSegmentChannel, type SegmentValue, type ChannelRoi } from './segment-channel-scoring';

// Segment × Channel ROI Command (docs/61 Phase 2, control MKT-25) — extends the Budget Optimizer (MKT-17)
// from CHANNEL to SEGMENT × CHANNEL × the money behind it. It COMBINES existing signals through owning-module
// reads (no cross-domain join): the pushed MMM channel ROI (marketing-intel getSummary), per-segment size +
// CLV (a customer_profiles aggregation), and MEASURED Phase-3 lift (mi_campaign_experiments, MKT-19). The
// ranking is the pure, deterministic `segment-channel-scoring.ts` (unit-tested).
//
// ADVISORY + MAKER-CHECKER (MKT-25): the ranking is read-only and NEVER posts spend; turning it into money
// reuses the MKT-17 path exactly — `stage` delegates to MarketingIntelService.stageBudgetPlan (a Pending
// mi_budget_plans row) and approval goes through the existing MKT-17 maker-checker (approver ≠ requester).

@Injectable()
export class SegmentChannelRoiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly mi: MarketingIntelService,
  ) {}

  // Load the three inputs the pure scorer needs, tenant-scoped: segment value, channel ROI, measured lift.
  private async loadInputs(user: JwtUser): Promise<{ segments: SegmentValue[]; channels: ChannelRoi[]; liftBySegment: Map<string, number | null>; basis: string | null }> {
    const tenantId = this.assertTenant(user);

    // Per-segment size + average platform CLV (a single-table aggregation — no join).
    const segRows = await this.db.select({
      segment: customerProfiles.miRfmSegment,
      count: sql<number>`count(*)::int`,
      avgClv: sql<string | null>`avg(${customerProfiles.miClv})`,
    }).from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), sql`${customerProfiles.miRfmSegment} is not null`))
      .groupBy(customerProfiles.miRfmSegment);
    const segments: SegmentValue[] = segRows.map((r) => ({ segment: String(r.segment), count: Number(r.count) || 0, avg_clv: r.avgClv == null ? null : Number(r.avgClv) }));

    // Channel ROI from the latest pushed MMM (the same source the Fact Layer reads).
    const summary: any = await this.mi.getSummary(user);
    const chRaw: any[] = Array.isArray(summary?.mmm?.payload?.channels) ? summary.mmm.payload.channels : [];
    const channels: ChannelRoi[] = chRaw.map((c) => ({ channel: String(c.channel), roi: c.roi == null ? null : Number(c.roi) }));
    const basis = summary?.mmm?.model_run_ref ?? null;

    // Latest MEASURED lift per segment — the real counterfactual wherever ANY holdout was measured:
    // MKT-19 experiments, ② NBA journeys and ④ save runs (migration 0476) all feed the same map; the most
    // recently measured lift per segment wins. This is the "realised lift feeds back into ⑤" loop closer.
    const liftBySegment = new Map<string, number | null>();
    const seenAt = new Map<string, number>();
    const fold = (rows: Array<{ segment: unknown; liftPct: unknown; measuredAt: unknown }>): void => {
      for (const r of rows) {
        if (r.segment == null || r.liftPct == null) continue;
        const seg = String(r.segment);
        const at = r.measuredAt ? new Date(r.measuredAt as string | Date).getTime() : 0;
        if (!seenAt.has(seg) || at >= (seenAt.get(seg) ?? 0)) { seenAt.set(seg, at); liftBySegment.set(seg, Number(r.liftPct)); }
      }
    };
    fold(await this.db.select({ segment: miCampaignExperiments.segment, liftPct: miCampaignExperiments.liftPct, measuredAt: miCampaignExperiments.measuredAt })
      .from(miCampaignExperiments)
      .where(and(eq(miCampaignExperiments.tenantId, tenantId), eq(miCampaignExperiments.status, 'Measured'))));
    fold(await this.db.select({ segment: miJourneys.segment, liftPct: miJourneys.realizedLiftPct, measuredAt: miJourneys.measuredAt })
      .from(miJourneys)
      .where(and(eq(miJourneys.tenantId, tenantId), sql`${miJourneys.measuredAt} is not null`)));
    fold(await this.db.select({ segment: miSaveRuns.segment, liftPct: miSaveRuns.realizedLiftPct, measuredAt: miSaveRuns.measuredAt })
      .from(miSaveRuns)
      .where(and(eq(miSaveRuns.tenantId, tenantId), sql`${miSaveRuns.measuredAt} is not null`)));
    return { segments, channels, liftBySegment, basis };
  }

  // Rank segment × channel cells by incremental ROI × value, and split a budget toward the best channels.
  async rank(user: JwtUser, opts?: { budget?: number; top?: number }): Promise<Record<string, unknown>> {
    const { segments, channels, liftBySegment, basis } = await this.loadInputs(user);
    const budget = Math.max(0, Number(opts?.budget ?? 0) || 0);
    const plan = rankSegmentChannel(segments, channels, liftBySegment, budget, { top: opts?.top ?? 50 });
    return {
      budget,
      basis,
      has_mmm: channels.length > 0,
      segment_count: segments.length,
      cells: plan.cells,
      channel_allocation: plan.channel_allocation,
      recommendation_basis: plan.basis, // 'measured+mmm' | 'mmm' | 'none'
      note: 'Advisory ranking only (MKT-25). To commit budget, stage a plan — it requires maker-checker approval (MKT-17), never posts spend directly.',
    };
  }

  // STAGE the recommended split as a maker-checker budget plan — reuses the MKT-17 path VERBATIM (a Pending
  // mi_budget_plans row; approval via the existing POST /api/marketing-intel/budget-plan/approve). No new
  // spend path, no new SoD code — the segment×channel ranking simply FEEDS the proven channel-plan control.
  async stage(user: JwtUser, body: { total_budget: number; top?: number; note?: string }): Promise<Record<string, unknown>> {
    const budget = Number(body?.total_budget);
    if (!Number.isFinite(budget) || budget <= 0) throw new BadRequestException({ code: 'INVALID_BUDGET', message: 'total_budget must be a positive number', messageTh: 'งบต้องเป็นจำนวนบวก' });
    const { segments, channels, liftBySegment } = await this.loadInputs(user);
    const plan = rankSegmentChannel(segments, channels, liftBySegment, budget, { top: body?.top ?? 50 });
    const topCell = plan.cells[0];
    const note = body?.note ?? (topCell ? `Segment×Channel ROI: top cell ${topCell.segment} × ${topCell.channel} (${plan.basis})` : `Segment×Channel ROI (${plan.basis})`);
    // Delegate to MKT-17 staging (validates MMM data, computes predicted sales off the curves, enforces the
    // maker-checker on approve). Its zod body accepts { total_budget, allocation, note }.
    const staged: Record<string, unknown> = await this.mi.stageBudgetPlan(user, { total_budget: budget, allocation: plan.channel_allocation, note });
    return { ...staged, channel_allocation: plan.channel_allocation, recommendation_basis: plan.basis, top_cell: topCell ?? null };
  }

  private assertTenant(user: JwtUser): number {
    if (user.tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    return user.tenantId;
  }
}
