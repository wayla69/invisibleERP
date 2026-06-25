import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CollectionsService, DUNNING_STAGES } from './collections.service';

const DunningBody = z.object({
  stage: z.enum(DUNNING_STAGES),
  channel: z.enum(['email', 'phone', 'letter', 'sms']).optional(),
  promise_to_pay_date: z.string().optional(),
  notes: z.string().optional(),
});
const CreditCheckBody = z.object({ tenant_id: z.number().int().positive(), amount: z.number().nonnegative() });
const HoldBody = z.object({ tenant_id: z.number().int().positive(), reason: z.string().optional() });
const LimitBody = z.object({ tenant_id: z.number().int().positive(), new_limit: z.number().nonnegative(), reason: z.string().optional() });

@Controller('api/finance/ar')
export class CollectionsController {
  constructor(private readonly svc: CollectionsService) {}

  // Collections worklist — open AR with aging, current dunning stage and the next recommended rung.
  @Get('collections') @Permissions('ar', 'exec')
  worklist(@Query('overdue_only') overdueOnly?: string) { return this.svc.worklist({ onlyOverdue: overdueOnly === '1' || overdueOnly === 'true' }); }

  // Cron-callable: auto-advance dunning on every overdue invoice past its recommended stage.
  @Post('collections/sweep') @Permissions('ar', 'exec')
  sweep(@CurrentUser() u: JwtUser) { return this.svc.runDunningSweep(u); }

  // Dunning history for one invoice.
  @Get('collections/:invoiceNo/history') @Permissions('ar', 'exec')
  history(@Param('invoiceNo') invoiceNo: string) { return this.svc.history(invoiceNo); }

  // Record a dunning action (advances the collections stage on an open invoice).
  @Post('collections/:invoiceNo/dunning') @Permissions('ar')
  dun(@Param('invoiceNo') invoiceNo: string, @Body(new ZodValidationPipe(DunningBody)) b: z.infer<typeof DunningBody>, @CurrentUser() u: JwtUser) {
    return this.svc.recordDunning(invoiceNo, b, u);
  }

  // Credit position of a customer (exposure vs limit, overdue, hold flag).
  @Get('credit-status') @Permissions('ar', 'exec', 'crm')
  creditStatus(@Query('tenant_id') tenantId: string) { return this.svc.creditStatus(Number(tenantId)); }

  // Credit decision for order entry: may this customer take on `amount` more credit now?
  @Post('credit-check') @Permissions('ar', 'exec', 'order_mgt', 'pos')
  creditCheck(@Body(new ZodValidationPipe(CreditCheckBody)) b: z.infer<typeof CreditCheckBody>) {
    return this.svc.creditCheck(b.tenant_id, b.amount);
  }

  // ── Credit-manager workflow ──
  // Place a manual credit hold (credit manager / AR).
  @Post('credit-hold') @Permissions('crm', 'exec', 'ar')
  placeHold(@Body(new ZodValidationPipe(HoldBody)) b: z.infer<typeof HoldBody>, @CurrentUser() u: JwtUser) { return this.svc.placeHold(b.tenant_id, b.reason, u); }

  // Release a hold — requires `approvals` (SoD: releaser ≠ the person who placed it).
  @Post('credit-release') @Permissions('approvals', 'exec')
  releaseHold(@Body(new ZodValidationPipe(HoldBody)) b: z.infer<typeof HoldBody>, @CurrentUser() u: JwtUser) { return this.svc.releaseHold(b.tenant_id, b.reason, u); }

  // Change a customer's credit limit (audited).
  @Post('credit-limit') @Permissions('crm', 'exec')
  changeLimit(@Body(new ZodValidationPipe(LimitBody)) b: z.infer<typeof LimitBody>, @CurrentUser() u: JwtUser) { return this.svc.changeLimit(b.tenant_id, b.new_limit, b.reason, u); }

  // Credit-change audit (holds / releases / limit changes) for a customer.
  @Get('credit-events') @Permissions('ar', 'exec', 'crm')
  creditEvents(@Query('tenant_id') tenantId: string) { return this.svc.creditEventsFor(Number(tenantId)); }
}
