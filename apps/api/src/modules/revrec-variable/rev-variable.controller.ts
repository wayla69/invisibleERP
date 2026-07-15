import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { RevVariableService } from './rev-variable.service';

const ScenarioSchema = z.object({ amount: z.number(), probability: z.number().min(0).max(1) });
const RecordEstimateBody = z.object({
  method: z.enum(['expected_value', 'most_likely']),
  scenarios: z.array(ScenarioSchema).optional(),
  most_likely_amount: z.number().optional(),
  constrained_amount: z.number(),
  as_of: z.string().optional(),
  note: z.string().optional(),
});
type RecordEstimateBodyT = z.infer<typeof RecordEstimateBody>;

const ReestimateBody = z.object({ date: z.string().optional() });
type ReestimateBodyT = z.infer<typeof ReestimateBody>;

// Track D — Wave 2 (REV-25): variable consideration + the constraint under TFRS 15 / IFRS 15 / ASC 606
// §50-59. Extends the REV-19 contract at /api/revenue/contracts/:id. Gated with the same exec/ar/fin_report
// duties (no new duty invented). The estimate maker-checker (SoD) is enforced in the service.
@Controller('api/revenue/contracts')
@Permissions('exec', 'ar', 'fin_report')
export class RevVariableController {
  constructor(private readonly svc: RevVariableService) {}

  // Record a variable-consideration estimate (maker). Pending until a different user approves it.
  @Post(':id/variable-consideration')
  record(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RecordEstimateBody)) b: RecordEstimateBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.recordEstimate(id, b, u);
  }

  // List the contract's estimates (newest first).
  @Get(':id/variable-consideration')
  list(@Param('id', ParseIntPipe) id: number) {
    return this.svc.listEstimates(id);
  }

  // Approve an estimate (checker; must differ from the estimator → 403 SOD_SELF_APPROVAL).
  @Post(':id/variable-consideration/:vcId/approve')
  approve(@Param('id', ParseIntPipe) id: number, @Param('vcId', ParseIntPipe) vcId: number, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveEstimate(id, vcId, u, b?.self_approval_reason);
  }

  // Apply the latest approved estimate for the period — recompute price, re-allocate, rebuild the
  // unrecognized schedule, and post the true-up catch-up delta on already-recognized revenue (maker).
  @Post(':id/reestimate')
  reestimate(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ReestimateBody)) b: ReestimateBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.reestimate(id, b, u);
  }
}
