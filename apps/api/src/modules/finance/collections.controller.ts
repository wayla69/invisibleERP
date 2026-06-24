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

@Controller('api/finance/ar')
export class CollectionsController {
  constructor(private readonly svc: CollectionsService) {}

  // Collections worklist — open AR with aging, current dunning stage and the next recommended rung.
  @Get('collections') @Permissions('ar', 'exec')
  worklist(@Query('overdue_only') overdueOnly?: string) { return this.svc.worklist({ onlyOverdue: overdueOnly === '1' || overdueOnly === 'true' }); }

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
}
