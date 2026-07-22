import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Sse } from '@nestjs/common';
import { map, filter, type Observable } from 'rxjs';
import { z } from 'zod';
import { CurrentUser, Permissions, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { ScmPlanningService } from './scm-planning.service';
import { ScmSpikeService } from './scm-spike.service';
import { ScmLiveService } from './scm-live.service';
import { HierDeclareBody, type HierAxis, type HierDeclareDto } from './scm-hierarchy.service';

// docs/54 — the supply-chain planning API.
// Route prefix is `api/scm-planning` because `api/planning` already belongs to the EPM budget module.
// Class-level gate is the PLANNER duty; the approve route additionally demands the CHECKER duty
// (`scm_approve`), which no coarse permission implies — that split plus the in-service
// assertMakerChecker identity test is control SCM-01 (SoD rule R24).

const SettingsBody = z.object({
  horizon_days: z.number().int().min(1).max(56).optional(),
  service_level: z.number().min(0.5).max(0.9999).optional(),
  sample_paths: z.number().int().min(10).max(100).optional(),
  lookback_days: z.number().int().min(28).max(1095).optional(),
  closed_weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  closures: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    branch_id: z.number().int().positive().nullable().optional(),
    reason: z.string().optional(),
  })).optional(),
  dine_in_branch_id: z.number().int().positive().nullable().optional(),
  spike_ewma_alpha: z.number().min(0.01).max(0.9).optional(),
  spike_z_threshold: z.number().min(1).max(10).optional(),
  spike_cusum_k: z.number().min(0).max(5).optional(),
  spike_cusum_h: z.number().min(1).max(20).optional(),
  spike_min_qty: z.number().min(0).optional(),
  spike_cooldown_hours: z.number().int().min(1).max(720).optional(),
  auto_replan: z.boolean().optional(),
  engine_enabled: z.boolean().optional(),
});

const PolicyBody = z.object({
  item_id: z.string().min(1),
  branch_id: z.number().int().positive().nullable().optional(),
  service_level: z.number().min(0.5).max(0.9999).nullable().optional(),
  min_order_qty: z.number().min(0).nullable().optional(),
  order_multiple: z.number().min(0).nullable().optional(),
  max_stock_qty: z.number().min(0).nullable().optional(),
  lead_time_days: z.number().min(0).max(365).nullable().optional(),
  shelf_life_days: z.number().int().min(1).max(3650).nullable().optional(),
  waste_cost_per_unit: z.number().min(0).nullable().optional(),
  stockout_cost_per_unit: z.number().min(0).nullable().optional(),
  planning_enabled: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

const ShelfLifeBody = z.object({
  item_id: z.string().min(1),
  days: z.number().int().min(1).max(3650),
});

const RunBody = z.object({
  branch_ids: z.array(z.number().int().positive()).max(50).optional(),
  item_ids: z.array(z.string().min(1)).max(500).optional(),
});

const LineBody = z.object({ final_qty: z.number().min(0) });
const RejectBody = z.object({ reason: z.string().min(1).max(500) });

// Bounded so a what-if stays synchronous — it must never become a second planning run.
const ScenarioBody = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  item_ids: z.array(z.string().min(1)).min(1).max(25),
  horizon_days: z.number().int().min(1).max(28).optional(),
  demand_multiplier: z.number().min(0.1).max(5).optional(),
  service_level: z.number().min(0.5).max(0.9999).optional(),
});

@Controller('api/scm-planning')
@Permissions('scm_plan', 'exec')
export class ScmPlanningController {
  constructor(
    private readonly svc: ScmPlanningService,
    private readonly spikes: ScmSpikeService,
    private readonly live: ScmLiveService,
  ) {}

  // ── settings & policies ──
  @Get('settings')
  getSettings(@CurrentUser() u: JwtUser) { return this.svc.getSettings(u); }

  @Put('settings')
  putSettings(@Body(new ZodValidationPipe(SettingsBody)) b: z.infer<typeof SettingsBody>, @CurrentUser() u: JwtUser) {
    return this.svc.upsertSettings(b, u);
  }

  @Get('policies')
  listPolicies(
    @Query('branch_id') branchId: string | undefined,
    @Query('item_id') itemId: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.listPolicies(u, {
      branch_id: branchId ? Number(branchId) : undefined,
      item_id: itemId || undefined,
    });
  }

  @Post('policies')
  upsertPolicy(@Body(new ZodValidationPipe(PolicyBody)) b: z.infer<typeof PolicyBody>, @CurrentUser() u: JwtUser) {
    return this.svc.upsertPolicy(b, u);
  }

  @Delete('policies/:id')
  deletePolicy(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.deletePolicy(id, u);
  }

  @Get('items/shelf-life-suggestions')
  shelfLifeSuggestions(@CurrentUser() u: JwtUser) { return this.svc.suggestShelfLife(u); }

  @Post('items/shelf-life')
  applyShelfLife(@Body(new ZodValidationPipe(ShelfLifeBody)) b: z.infer<typeof ShelfLifeBody>, @CurrentUser() u: JwtUser) {
    return this.svc.applyShelfLife(b, u);
  }

  // ── forecast hierarchy (docs/58 Track C · C1) ──
  @Get('hierarchy')
  listHierarchy(@Query('axis') axis: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listHierarchy(u, axis === 'branch' || axis === 'item' ? axis : undefined);
  }

  // The assembled forest: a tenant's declared structure, else synthesized from branches/categories.
  @Get('hierarchy/forest')
  hierarchyForest(@Query('axis') axis: string | undefined, @CurrentUser() u: JwtUser) {
    const a: HierAxis = axis === 'item' ? 'item' : 'branch';
    return this.svc.hierarchyForest(u, a);
  }

  @Put('hierarchy')
  declareHierarchy(@Body(new ZodValidationPipe(HierDeclareBody)) b: HierDeclareDto, @CurrentUser() u: JwtUser) {
    return this.svc.declareHierarchy(b, u);
  }

  @Delete('hierarchy/:id')
  deleteHierarchyNode(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.deleteHierarchyNode(id, u);
  }

  // ── runs ──
  @Post('run')
  run(@Body(new ZodValidationPipe(RunBody)) b: z.infer<typeof RunBody>, @CurrentUser() u: JwtUser) {
    return this.svc.executePlanRun(u.tenantId ?? null, 'manual', {
      actor: u.username, branchIds: b.branch_ids, itemIds: b.item_ids,
    });
  }

  @Get('runs')
  listRuns(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listRuns(u, limit ? Number(limit) : undefined);
  }

  @Get('runs/:id')
  getRun(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.getRun(id, u); }

  @Get('runs/:id/forecasts')
  runForecasts(
    @Param('id', ParseIntPipe) id: number,
    @Query('branch_id') branchId: string | undefined,
    @Query('item_id') itemId: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.runForecasts(id, u, {
      branch_id: branchId ? Number(branchId) : undefined,
      item_id: itemId || undefined,
    });
  }

  // ── plans ──
  @Get('plans')
  listPlans(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.listPlans(u, { status: status || undefined, limit: limit ? Number(limit) : undefined });
  }

  @Get('plans/:id')
  getPlan(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.getPlan(id, u); }

  @Put('plans/:id/lines/:lineId')
  updateLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body(new ZodValidationPipe(LineBody)) b: z.infer<typeof LineBody>,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.updatePlanLine(id, lineId, b, u);
  }

  @Post('plans/:id/submit')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.submitPlan(id, u); }

  // SCM-01 — the CHECKER duty. `scm_approve` is a sub-permission, so no coarse module key grants it;
  // the service additionally asserts approver ≠ maker (403 SOD_SELF_APPROVAL).
  @Post('plans/:id/approve') @Permissions('scm_approve', 'exec')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(SelfApprovalBody)) b: SelfApprovalDto,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.approvePlan(id, b, u);
  }

  @Post('plans/:id/reject') @Permissions('scm_approve', 'exec')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.rejectPlan(id, b, u);
  }

  @Post('plans/:id/convert-to-pr')
  convert(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.convertPlanToPr(id, u);
  }

  // ── scenario & spikes ──
  @Post('scenario')
  scenario(@Body(new ZodValidationPipe(ScenarioBody)) b: z.infer<typeof ScenarioBody>, @CurrentUser() u: JwtUser) {
    return this.svc.scenario(b, u);
  }

  @Get('spikes')
  listSpikes(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.listSpikes(u, { status: status || undefined, limit: limit ? Number(limit) : undefined });
  }

  @Post('spikes/scan')
  scan(@CurrentUser() u: JwtUser) { return this.spikes.scanForUser(u); }

  @Post('spikes/:id/dismiss')
  dismiss(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.dismissSpike(id, u);
  }

  // ── realtime ──
  @Get('events/recent')
  recent(@CurrentUser() u: JwtUser) {
    return { events: this.live.recent(u.tenantId ?? null) };
  }

  // Re-filter per subscriber: a god/HQ session (tenantId null) sees everything, a tenant session
  // only its own events — a null-tenant event must never fan out to every tenant (security L-7).
  @Sse('events/stream')
  stream(@CurrentUser() u: JwtUser): Observable<{ data: unknown }> {
    return this.live.stream().pipe(
      filter((e) => u.tenantId == null || e.tenant_id === u.tenantId),
      map((data) => ({ data })),
    );
  }
}
