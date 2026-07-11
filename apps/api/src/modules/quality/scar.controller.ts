import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ScarService } from './scar.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const RaiseBody = z.object({
  vendor_id: z.number().int().positive(),
  source_claim_no: z.string().optional(),
  defect_summary: z.string().min(1),
  severity: z.enum(['minor', 'major', 'critical']).optional(),
  containment: z.string().optional(),
  due_date: z.string().optional(),
});
const RespondBody = z.object({
  containment: z.string().optional(),
  root_cause: z.string().optional(),
  corrective_action: z.string().optional(),
  preventive_action: z.string().optional(),
  responder: z.string().optional(),
});
const CloseBody = z.object({ effectiveness: z.enum(['effective', 'ineffective']).optional() });
// reason is validated in the service (REASON_REQUIRED) so the precise QC-04 error code surfaces.
const RejectBody = z.object({ reason: z.string().optional() });

// QMS-4 — Supplier Corrective Action Request (SCAR / 8D). Reads gate quality/quality_approve/creditors/exec
// (procurement roles keep read access); raising gates quality/creditors; closure review gates
// quality_approve/exec. The QC-04 self-approval block (raiser ≠ closer) lives in the service regardless of
// which permission the caller holds.
@Controller('api/quality/scar')
export class ScarController {
  constructor(private readonly svc: ScarService) {}

  @Get()
  @Permissions('quality', 'quality_approve', 'creditors', 'exec')
  list(@Query('status') status: string | undefined, @Query('vendor_id') vendorId: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.list({ status, vendor_id: vendorId ? Number(vendorId) : undefined }, user);
  }

  // QC-04 detective read — the overdue supplier-corrective-action worklist.
  @Get('open')
  @Permissions('quality', 'quality_approve', 'creditors', 'exec')
  open(@Query('days') days: string | undefined, @Query('as_of') asOf: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.openWorklist({ days: days ? Number(days) : undefined, as_of: asOf }, user);
  }

  @Get(':id')
  @Permissions('quality', 'quality_approve', 'creditors', 'exec')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.svc.detail(id);
  }

  @Post()
  @Permissions('quality', 'creditors')
  raise(@Body(new ZodValidationPipe(RaiseBody)) dto: z.infer<typeof RaiseBody>, @CurrentUser() user: JwtUser) {
    return this.svc.raise(dto, user);
  }

  @Post(':id/respond')
  @Permissions('quality', 'creditors', 'exec')
  @HttpCode(200)
  respond(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RespondBody)) dto: z.infer<typeof RespondBody>, @CurrentUser() user: JwtUser) {
    return this.svc.respond(id, dto, user);
  }

  @Post(':id/submit-closure')
  @Permissions('quality', 'creditors')
  @HttpCode(200)
  submitClosure(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
    return this.svc.submitClosure(id, user);
  }

  // QC-04 closure — reserved to the closure-reviewer duty; the raiser cannot self-close (SOD_SELF_APPROVAL).
  @Post(':id/close')
  @Permissions('quality_approve', 'exec')
  @HttpCode(200)
  close(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(CloseBody)) dto: z.infer<typeof CloseBody>, @CurrentUser() user: JwtUser) {
    return this.svc.close(id, dto, user);
  }

  @Post(':id/reject')
  @Permissions('quality_approve', 'exec')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RejectBody)) dto: z.infer<typeof RejectBody>, @CurrentUser() user: JwtUser) {
    return this.svc.reject(id, dto, user);
  }
}
