import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { ReservationsService, type ReserveDto, type ReturnDto } from './reservations.service';

const ReturnBody = z.object({ qty: z.number().positive().optional(), reason: z.string().min(1).max(500) });
const ReturnRejectBody = z.object({ reason: z.string().max(500).optional() });
const ReserveBody = z.object({
  project_code: z.string().min(1),
  item_id: z.string().min(1),
  location_id: z.string().optional(),
  qty: z.number().positive(),
  boq_line_id: z.number().int().positive().optional(),
  // PROJ-28 — free-issue for a subcontractor: stamps the reservation so custody is tracked.
  subcontract_no: z.string().max(40).optional(),
});
const AckBody = z.object({ qty: z.number().positive() });

// Stock reservation → issue-to-project (M3, docs/32, INV-13). Staff request on-hand stock to be allocated to a
// project (reserve), then issue it (moving inventory value into project WIP). wh_custody/warehouse handle
// custody; procurement/planner may reserve on behalf of a project.
@Controller('api/reservations')
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Post()
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner')
  reserve(@Body(new ZodValidationPipe(ReserveBody)) b: ReserveDto, @CurrentUser() u: JwtUser) {
    return this.svc.reserve(b, u);
  }

  // ── A1 material return-to-stock (docs/50 Wave 2; INV-19) ──
  // Request a return of issued material (qty ≤ issued, reason mandatory; ≥ threshold parks PendingApproval).
  @Post(':id/return')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner')
  requestReturn(@Param('id') id: string, @Body(new ZodValidationPipe(ReturnBody)) b: ReturnDto, @CurrentUser() u: JwtUser) {
    return this.svc.requestReturn(Number(id), b, u);
  }

  // ── PROJ-28: subcontractor free-issue custody (static segments BEFORE the :id routes) ──
  // The custody statement: issued / returned (Posted MRET) / acknowledged-consumed / still in custody.
  @Get('custody')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner', 'proj_subcon', 'exec')
  custody(@Query('subcontract_no') subcontractNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.custodyStatement(subcontractNo ?? '', u);
  }

  // Acknowledge the subcontractor consumed free-issued material in the works (caps at what is in custody).
  @Post(':id/custody-ack')
  @Permissions('wh_custody', 'warehouse', 'planner', 'exec')
  ackCustody(@Param('id') id: string, @Body(new ZodValidationPipe(AckBody)) b: { qty: number }, @CurrentUser() u: JwtUser) {
    return this.svc.ackCustody(Number(id), b, u);
  }

  // Returns register: pending + history (static segment BEFORE the :id routes).
  @Get('returns')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner', 'exec')
  listReturns(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listReturns(u, status);
  }

  // A DIFFERENT user approves a material return (maker-checker; self-approve → SOD_VIOLATION).
  @Post('returns/:returnNo/approve')
  @Permissions('warehouse', 'planner', 'exec')
  approveReturn(@Param('returnNo') returnNo: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveReturn(returnNo, u, b?.self_approval_reason);
  }

  @Post('returns/:returnNo/reject')
  @Permissions('warehouse', 'planner', 'exec')
  rejectReturn(@Param('returnNo') returnNo: string, @Body(new ZodValidationPipe(ReturnRejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.rejectReturn(returnNo, u, b?.reason);
  }

  // A2 (docs/50 Wave 1): release every hold older than max_age_days (default 30) — manual trigger for the
  // scheduled `reservation_stale_release` action job. Planner/warehouse duty (same set that can release).
  @Post('expire-stale')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner')
  expireStale(@Query('max_age_days') maxAgeDays: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.expireStale(u, maxAgeDays != null ? Number(maxAgeDays) : 30);
  }

  // Available-to-issue for an item+location = on_hand − Σ(held). Static 'available' segment.
  @Get('available')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner', 'exec')
  available(@Query('item_id') itemId: string, @Query('location_id') locationId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.available(u, itemId, locationId ?? 'WH-MAIN');
  }

  @Get('project/:code')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner', 'exec')
  listForProject(@Param('code') code: string) {
    return this.svc.listForProject(code);
  }

  // Issue a held reservation to the project (relieve inventory → project WIP).
  @Post(':id/issue')
  @Permissions('wh_custody', 'warehouse')
  issue(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.issueToProject(Number(id), u);
  }

  @Post(':id/release')
  @Permissions('wh_custody', 'warehouse', 'procurement', 'planner')
  release(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.release(Number(id), u);
  }
}
