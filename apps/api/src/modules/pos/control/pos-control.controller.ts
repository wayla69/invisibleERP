import { Controller, Get, Post, Put, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { PosControlService } from './pos-control.service';
import { qint, qintOpt } from '../../../common/query';

const HoldBody = z.object({ label: z.string().optional(), customer_name: z.string().optional(), cart: z.any() });
const OverrideBody = z.object({
  action: z.enum(['void', 'discount', 'price_override', 'no_sale', 'return']),
  sale_no: z.string().optional(), reason_code: z.string().optional(), reason: z.string().optional(),
  amount: z.number().optional(), approved_by: z.string().optional(),
});
// docs/52 Phase 4b — discount-authority policy + supervisor authorization.
const DiscountSettingsBody = z.object({ max_line_discount_pct: z.number().min(0).max(100).nullable().optional(), max_bill_discount_pct: z.number().min(0).max(100).nullable().optional() });
const AuthorizeDiscountBody = z.object({ max_pct: z.number().positive().max(100), reason: z.string().max(500).optional(), cashier: z.string().max(120).optional() });

@Controller('api/pos')
@Permissions('pos', 'order_mgt', 'cust_pos')
export class PosControlController {
  constructor(private readonly svc: PosControlService) {}

  // Park / recall
  @Post('hold') hold(@Body(new ZodValidationPipe(HoldBody)) b: z.infer<typeof HoldBody>, @CurrentUser() u: JwtUser) { return this.svc.hold(b, u); }
  @Get('held') listHeld() { return this.svc.listHeld(); }
  @Post('held/:holdNo/recall') recall(@Param('holdNo') no: string) { return this.svc.recall(no); }
  @Post('held/:holdNo/discard') discard(@Param('holdNo') no: string) { return this.svc.discard(no); }

  // Manager override audit
  @Post('override') override(@Body(new ZodValidationPipe(OverrideBody)) b: z.infer<typeof OverrideBody>, @CurrentUser() u: JwtUser) { return this.svc.override(b, u); }
  @Get('overrides') listOverrides(@Query('limit') limit?: string) { return this.svc.listOverrides(qint('limit', limit, 50)); }

  // docs/52 Phase 4b — discount authority. The policy read is open to sellers (the register needs the caps to
  // know when to prompt); changing the policy AND authorizing an over-cap discount require the supervisor duty
  // (pos_refund/exec) — segregated from selling (SoD R08), so a cashier cannot raise their own limit or
  // self-authorize a large discount.
  @Get('discount-settings') getDiscountSettings(@CurrentUser() u: JwtUser) { return this.svc.getDiscountSettings(u.tenantId ?? null); }
  @Put('discount-settings') @Permissions('pos_refund', 'exec') setDiscountSettings(@Body(new ZodValidationPipe(DiscountSettingsBody)) b: z.infer<typeof DiscountSettingsBody>, @CurrentUser() u: JwtUser) { return this.svc.setDiscountSettings(b, u); }
  @Post('discount-authorize') @Permissions('pos_refund', 'exec') authorizeDiscount(@Body(new ZodValidationPipe(AuthorizeDiscountBody)) b: z.infer<typeof AuthorizeDiscountBody>, @CurrentUser() u: JwtUser) { return this.svc.authorizeDiscount(b, u); }
}
