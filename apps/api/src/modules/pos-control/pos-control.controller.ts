import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PosControlService } from './pos-control.service';

const HoldBody = z.object({ label: z.string().optional(), customer_name: z.string().optional(), cart: z.any() });
const OverrideBody = z.object({
  action: z.enum(['void', 'discount', 'price_override', 'no_sale', 'return']),
  sale_no: z.string().optional(), reason_code: z.string().optional(), reason: z.string().optional(),
  amount: z.number().optional(), approved_by: z.string().optional(),
});

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
  @Get('overrides') listOverrides(@Query('limit') limit?: string) { return this.svc.listOverrides(limit ? +limit : 50); }
}
