import { Controller, Get, Post, Put, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { ContractRenewalService } from './contract-renewal.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

// SVC-3: Service Contract Renewal & Expiry management. Reads gate service reads (exec/marketing); proposing a
// renewal is a service/masterdata duty; approving/rejecting is an approver duty (approvals/exec). The
// maker-checker (SVC-02) is enforced in-app: approved_by ≠ requested_by → 403 SOD_SELF_APPROVAL.
const RenewBody = z.object({
  proposed_start: z.string().optional(),
  proposed_end: z.string().optional(),
  base_value: z.number().nonnegative().optional(),
  uplift_pct: z.number().optional(),
  auto_renew: z.boolean().optional(),
  reason: z.string().optional(),
});
const RejectBody = z.object({ reason: z.string().optional() });
const SettingsBody = z.object({ max_auto_uplift_pct: z.number() });

@Controller('api/service')
export class ContractRenewalController {
  constructor(private readonly svc: ContractRenewalService) {}

  // Propose a renewal (computes new_value = base × (1 + uplift/100); within-threshold auto-approves)
  @Post('contracts/:id/renew')
  @Permissions('masterdata', 'exec')
  propose(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RenewBody)) dto: z.infer<typeof RenewBody>, @CurrentUser() user: JwtUser) {
    return this.svc.proposeRenewal(id, dto, user);
  }

  // Detective — contracts nearing end_date with no renewal in flight
  @Get('contracts/expiring')
  @Permissions('exec', 'marketing')
  expiring(@Query('days') days: string | undefined, @Query('as_of') asOf: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.expiring(user, days ? Number(days) : 30, asOf);
  }

  // Renewal queue (optionally filter by status=pending|approved|rejected)
  @Get('renewals')
  @Permissions('exec', 'marketing', 'approvals')
  list(@Query('status') status: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.listRenewals(user, status);
  }

  @Post('renewals/:id/approve')
  @Permissions('approvals', 'exec')
  @HttpCode(200)
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveRenewal(id, user, b?.self_approval_reason);
  }

  @Post('renewals/:id/reject')
  @Permissions('approvals', 'exec')
  @HttpCode(200)
  reject(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RejectBody)) dto: z.infer<typeof RejectBody>, @CurrentUser() user: JwtUser) {
    return this.svc.rejectRenewal(id, user, dto.reason);
  }

  // Renewal-uplift threshold (SVC-02 config; change-gated to exec)
  @Get('renewal-settings')
  @Permissions('exec', 'marketing')
  getSettings(@CurrentUser() user: JwtUser) { return this.svc.getSettings(user); }

  @Put('renewal-settings')
  @Permissions('exec')
  putSettings(@Body(new ZodValidationPipe(SettingsBody)) dto: z.infer<typeof SettingsBody>, @CurrentUser() user: JwtUser) {
    return this.svc.putSettings(dto, user);
  }
}
