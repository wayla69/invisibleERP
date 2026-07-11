import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MasterdataChangeService } from './masterdata-change.service';

// GRC-3 — sensitive master-data single-record maker-checker (control MDM-01). Editing a sensitive field
// (vendor bank account / credit limit / payment terms) stages a `pending` request here; a DISTINCT user
// approves it (requester ≠ approver → 403 SOD_SELF_APPROVAL) before the master is written. Reject discards it.
const StageBody = z.object({
  entity_type: z.enum(['vendor', 'customer', 'item']),
  entity_id: z.number().int().positive(),
  field: z.string().min(1).max(64),
  new_value: z.union([z.string(), z.number(), z.null()]).optional(),
  reason: z.string().max(500).optional(),
});
const RejectBody = z.object({ reason: z.string().max(500).optional() });

@Controller('api/masterdata/change-requests')
export class MasterdataChangeController {
  constructor(private readonly svc: MasterdataChangeService) {}

  // Reviewer worklist — the pending queue (also ?status=approved|rejected|superseded for history).
  @Get() @Permissions('masterdata', 'md_vendor', 'exec')
  list(@Query('status') status?: string) { return this.svc.listPending(status); }

  // Maker — stage a sensitive-field change (never writes the master directly).
  @Post() @Permissions('masterdata', 'md_vendor', 'exec')
  stage(@Body(new ZodValidationPipe(StageBody)) b: z.infer<typeof StageBody>, @CurrentUser() u: JwtUser) {
    return this.svc.stageChange(b, u);
  }

  // Checker — a DISTINCT user applies the staged change to the master (self-approval → 403 SOD_SELF_APPROVAL).
  @Post(':reqNo/approve') @Permissions('masterdata', 'exec')
  approve(@Param('reqNo') reqNo: string, @CurrentUser() u: JwtUser) { return this.svc.approve(reqNo, u); }

  // Checker — discard the staged change (the master is never touched).
  @Post(':reqNo/reject') @Permissions('masterdata', 'exec')
  reject(@Param('reqNo') reqNo: string, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) {
    return this.svc.reject(reqNo, u, b.reason);
  }
}
