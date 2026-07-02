import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MarketingAutomationService } from './marketing-automation.service';

const Trigger = z.enum(['lapsed', 'birthday', 'winback', 'all']);
const RunBody = z.object({
  name: z.string().min(1), trigger: Trigger, channel: z.enum(['line', 'sms', 'email']).optional(),
  coupon_prefix: z.string().optional(), discount_type: z.enum(['amount', 'percent']).optional(),
  discount_value: z.number().nonnegative().optional(), lapsed_days: z.number().int().positive().optional(),
  variant_b_body: z.string().min(1).optional(), split_b_pct: z.number().int().min(0).max(90).optional(), holdout_pct: z.number().int().min(0).max(50).optional(),
});
const PreviewBody = z.object({ trigger: Trigger, channel: z.enum(['line', 'sms', 'email']).optional(), lapsed_days: z.number().int().positive().optional() });
const RedeemBody = z.object({ coupon_code: z.string().min(1), sale_no: z.string().optional(), value: z.number().nonnegative().optional() });

// LINE marketing automation — closed-loop behaviour campaigns (trigger → coupon push → redemption).
@Controller('api/marketing/automation')
export class MarketingAutomationController {
  constructor(private readonly svc: MarketingAutomationService) {}

  @Post('preview') @Permissions('marketing', 'crm')
  preview(@Body(new ZodValidationPipe(PreviewBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.preview(b, u); }

  @Post('campaigns') @Permissions('marketing', 'crm')
  run(@Body(new ZodValidationPipe(RunBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.run(b, u); }

  @Get('campaigns') @Permissions('marketing', 'crm')
  list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }

  @Get('campaigns/:id') @Permissions('marketing', 'crm')
  report(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.report(+id, u); }

  // Close the loop: redeem a coupon at the point of sale.
  @Post('redeem') @Permissions('pos', 'marketing', 'loyalty')
  redeem(@Body(new ZodValidationPipe(RedeemBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.redeem(b, u); }
}
