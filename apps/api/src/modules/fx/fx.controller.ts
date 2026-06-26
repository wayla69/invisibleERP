import { Controller, Get, Post, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FxService } from './fx.service';

const RateBody = z.object({
  currency: z.string().min(3).max(3),
  rate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rate: z.number().positive(),
  shared: z.boolean().optional(),
  source: z.string().optional(),
});
const ApproveRateBody = z.object({
  currency: z.string().min(3).max(3),
  rate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shared: z.boolean().optional(),
});
const RevalueBody = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().min(3).max(3),
  auto_reverse: z.boolean().optional(),
});

// ตีราคาอัตราแลกเปลี่ยน — set period-end rates, report unrealized FX, post the revaluation JE (5400).
@Controller('api/fx')
@Permissions('exec', 'ar', 'creditors')
export class FxController {
  constructor(private readonly svc: FxService) {}

  @Post('rates')
  setRate(@Body(new ZodValidationPipe(RateBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.setRate({ currency: b.currency, rate_date: b.rate_date, rate: b.rate, source: b.source, tenantId: b.shared ? null : (u.tenantId ?? null), createdBy: u.username });
  }

  @Get('rates')
  list(@Query('currency') c?: string, @Query('as_of') asOf?: string, @Query('status') status?: string) { return this.svc.listRates({ currency: c, as_of: asOf, status }); }

  // FX-04 maker-checker. setRate (above) requests a MANUAL rate (PendingApproval, unusable); a DIFFERENT user
  // with approval authority approves/rejects it (approver ≠ requester enforced in the service, even for Admin).
  @Get('rates/pending') @Permissions('approvals', 'gl_close', 'exec')
  pendingRates() { return this.svc.listRates({ status: 'PendingApproval' }); }
  @Post('rates/approve') @HttpCode(200) @Permissions('approvals', 'gl_close')
  approveRate(@Body(new ZodValidationPipe(ApproveRateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.approveRate(b.currency, b.rate_date, b.shared ? null : (u.tenantId ?? null), u); }
  @Post('rates/reject') @HttpCode(200) @Permissions('approvals', 'gl_close')
  rejectRate(@Body(new ZodValidationPipe(ApproveRateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.rejectRate(b.currency, b.rate_date, b.shared ? null : (u.tenantId ?? null), u); }

  @Get('unrealized')
  report(@Query('as_of') asOf: string, @Query('currency') c?: string) { return this.svc.unrealizedFxReport({ as_of: asOf, currency: c }); }

  @Post('revalue')
  revalue(@Body(new ZodValidationPipe(RevalueBody)) b: any, @CurrentUser() u: JwtUser) {
    return this.svc.revalue({ as_of: b.as_of, currency: b.currency, auto_reverse: b.auto_reverse, tenantId: u.tenantId ?? null, createdBy: u.username });
  }
}
