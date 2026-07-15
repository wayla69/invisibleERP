import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { IcReconService } from './ic-recon.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const PeriodBody = z.object({ period: z.string().min(1) });
const ApproveBody = PeriodBody.extend({ self_approval_reason: z.string().max(500).optional() });
const RejectBody = z.object({ period: z.string().min(1), reason: z.string().min(1) });

// REC-03 — per-period intercompany reconciliation sign-off (gates consolidation elimination). HQ/exec only.
@Controller('api/ic-reconciliation')
export class IcReconController {
  constructor(private readonly svc: IcReconService) {}

  // Preparer — reconcile + sign the period.
  @Post('groups/:groupId/prepare') @HttpCode(200) @Permissions('exec')
  prepare(@Param('groupId', ParseIntPipe) groupId: number, @Body(new ZodValidationPipe(PeriodBody)) b: z.infer<typeof PeriodBody>, @CurrentUser() u: JwtUser) {
    return this.svc.preparePeriod(groupId, b.period, u);
  }

  // Checker — approve (SoD: approver ≠ preparer; IC must eliminate).
  @Post('groups/:groupId/approve') @HttpCode(200) @Permissions('exec')
  approve(@Param('groupId', ParseIntPipe) groupId: number, @Body(new ZodValidationPipe(ApproveBody)) b: z.infer<typeof ApproveBody>, @CurrentUser() u: JwtUser) {
    return this.svc.approvePeriod(groupId, b.period, u, b.self_approval_reason);
  }

  @Post('groups/:groupId/reject') @HttpCode(200) @Permissions('exec')
  reject(@Param('groupId', ParseIntPipe) groupId: number, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) {
    return this.svc.rejectPeriod(groupId, b.period, b.reason, u);
  }

  @Get('groups/:groupId/status') @Permissions('exec')
  status(@Param('groupId', ParseIntPipe) groupId: number, @Query('period') period: string, @CurrentUser() u: JwtUser) {
    return this.svc.getStatus(groupId, period, u);
  }

  @Get('groups/:groupId') @Permissions('exec')
  list(@Param('groupId', ParseIntPipe) groupId: number, @CurrentUser() u: JwtUser) {
    return this.svc.list(groupId, u);
  }
}
