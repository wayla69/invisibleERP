import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { miCampaignExperiments, miExperimentArms, customerProfiles, posMembers } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { measureLift } from '../../common/lift-math';
import { CrmService } from '../crm/crm.service';
import { CampaignsService } from '../campaigns/campaigns.service';

// Closed-loop Measurement (docs/60 Phase 3, control MKT-19). Activating a pushed mi_segment splits its
// eligible members ONCE into a treatment arm (contacted) and a randomised holdout CONTROL arm (never
// contacted), fixed at send time. After a window the lift = treatment-per-head − control-per-head on real
// POS revenue (read through CrmService.revenueByMembers — NO cross-domain join) proves the campaign caused
// incremental sales. Holdout integrity: arms are immutable (unique index), the outcome read is tenant-scoped
// and read-only, and the control arm is structurally excluded from the treatment-only ('members') campaign.

export const StartExperimentBody = z.object({
  segment: z.string().min(1).max(80),
  control_pct: z.number().min(0).max(0.9).optional(),
  window_days: z.number().int().min(0).max(365).optional(),
  activate: z.boolean().optional(),           // also create the treatment-only campaign now
  channel: z.enum(['sms', 'email', 'line']).optional(),
  body: z.string().min(1).max(1000).optional(),
});
export const MeasureExperimentBody = z.object({ experiment_no: z.string().min(1).max(60) });

// Deterministic, stable holdout assignment: a member is in CONTROL iff a fixed hash of its id falls under
// the control fraction. Same inputs → same split (never re-randomised); stored in mi_experiment_arms.
function inControl(memberId: number, controlPct: number): boolean {
  return ((Math.imul(memberId >>> 0, 2654435761) >>> 0) % 10000) < Math.round(controlPct * 10000);
}

@Injectable()
export class MiExperimentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly crm: CrmService,
    private readonly campaigns: CampaignsService,
  ) {}

  // START an experiment for a pushed segment: fix the treatment/control arms and (optionally) send the
  // treatment-only campaign. The control members are recorded but never contacted.
  async startExperiment(user: JwtUser, body: z.infer<typeof StartExperimentBody>) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const segment = body.segment.trim();
    const controlPct = body.control_pct ?? 0.2;
    const windowDays = body.window_days ?? 14;

    const profs = await this.db.select({ memberId: customerProfiles.memberId }).from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.miRfmSegment, segment)));
    const memberIds = profs.map((p) => Number(p.memberId)).filter((x) => Number.isFinite(x));
    if (!memberIds.length) throw new BadRequestException({ code: 'EMPTY_SEGMENT', message: `no members in segment "${segment}" — push RFM first`, messageTh: 'ไม่มีสมาชิกในกลุ่มนี้ (ยังไม่ push RFM)' });

    const control = memberIds.filter((id) => inControl(id, controlPct));
    const controlSet = new Set(control);
    const treatment = memberIds.filter((id) => !controlSet.has(id));
    if (!treatment.length) throw new BadRequestException({ code: 'EMPTY_TREATMENT', message: 'the holdout fraction left no treatment members — lower control_pct', messageTh: 'สัดส่วนกลุ่มควบคุมมากเกินไป จนไม่มีกลุ่มทดลอง' });

    const todayCount = (await this.db.select({ id: miCampaignExperiments.id }).from(miCampaignExperiments).where(eq(miCampaignExperiments.tenantId, tenantId))).length;
    const d = new Date();
    const experimentNo = `MIX-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(todayCount + 1).padStart(3, '0')}`;
    const measureAfter = new Date(d.getTime() + windowDays * 86400_000);

    let campaignId: number | null = null;
    if (body.activate) {
      const camp = await this.campaigns.upsertCampaign(user, {
        name: `MIX · ${segment}`,
        channel: body.channel ?? 'sms',
        audience: 'members',
        member_ids: treatment,
        body: body.body ?? `ข้อความถึงกลุ่ม ${segment} (แก้ไขก่อนส่ง)`,
      });
      campaignId = camp?.id ?? null;
    }

    const [exp] = await this.db.insert(miCampaignExperiments).values({
      tenantId, experimentNo, segment, campaignId,
      controlPct: String(controlPct), windowDays,
      treatmentCount: treatment.length, controlCount: control.length,
      status: 'Running', measureAfter, createdBy: user.username ?? 'user',
    }).returning({ id: miCampaignExperiments.id });
    if (!exp) throw new BadRequestException({ code: 'EXPERIMENT_CREATE_FAILED', message: 'could not create experiment', messageTh: 'สร้างการทดลองไม่สำเร็จ' });
    const experimentId = exp.id;

    const arms = [
      ...treatment.map((memberId) => ({ tenantId, experimentId, memberId, arm: 'treatment' })),
      ...control.map((memberId) => ({ tenantId, experimentId, memberId, arm: 'control' })),
    ];
    // Insert arms in bounded chunks (a segment can be large).
    for (let i = 0; i < arms.length; i += 500) await this.db.insert(miExperimentArms).values(arms.slice(i, i + 500));

    return { experiment_no: experimentNo, segment, treatment_count: treatment.length, control_count: control.length, control_pct: controlPct, window_days: windowDays, measure_after: measureAfter, campaign_id: campaignId, status: 'Running' };
  }

  async listExperiments(user: JwtUser, limit = 20) {
    const tenantId = user.tenantId;
    if (tenantId == null) return { experiments: [] };
    const rows = await this.db.select().from(miCampaignExperiments)
      .where(eq(miCampaignExperiments.tenantId, tenantId)).orderBy(desc(miCampaignExperiments.startedAt)).limit(Math.min(Math.max(limit, 1), 100));
    return { experiments: rows.map((r) => this.shape(r)) };
  }

  // MEASURE lift once the window has elapsed: per-arm revenue in [started_at, now] via the CrmService read
  // API (no cross-domain join), then treatment-per-head vs control-per-head. Idempotent-guarded (a Measured
  // experiment is not re-measured).
  async measureExperiment(user: JwtUser, body: z.infer<typeof MeasureExperimentBody>) {
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'no tenant', messageTh: 'ไม่มีผู้เช่า' });
    const [exp] = await this.db.select().from(miCampaignExperiments)
      .where(and(eq(miCampaignExperiments.tenantId, tenantId), eq(miCampaignExperiments.experimentNo, body.experiment_no))).limit(1);
    if (!exp) throw new NotFoundException({ code: 'EXPERIMENT_NOT_FOUND', message: `experiment ${body.experiment_no} not found`, messageTh: `ไม่พบการทดลอง ${body.experiment_no}` });
    if (exp.status === 'Measured') throw new BadRequestException({ code: 'ALREADY_MEASURED', message: 'experiment already measured', messageTh: 'การทดลองนี้วัดผลแล้ว' });
    const now = new Date();
    if (exp.measureAfter && now < new Date(exp.measureAfter)) throw new BadRequestException({ code: 'WINDOW_NOT_ELAPSED', message: 'measurement window has not elapsed yet', messageTh: 'ยังไม่ครบช่วงวัดผล' });
    if (Number(exp.controlCount) <= 0) throw new BadRequestException({ code: 'NO_CONTROL', message: 'no control arm to measure lift against', messageTh: 'ไม่มีกลุ่มควบคุมให้เทียบ' });

    const armRows = await this.db.select({ memberId: miExperimentArms.memberId, arm: miExperimentArms.arm })
      .from(miExperimentArms).where(and(eq(miExperimentArms.tenantId, tenantId), eq(miExperimentArms.experimentId, exp.id)));
    const treatment = armRows.filter((a) => a.arm === 'treatment').map((a) => Number(a.memberId));
    const control = armRows.filter((a) => a.arm === 'control').map((a) => Number(a.memberId));

    const from = exp.startedAt ? new Date(exp.startedAt) : new Date(now.getTime() - Number(exp.windowDays) * 86400_000);
    const rev = await this.crm.revenueByMembers(tenantId, [...treatment, ...control], from, now);
    const sum = (ids: number[]) => ids.reduce((s, id) => s + (rev.get(id) ?? 0), 0);
    const tRev = sum(treatment), cRev = sum(control);
    // Shared MKT-19 lift math (common/lift-math.ts) — also used by the journey/save-run measurements.
    const lift = measureLift({ treatmentRevenue: tRev, treatmentN: treatment.length, controlRevenue: cRev, controlN: control.length });
    const tPerHead = lift.treatment_per_head;
    const cPerHead = lift.control_per_head;
    const incremental = lift.incremental_revenue;
    const liftPct = lift.lift_pct;

    await this.db.update(miCampaignExperiments).set({
      status: 'Measured',
      treatmentRevenue: String(tRev), controlRevenue: String(cRev),
      treatmentPerHead: String(round2(tPerHead)), controlPerHead: String(round2(cPerHead)),
      incrementalRevenue: String(round2(incremental)), liftPct: liftPct == null ? null : String(round2(liftPct)),
      measuredAt: now, measuredBy: user.username ?? 'user',
    }).where(and(eq(miCampaignExperiments.tenantId, tenantId), eq(miCampaignExperiments.id, exp.id)));

    return {
      experiment_no: exp.experimentNo, segment: exp.segment, status: 'Measured',
      treatment_count: treatment.length, control_count: control.length,
      treatment_per_head: round2(tPerHead), control_per_head: round2(cPerHead),
      incremental_revenue: round2(incremental), lift_pct: liftPct == null ? null : round2(liftPct),
    };
  }

  // Measured outcomes for the platform pull-back (feeds the next MMM fit's realised-lift regressor).
  async outcomes(user: JwtUser, limit = 100) {
    const tenantId = user.tenantId;
    if (tenantId == null) return { outcomes: [] };
    const rows = await this.db.select().from(miCampaignExperiments)
      .where(and(eq(miCampaignExperiments.tenantId, tenantId), eq(miCampaignExperiments.status, 'Measured')))
      .orderBy(desc(miCampaignExperiments.measuredAt)).limit(Math.min(Math.max(limit, 1), 500));
    return {
      outcomes: rows.map((r) => ({
        experiment_no: r.experimentNo, segment: r.segment,
        incremental_revenue: r.incrementalRevenue == null ? null : Number(r.incrementalRevenue),
        lift_pct: r.liftPct == null ? null : Number(r.liftPct),
        treatment_count: Number(r.treatmentCount), control_count: Number(r.controlCount),
        window_days: Number(r.windowDays), measured_at: r.measuredAt,
      })),
    };
  }

  private shape(r: typeof miCampaignExperiments.$inferSelect) {
    return {
      experiment_no: r.experimentNo, segment: r.segment, status: r.status,
      control_pct: r.controlPct == null ? null : Number(r.controlPct), window_days: Number(r.windowDays),
      treatment_count: Number(r.treatmentCount), control_count: Number(r.controlCount),
      started_at: r.startedAt, measure_after: r.measureAfter, campaign_id: r.campaignId,
      treatment_per_head: r.treatmentPerHead == null ? null : Number(r.treatmentPerHead),
      control_per_head: r.controlPerHead == null ? null : Number(r.controlPerHead),
      incremental_revenue: r.incrementalRevenue == null ? null : Number(r.incrementalRevenue),
      lift_pct: r.liftPct == null ? null : Number(r.liftPct),
      measured_at: r.measuredAt, measured_by: r.measuredBy, created_by: r.createdBy,
    };
  }
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
