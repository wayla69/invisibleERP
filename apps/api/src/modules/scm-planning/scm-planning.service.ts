import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  items, scmDemandForecasts, scmItemPolicies, scmOrderPlanLines, scmOrderPlans, scmPlanRuns,
  scmSpikeEvents,
} from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { DemandForecastService } from '../demand-ml/demand-forecast.service';
import { ProcurementService } from '../procurement/procurement.service';
import { ScmEngineClientService } from './scm-engine-client.service';
import { ScmExtractService } from './scm-extract.service';
import { ScmHierarchyService, type HierAxis, type HierDeclareDto } from './scm-hierarchy.service';
import { ScmElasticityService } from './scm-elasticity.service';
import { ScmLiveService, type ScmLiveEvent } from './scm-live.service';
import { ScmFallbackPlanner } from './scm-planner';
import { ScmRunService } from './scm-run.service';
import { PLAN_STATUS, SYSTEM_ACTOR, type ExtractedTenantData, type PlanRunResult } from './scm-planning.types';

// docs/54 — the SCM planning facade: settings/policies, the maker-checker plan lifecycle that ends
// in a procurement PR, and read surfaces. Thin by design — extraction, the engine client, the
// planner and RUN EXECUTION live in sub-services built positionally in the ctor body.

@Injectable()
export class ScmPlanningService {
  private readonly log = new Logger(ScmPlanningService.name);
  readonly extract: ScmExtractService;
  readonly hierarchy: ScmHierarchyService;
  readonly elasticity: ScmElasticityService;
  private readonly fallback: ScmFallbackPlanner;
  private readonly runner: ScmRunService;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly engine: ScmEngineClientService,
    private readonly demandMl: DemandForecastService,
    private readonly procurement: ProcurementService,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly live: ScmLiveService,
  ) {
    this.extract = new ScmExtractService(db);
    this.hierarchy = new ScmHierarchyService(db);
    this.elasticity = new ScmElasticityService(db);
    this.fallback = new ScmFallbackPlanner(demandMl);
    this.runner = new ScmRunService(
      db, this.extract, engine, this.fallback, docNo, statusLog,
      (tenantId, type, extra) => this.emit(tenantId, type, extra),
      this.elasticity,
    );
  }

  // ── planning run (delegated to ScmRunService) ───────────────────────────────

  executePlanRun(
    tenantId: number | null,
    scope: 'nightly' | 'manual' | 'replan',
    opts: { actor: string; branchIds?: (number | null)[]; itemIds?: string[]; triggerRef?: string } = { actor: SYSTEM_ACTOR },
  ): Promise<PlanRunResult> {
    return this.runner.executePlanRun(tenantId, scope, opts);
  }

  pruneOldRuns(tenantId: number | null, retentionDays: number) {
    return this.runner.pruneOldRuns(tenantId, retentionDays);
  }

  // ── settings & policies ─────────────────────────────────────────────────────

  getSettings(user: JwtUser) {
    return this.extract.settings(user.tenantId ?? null);
  }

  upsertSettings(dto: Record<string, unknown>, user: JwtUser) {
    return this.extract.upsertSettings(dto, user);
  }

  async listPolicies(user: JwtUser, q: { branch_id?: number; item_id?: string } = {}) {
    const rows = await this.db.select().from(scmItemPolicies).where(and(
      user.tenantId != null ? eq(scmItemPolicies.tenantId, user.tenantId) : sql`true`,
      q.branch_id != null ? eq(scmItemPolicies.branchId, q.branch_id) : sql`true`,
      q.item_id ? eq(scmItemPolicies.itemId, q.item_id) : sql`true`,
    )).orderBy(scmItemPolicies.itemId);
    return { policies: rows };
  }

  async upsertPolicy(dto: Record<string, unknown>, user: JwtUser) {
    const itemId = String(dto.item_id ?? '').trim();
    if (!itemId) {
      throw new BadRequestException({
        code: 'ITEM_REQUIRED', message: 'item_id is required', messageTh: 'ต้องระบุรหัสสินค้า',
      });
    }
    const branchId = dto.branch_id == null ? null : Number(dto.branch_id);
    const vals = {
      serviceLevel: dto.service_level == null ? null : String(dto.service_level),
      minOrderQty: dto.min_order_qty == null ? null : String(dto.min_order_qty),
      orderMultiple: dto.order_multiple == null ? null : String(dto.order_multiple),
      maxStockQty: dto.max_stock_qty == null ? null : String(dto.max_stock_qty),
      leadTimeDays: dto.lead_time_days == null ? null : String(dto.lead_time_days),
      shelfLifeDays: dto.shelf_life_days == null ? null : Number(dto.shelf_life_days),
      wasteCostPerUnit: dto.waste_cost_per_unit == null ? null : String(dto.waste_cost_per_unit),
      stockoutCostPerUnit: dto.stockout_cost_per_unit == null ? null : String(dto.stockout_cost_per_unit),
      planningEnabled: dto.planning_enabled === undefined ? true : !!dto.planning_enabled,
      notes: (dto.notes as string) ?? null,
      updatedBy: user.username,
      updatedAt: new Date(),
    };
    const [existing] = await this.db.select().from(scmItemPolicies).where(and(
      user.tenantId != null ? eq(scmItemPolicies.tenantId, user.tenantId) : sql`true`,
      eq(scmItemPolicies.itemId, itemId),
      branchId == null ? sql`${scmItemPolicies.branchId} is null` : eq(scmItemPolicies.branchId, branchId),
    )).limit(1);
    if (existing) await this.db.update(scmItemPolicies).set(vals).where(eq(scmItemPolicies.id, existing.id));
    else await this.db.insert(scmItemPolicies).values({ tenantId: user.tenantId ?? null, branchId, itemId, ...vals });
    return { ok: true, item_id: itemId, branch_id: branchId };
  }

  async deletePolicy(id: number, user: JwtUser) {
    await this.db.delete(scmItemPolicies).where(and(
      eq(scmItemPolicies.id, id),
      user.tenantId != null ? eq(scmItemPolicies.tenantId, user.tenantId) : sql`true`,
    ));
    return { ok: true };
  }

  // ── forecast hierarchy (docs/58 Track C · C1) — declared aggregation structures + the assembler ──

  async listHierarchy(user: JwtUser, axis?: HierAxis) {
    return { nodes: await this.hierarchy.list(user.tenantId ?? null, axis) };
  }

  /** The assembled forest (declared, else synthesized from branches / item_categories). */
  hierarchyForest(user: JwtUser, axis: HierAxis) {
    return this.hierarchy.forest(user.tenantId ?? null, axis);
  }

  declareHierarchy(dto: HierDeclareDto, user: JwtUser) {
    return this.hierarchy.declare(user.tenantId ?? null, dto, user.username)
      .then((nodes) => ({ ok: true, axis: dto.axis, nodes }));
  }

  deleteHierarchyNode(id: number, user: JwtUser) {
    return this.hierarchy.remove(user.tenantId ?? null, id);
  }

  // docs/56 A2 — the persisted own-price elasticities a reviewer/planner can inspect (read-only;
  // estimated server-side by the engine, upserted on each run).
  async listElasticity(user: JwtUser) {
    return { items: await this.elasticity.list(user.tenantId ?? null) };
  }

  suggestShelfLife(user: JwtUser) {
    return this.extract.suggestShelfLife(user.tenantId ?? null).then((rows) => ({ suggestions: rows }));
  }

  async applyShelfLife(dto: { item_id: string; days: number }, user: JwtUser) {
    const days = Number(dto.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new BadRequestException({
        code: 'BAD_SHELF_LIFE', message: 'days must be an integer between 1 and 3650',
        messageTh: 'อายุการเก็บต้องเป็นจำนวนเต็ม 1–3650 วัน',
      });
    }
    // `items` is the SHARED master — this is a global write, gated on scm_plan and audited.
    await this.db.update(items).set({ shelfLifeDays: days }).where(eq(items.itemId, dto.item_id));
    this.log.log(`shelf_life set item=${dto.item_id} days=${days} by=${user.username}`);
    return { ok: true, item_id: dto.item_id, shelf_life_days: days };
  }

  // ── runs & plans (reads) ────────────────────────────────────────────────────

  async listRuns(user: JwtUser, limit = 30) {
    const rows = await this.db.select().from(scmPlanRuns).where(
      user.tenantId != null ? eq(scmPlanRuns.tenantId, user.tenantId) : sql`true`,
    ).orderBy(desc(scmPlanRuns.id)).limit(Math.min(limit, 200));
    return { runs: rows };
  }

  async getRun(id: number, user: JwtUser) {
    const [run] = await this.db.select().from(scmPlanRuns).where(and(
      eq(scmPlanRuns.id, id),
      user.tenantId != null ? eq(scmPlanRuns.tenantId, user.tenantId) : sql`true`,
    )).limit(1);
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Planning run not found', messageTh: 'ไม่พบรอบการวางแผน' });
    return run;
  }

  async runForecasts(id: number, user: JwtUser, q: { branch_id?: number; item_id?: string } = {}) {
    await this.getRun(id, user); // tenant check
    const rows = await this.db.select().from(scmDemandForecasts).where(and(
      eq(scmDemandForecasts.runId, id),
      user.tenantId != null ? eq(scmDemandForecasts.tenantId, user.tenantId) : sql`true`,
      q.branch_id != null ? eq(scmDemandForecasts.branchId, q.branch_id) : sql`true`,
      q.item_id ? eq(scmDemandForecasts.itemId, q.item_id) : sql`true`,
    )).limit(500);
    return { forecasts: rows };
  }

  async listPlans(user: JwtUser, q: { status?: string; limit?: number } = {}) {
    const rows = await this.db.select().from(scmOrderPlans).where(and(
      user.tenantId != null ? eq(scmOrderPlans.tenantId, user.tenantId) : sql`true`,
      q.status ? eq(scmOrderPlans.status, q.status) : sql`true`,
    )).orderBy(desc(scmOrderPlans.id)).limit(Math.min(q.limit ?? 50, 200));
    return { plans: rows };
  }

  async getPlan(id: number, user: JwtUser) {
    const [plan] = await this.db.select().from(scmOrderPlans).where(and(
      eq(scmOrderPlans.id, id),
      user.tenantId != null ? eq(scmOrderPlans.tenantId, user.tenantId) : sql`true`,
    )).limit(1);
    if (!plan) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND', message: 'Order plan not found', messageTh: 'ไม่พบแผนสั่งซื้อ',
      });
    }
    const lines = await this.db.select().from(scmOrderPlanLines)
      .where(eq(scmOrderPlanLines.planId, id)).orderBy(scmOrderPlanLines.itemId);
    return { plan, lines };
  }

  // ── plan lifecycle (maker-checker) ──────────────────────────────────────────

  async updatePlanLine(planId: number, lineId: number, dto: { final_qty: number }, user: JwtUser) {
    const { plan } = await this.getPlan(planId, user);
    if (plan.status !== PLAN_STATUS.draft && plan.status !== PLAN_STATUS.rejected) {
      throw new ConflictException({
        code: 'PLAN_NOT_DRAFT', message: `Only a Draft plan can be edited (status: ${plan.status})`,
        messageTh: 'แก้ไขได้เฉพาะแผนสถานะ Draft เท่านั้น',
      });
    }
    const qty = Number(dto.final_qty);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new BadRequestException({
        code: 'BAD_QTY', message: 'final_qty must be zero or positive', messageTh: 'จำนวนต้องไม่ติดลบ',
      });
    }
    await this.db.update(scmOrderPlanLines).set({ finalQty: String(qty) })
      .where(and(eq(scmOrderPlanLines.id, lineId), eq(scmOrderPlanLines.planId, planId)));
    await this.recalcPlanTotal(planId);
    // A rejected plan re-opens for editing so the planner can act on the reviewer's feedback.
    if (plan.status === PLAN_STATUS.rejected) {
      await this.db.update(scmOrderPlans).set({ status: PLAN_STATUS.draft, rejectReason: null })
        .where(eq(scmOrderPlans.id, planId));
    }
    return { ok: true };
  }

  private async recalcPlanTotal(planId: number) {
    const lines = await this.db.select({ finalQty: scmOrderPlanLines.finalQty, unitCost: scmOrderPlanLines.unitCostEst })
      .from(scmOrderPlanLines).where(eq(scmOrderPlanLines.planId, planId));
    const total = lines.reduce((a, l) => a + n(l.finalQty) * n(l.unitCost), 0);
    await this.db.update(scmOrderPlans).set({ estTotalCost: String(Math.round(total * 100) / 100) })
      .where(eq(scmOrderPlans.id, planId));
  }

  async submitPlan(id: number, user: JwtUser) {
    const { plan, lines } = await this.getPlan(id, user);
    if (plan.status !== PLAN_STATUS.draft && plan.status !== PLAN_STATUS.rejected) {
      throw new ConflictException({
        code: 'PLAN_NOT_DRAFT', message: `Only a Draft plan can be submitted (status: ${plan.status})`,
        messageTh: 'ส่งอนุมัติได้เฉพาะแผนสถานะ Draft เท่านั้น',
      });
    }
    if (!lines.some((l) => n(l.finalQty) > 0)) {
      throw new BadRequestException({
        code: 'PLAN_EMPTY', message: 'A plan with no positive quantities cannot be submitted',
        messageTh: 'ไม่สามารถส่งอนุมัติแผนที่ไม่มีรายการสั่งซื้อ',
      });
    }
    await this.db.update(scmOrderPlans).set({
      status: PLAN_STATUS.pending, submittedBy: user.username, submittedAt: new Date(),
    }).where(eq(scmOrderPlans.id, id));
    await this.statusLog.log('SCMP', plan.planNo, plan.status, PLAN_STATUS.pending, user.username);
    this.emit(user.tenantId ?? null, 'scm_plan_submitted', { plan_id: id, plan_no: plan.planNo });
    return { ok: true, plan_no: plan.planNo, status: PLAN_STATUS.pending };
  }

  /**
   * SCM-01. The approver must hold `scm_approve` (route-gated) AND differ from the maker.
   *
   * The maker is the SUBMITTER, not created_by: nightly plans are created by the scheduler, so
   * binding to created_by would let a submitter approve their own submission. Do not simplify.
   */
  async approvePlan(id: number, dto: { self_approval_reason?: string }, user: JwtUser) {
    const { plan } = await this.getPlan(id, user);
    if (plan.status !== PLAN_STATUS.pending) {
      throw new ConflictException({
        code: 'PLAN_NOT_PENDING', message: `Only a plan awaiting approval can be approved (status: ${plan.status})`,
        messageTh: 'อนุมัติได้เฉพาะแผนที่รออนุมัติเท่านั้น',
      });
    }
    await assertMakerChecker(this.db, {
      user,
      maker: plan.submittedBy ?? plan.createdBy,
      event: 'scm.plan.approve',
      ref: plan.planNo,
      amount: plan.estTotalCost,
      reason: dto.self_approval_reason,
    });
    await this.db.update(scmOrderPlans).set({
      status: PLAN_STATUS.approved, approvedBy: user.username, approvedAt: new Date(),
    }).where(eq(scmOrderPlans.id, id));
    await this.statusLog.log('SCMP', plan.planNo, plan.status, PLAN_STATUS.approved, user.username);
    this.emit(user.tenantId ?? null, 'scm_plan_approved', { plan_id: id, plan_no: plan.planNo });
    return { ok: true, plan_no: plan.planNo, status: PLAN_STATUS.approved };
  }

  async rejectPlan(id: number, dto: { reason: string }, user: JwtUser) {
    const { plan } = await this.getPlan(id, user);
    if (plan.status !== PLAN_STATUS.pending) {
      throw new ConflictException({
        code: 'PLAN_NOT_PENDING', message: `Only a plan awaiting approval can be rejected (status: ${plan.status})`,
        messageTh: 'ปฏิเสธได้เฉพาะแผนที่รออนุมัติเท่านั้น',
      });
    }
    const reason = (dto.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED', message: 'A rejection reason is required', messageTh: 'ต้องระบุเหตุผลที่ปฏิเสธ',
      });
    }
    await this.db.update(scmOrderPlans).set({ status: PLAN_STATUS.rejected, rejectReason: reason })
      .where(eq(scmOrderPlans.id, id));
    await this.statusLog.log('SCMP', plan.planNo, plan.status, PLAN_STATUS.rejected, user.username, reason);
    return { ok: true, plan_no: plan.planNo, status: PLAN_STATUS.rejected };
  }

  /**
   * Hand off to procurement through its public API (never a direct PO/PR insert) — the same
   * loose-coupling seam MRP's planToPr and WMS's autoPr use. Idempotent: a second call returns
   * the PR the first one created.
   */
  async convertPlanToPr(id: number, user: JwtUser) {
    const { plan, lines } = await this.getPlan(id, user);
    if (plan.prNo) return { ok: true, plan_no: plan.planNo, pr_no: plan.prNo, idempotent: true };
    if (plan.status !== PLAN_STATUS.approved) {
      throw new ConflictException({
        code: 'PLAN_NOT_APPROVED', message: `Only an approved plan can be converted (status: ${plan.status})`,
        messageTh: 'แปลงเป็นใบขอซื้อได้เฉพาะแผนที่อนุมัติแล้ว',
      });
    }
    const wanted = lines.filter((l) => n(l.finalQty) > 0);
    if (!wanted.length) {
      throw new BadRequestException({
        code: 'PLAN_EMPTY', message: 'No positive quantities to convert', messageTh: 'ไม่มีรายการที่จะแปลงเป็นใบขอซื้อ',
      });
    }
    const params = await this.extract.itemParams(
      user.tenantId ?? null, wanted.map((l) => l.itemId),
      await this.extract.settings(user.tenantId ?? null), plan.branchId,
    );
    const today = ymd();
    const pr = await this.procurement.createPr({
      remarks: `SCM plan ${plan.planNo}`,
      items: wanted.map((l) => ({
        item_id: l.itemId,
        item_description: l.itemDescription ?? undefined,
        request_qty: n(l.finalQty),
        uom: l.uom ?? undefined,
        required_date: addDaysYmd(today, Math.ceil(params.get(l.itemId)?.leadTimeMean ?? 3)),
        reason: 'SCM-PLAN',
      })),
    }, user);

    await this.db.update(scmOrderPlans).set({
      status: PLAN_STATUS.converted, prNo: pr.pr_no, convertedAt: new Date(),
    }).where(eq(scmOrderPlans.id, id));
    await this.statusLog.log('SCMP', plan.planNo, plan.status, PLAN_STATUS.converted, user.username, pr.pr_no);
    this.emit(user.tenantId ?? null, 'scm_plan_converted', { plan_id: id, plan_no: plan.planNo, pr_no: pr.pr_no });
    return { ok: true, plan_no: plan.planNo, pr_no: pr.pr_no, lines: wanted.length };
  }

  // ── spikes ──────────────────────────────────────────────────────────────────

  async listSpikes(user: JwtUser, q: { status?: string; limit?: number } = {}) {
    const rows = await this.db.select().from(scmSpikeEvents).where(and(
      user.tenantId != null ? eq(scmSpikeEvents.tenantId, user.tenantId) : sql`true`,
      q.status ? eq(scmSpikeEvents.status, q.status) : sql`true`,
    )).orderBy(desc(scmSpikeEvents.id)).limit(Math.min(q.limit ?? 50, 200));
    return { spikes: rows };
  }

  async dismissSpike(id: number, user: JwtUser) {
    await this.db.update(scmSpikeEvents).set({ status: 'Dismissed' }).where(and(
      eq(scmSpikeEvents.id, id),
      user.tenantId != null ? eq(scmSpikeEvents.tenantId, user.tenantId) : sql`true`,
    ));
    return { ok: true };
  }

  // ── scenario (synchronous what-if; persists nothing) ────────────────────────

  async scenario(
    dto: {
      branch_id?: number | null; item_ids: string[]; horizon_days?: number;
      demand_multiplier?: number; price_multiplier?: number; service_level?: number;
    },
    user: JwtUser,
  ) {
    const tenantId = user.tenantId ?? null;
    const branchId = dto.branch_id ?? null;
    const data = await this.extract.extractAll(tenantId, { branchIds: [branchId], itemIds: dto.item_ids });
    const horizon = Math.min(Math.max(1, dto.horizon_days ?? data.settings.horizon_days), 28);
    const multiplier = Math.min(Math.max(dto.demand_multiplier ?? 1, 0.1), 5);
    // docs/56 A2 — an optional price what-if applies the persisted own-price elasticity per menu item:
    // demand × (price_multiplier)^ε. With no ε on file the response is 1 (unchanged) — the honest
    // default. Advisory only: scenario persists nothing and never becomes an order.
    const priceMultiplier = dto.price_multiplier != null ? Math.min(Math.max(dto.price_multiplier, 0.1), 5) : 1;
    const elasticities = priceMultiplier !== 1 ? await this.elasticity.list(tenantId) : [];
    const epsFor = (itemId: string): number | null => {
      const forItem = elasticities.filter((e) => e.itemId === itemId);
      if (!forItem.length) return null;
      if (branchId != null) {
        const exact = forItem.find((e) => e.branchId === branchId);
        if (exact) return exact.elasticity;
      }
      return forItem.find((e) => e.branchId == null)?.elasticity ?? forItem[0]!.elasticity;
    };
    const priceAttribution: { item_id: string; elasticity: number | null; demand_response: number }[] = [];

    const scenarioData: ExtractedTenantData = {
      ...data,
      settings: {
        ...data.settings,
        horizon_days: horizon,
        service_level: dto.service_level ?? data.settings.service_level,
      },
      series: data.series.map((s) => {
        const eps = priceMultiplier !== 1 ? epsFor(s.itemId) : null;
        const priceResp = this.elasticity.demandResponse(eps, priceMultiplier);
        if (priceMultiplier !== 1) priceAttribution.push({ item_id: s.itemId, elasticity: eps, demand_response: Number(priceResp.toFixed(4)) });
        return { ...s, values: s.values.map((v) => v * multiplier * priceResp) };
      }),
    };
    // A what-if must be fast and side-effect free, so it always uses the in-process planner.
    const res = await this.fallback.plan(tenantId, scenarioData, [branchId]);
    const draft = res.drafts[0];
    return {
      branch_id: branchId,
      horizon_days: horizon,
      demand_multiplier: multiplier,
      price_multiplier: priceMultiplier,
      price_attribution: priceAttribution,
      service_level: scenarioData.settings.service_level,
      method: res.method,
      lines: (draft?.lines ?? []).map((l) => ({
        item_id: l.itemId, qty: l.qty, unit_cost: l.unitCost,
        est_cost: Math.round(l.qty * l.unitCost * 100) / 100,
        on_hand: l.onHand, in_transit: l.inTransit, coverage_days: l.coverageDays,
        detail: l.detail,
      })),
      est_total_cost: Math.round((draft?.lines ?? []).reduce((a, l) => a + l.qty * l.unitCost, 0) * 100) / 100,
    };
  }

  // ── misc ────────────────────────────────────────────────────────────────────

  /** Best-effort realtime notification; the UI also polls, so a dropped event self-heals. */
  private emit(tenantId: number | null, type: ScmLiveEvent['type'], extra: Record<string, unknown>) {
    try {
      this.live.publish({ type, tenant_id: tenantId, ...extra });
    } catch {
      /* the bus is optional — never fail a planning action because a listener is down */
    }
  }
}
