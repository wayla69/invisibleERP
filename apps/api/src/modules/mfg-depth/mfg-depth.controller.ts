import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RoutingService, type CreateRoutingDto } from './routing.service';
import { ShopFloorService, type ReportOpDto } from './shopfloor.service';
import { QualityService, type InspectDto } from './quality.service';
import { NcrService, type RaiseNcrDto, type DispositionDto, type DefectCodeDto } from './ncr.service';
import { MrpService, type MrpRunDto, type MrpCapacityDto } from './mrp.service';
import { ApsService, type WorkCenterDto, type ScheduleDto } from './aps.service';

const PERMS = ['bom_master', 'warehouse', 'exec'] as const;

const OpSchema = z.object({ op_no: z.number(), work_center: z.string().optional(), description: z.string().optional(), setup_min: z.number().optional(), run_min_per_unit: z.number().optional(), labor_rate: z.number().optional() });
const RoutingBody = z.object({ routing_code: z.string().min(1), product_item_id: z.string().optional(), name: z.string().optional(), operations: z.array(OpSchema).optional() });
const ReportBody = z.object({ completed_qty: z.number().optional(), scrap_qty: z.number().optional() });
const InspectBody = z.object({
  ref_type: z.enum(['WO', 'GR']), ref_doc: z.string().optional(), item_id: z.string().optional(), item_description: z.string().optional(),
  qty_inspected: z.number().nonnegative(), qty_passed: z.number().nonnegative(), qty_failed: z.number().nonnegative().optional(),
  disposition: z.enum(['Accept', 'Rework', 'Quarantine', 'Scrap']).optional(), unit_cost: z.number().nonnegative().optional(), notes: z.string().optional(),
});
const MrpBody = z.object({ demand: z.array(z.object({ item_id: z.string(), qty: z.number(), need_by: z.string().optional() })), lead_time_days: z.number().optional(), lot_sizing: z.boolean().optional() });
const CapacityBody = z.object({ demand: z.array(z.object({ item_id: z.string(), qty: z.number(), need_by: z.string().optional() })), lead_time_days: z.number().optional(), work_centers: z.array(z.object({ code: z.string(), available_minutes: z.number() })).optional() });

// ── Routings ──
@Controller('api/routings')
@Permissions(...PERMS)
@RequiresSuite('manufacturing')
export class RoutingController {
  constructor(private readonly svc: RoutingService) {}
  @Post() create(@Body(new ZodValidationPipe(RoutingBody)) b: CreateRoutingDto, @CurrentUser() u: JwtUser) { return this.svc.createRouting(b, u); }
  @Get() list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }
  @Get(':code') get(@Param('code') code: string) { return this.svc.get(code); }
}

// ── Shop-floor (operations on a work order) ──
@Controller('api/manufacturing')
@Permissions(...PERMS)
@RequiresSuite('manufacturing')
export class ShopFloorController {
  constructor(private readonly svc: ShopFloorService) {}
  @Post('work-orders/:woNo/routing/:routingCode') generate(@Param('woNo') woNo: string, @Param('routingCode') rc: string, @CurrentUser() u: JwtUser) { return this.svc.generate(woNo, rc, u); }
  @Get('work-orders/:woNo/operations') list(@Param('woNo') woNo: string) { return this.svc.listOps(woNo); }
  @Post('work-orders/:woNo/operations/:opNo/report') report(@Param('woNo') woNo: string, @Param('opNo') opNo: string, @Body(new ZodValidationPipe(ReportBody)) b: ReportOpDto, @CurrentUser() u: JwtUser) { return this.svc.report(woNo, Number(opNo), b, u); }
}

// ── Quality ──
@Controller('api/quality')
@Permissions(...PERMS)
@RequiresSuite('manufacturing')
export class QualityController {
  constructor(private readonly svc: QualityService) {}
  @Post('inspect') inspect(@Body(new ZodValidationPipe(InspectBody)) b: InspectDto, @CurrentUser() u: JwtUser) { return this.svc.inspect(b, u); }
  @Get() list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }
}

// ── Quality — Non-Conformance (NCR) register with maker-checker disposition (QMS-1, QC-01) ──
// Reads/raise gate the `quality` duty (or exec); a financial disposition (scrap/use_as_is/return, which may
// post a GL write-off) is applied ONLY by a DIFFERENT `quality_approve`/exec user (SOD_SELF_APPROVAL, QC-01).
const DISPOSITION = z.enum(['scrap', 'use_as_is', 'return', 'rework']);
const RaiseNcrBody = z.object({
  source: z.enum(['incoming', 'in_process', 'customer', 'supplier']).optional(),
  ref_type: z.string().optional(), ref_doc: z.string().optional(),
  item_id: z.string().optional(), item_description: z.string().optional(),
  defect_code: z.string().optional(), severity: z.enum(['minor', 'major', 'critical']).optional(),
  qty: z.number().nonnegative().optional(), unit_cost: z.number().nonnegative().optional(),
  description: z.string().optional(), proposed_disposition: DISPOSITION.optional(),
});
const PromoteBody = z.object({
  defect_code: z.string().optional(), severity: z.enum(['minor', 'major', 'critical']).optional(),
  qty: z.number().nonnegative().optional(), unit_cost: z.number().nonnegative().optional(),
  description: z.string().optional(), proposed_disposition: DISPOSITION.optional(),
});
const DispositionBody = z.object({ disposition: z.enum(['scrap', 'use_as_is', 'return']).optional(), notes: z.string().optional() });
const RejectBody = z.object({ notes: z.string().optional() });
const DefectCodeBody = z.object({ code: z.string().min(1), name: z.string().optional(), category: z.string().optional(), active: z.boolean().optional() });

@Controller('api/quality')
@RequiresSuite('manufacturing')
export class NcrController {
  constructor(private readonly svc: NcrService) {}

  // Defect-code lookup
  @Get('defect-codes') @Permissions('quality', 'exec') listDefectCodes(@CurrentUser() u: JwtUser) { return this.svc.listDefectCodes(u); }
  @Post('defect-codes') @Permissions('quality') createDefectCode(@Body(new ZodValidationPipe(DefectCodeBody)) b: DefectCodeDto, @CurrentUser() u: JwtUser) { return this.svc.createDefectCode(b, u); }

  // NCR register
  @Get('ncr') @Permissions('quality', 'exec') list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list(u, status); }
  @Get('ncr/:id') @Permissions('quality', 'exec') get(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.get(id, u); }
  @Post('ncr') @Permissions('quality') raise(@Body(new ZodValidationPipe(RaiseNcrBody)) b: RaiseNcrDto, @CurrentUser() u: JwtUser) { return this.svc.raiseNcr(b, u); }

  // Promote a failed quality_inspection into an NCR
  @Post('inspections/:id/promote') @Permissions('quality') promote(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(PromoteBody)) b: RaiseNcrDto, @CurrentUser() u: JwtUser) { return this.svc.promoteInspection(id, b, u); }

  // Disposition maker-checker (QC-01): approver ≠ raiser
  @Post('ncr/:id/disposition') @Permissions('quality_approve', 'exec') @HttpCode(200)
  disposition(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(DispositionBody)) b: DispositionDto, @CurrentUser() u: JwtUser) { return this.svc.disposition(id, b, u); }
  @Post('ncr/:id/reject') @Permissions('quality_approve', 'exec') @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RejectBody)) b: DispositionDto, @CurrentUser() u: JwtUser) { return this.svc.reject(id, b, u); }
  @Post('ncr/:id/close') @Permissions('quality_approve', 'exec') @HttpCode(200)
  close(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) { return this.svc.close(id, u); }
}

// ── MRP ──
@Controller('api/mrp')
@Permissions('warehouse', 'planner', 'exec')
@RequiresSuite('manufacturing')
export class MrpController {
  constructor(private readonly svc: MrpService) {}
  @Post('run') run(@Body(new ZodValidationPipe(MrpBody)) b: MrpRunDto, @CurrentUser() u: JwtUser) { return this.svc.run(b, u); }
  // Multi-level MRP → consolidated PR for the planned Buy (needs procurement to raise the PR).
  @Post('plan-to-pr') @Permissions('procurement', 'planner') planToPr(@Body(new ZodValidationPipe(MrpBody)) b: MrpRunDto, @CurrentUser() u: JwtUser) { return this.svc.planToPr(b, u); }
  // Rough-cut capacity: load each work centre from routings vs available minutes.
  @Post('capacity') capacity(@Body(new ZodValidationPipe(CapacityBody)) b: MrpCapacityDto, @CurrentUser() u: JwtUser) { return this.svc.capacity(b, u); }
}

// ── APS — work-centre master + finite-capacity scheduling (docs/22 Phase A) ──
const WorkCenterBody = z.object({ code: z.string().min(1), name: z.string().optional(), minutes_per_day: z.number().positive().optional(), active: z.boolean().optional() });
const ScheduleBody = z.object({
  work_orders: z.array(z.object({ wo_no: z.string().min(1), due_by: z.string().optional() })).optional(),
  horizon_start: z.string().optional(),
  minutes_per_day: z.number().positive().optional(),
});

@Controller('api/work-centers')
@Permissions('bom_master', 'warehouse', 'planner', 'exec')
@RequiresSuite('manufacturing')
export class WorkCenterController {
  constructor(private readonly svc: ApsService) {}
  @Post() upsert(@Body(new ZodValidationPipe(WorkCenterBody)) b: WorkCenterDto, @CurrentUser() u: JwtUser) { return this.svc.upsertWorkCenter(b, u); }
  @Get() list(@CurrentUser() u: JwtUser) { return this.svc.listWorkCenters(u); }
}

@Controller('api/aps')
@Permissions('bom_master', 'warehouse', 'planner', 'exec')
@RequiresSuite('manufacturing')
export class ApsController {
  constructor(private readonly svc: ApsService) {}
  // Finite-capacity schedule: sequence routing operations onto work centres (per-op start/finish, dispatch, makespan, late).
  @Post('schedule') schedule(@Body(new ZodValidationPipe(ScheduleBody)) b: ScheduleDto, @CurrentUser() u: JwtUser) { return this.svc.schedule(b, u); }
}
