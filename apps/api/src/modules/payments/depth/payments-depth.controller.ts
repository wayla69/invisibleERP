import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { PaymentsDepthService } from './payments-depth.service';

const DepositBody = z.object({ amount: z.number().positive(), member_id: z.number().int().positive().optional(), customer_name: z.string().optional(), purpose: z.enum(['booking', 'tab', 'other']).optional() });
const ApplyBody = z.object({ amount: z.number().positive().optional(), sale_no: z.string().optional() });
const RefundBody = z.object({ amount: z.number().positive().optional(), reason: z.string().optional() });
const OpenAcctBody = z.object({ name: z.string().min(1), member_id: z.number().int().positive().optional(), credit_limit: z.number().nonnegative().optional() });
const ChargeBody = z.object({ amount: z.number().positive(), sale_no: z.string().optional(), memo: z.string().optional() });
const SettleBody = z.object({ amount: z.number().positive(), currency: z.string().optional(), fx_rate: z.number().positive().optional(), foreign_tendered: z.number().positive().optional(), memo: z.string().optional() });
const SurchargeBody = z.object({ method: z.string().min(1), pct: z.number().min(0).max(20), active: z.boolean().optional() });
const SurchargeChargeBody = z.object({ method: z.string().min(1), amount: z.number().positive(), sale_no: z.string().optional() });

@Controller('api/payments')
@Permissions('pos')
export class PaymentsDepthController {
  constructor(private readonly svc: PaymentsDepthService) {}

  // customer deposits (prepaid)
  @Post('deposits') takeDeposit(@Body(new ZodValidationPipe(DepositBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.takeDeposit(b, u); }
  @Get('deposits') deposits(@Query('status') s: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listDeposits(u, s || undefined); }
  @Post('deposits/:no/apply') applyDeposit(@Param('no') no: string, @Body(new ZodValidationPipe(ApplyBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.applyDeposit(no, b, u); }
  @Post('deposits/:no/refund') refundDeposit(@Param('no') no: string, @Body(new ZodValidationPipe(RefundBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.refundDeposit(no, b, u); }

  // house / charge accounts (credit) — open requires manager (order_mgt/exec)
  @Post('house-accounts') @Permissions('pos', 'order_mgt', 'exec') openAccount(@Body(new ZodValidationPipe(OpenAcctBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.openAccount(b, u); }
  @Get('house-accounts') accounts(@CurrentUser() u: JwtUser) { return this.svc.listAccounts(u); }
  @Post('house-accounts/:no/charge') charge(@Param('no') no: string, @Body(new ZodValidationPipe(ChargeBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.charge(no, b, u); }
  @Post('house-accounts/:no/settle') settle(@Param('no') no: string, @Body(new ZodValidationPipe(SettleBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.settle(no, b, u); }
  @Get('house-accounts/:no/statement') statement(@Param('no') no: string, @CurrentUser() u: JwtUser) { return this.svc.statement(no, u); }

  // card surcharge
  @Get('surcharges') surcharges(@CurrentUser() u: JwtUser) { return this.svc.listSurcharges(u); }
  @Post('surcharges') @Permissions('pos', 'order_mgt', 'masterdata') setSurcharge(@Body(new ZodValidationPipe(SurchargeBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setSurcharge(b, u); }
  @Get('surcharges/quote') quote(@Query('method') m: string, @Query('amount') a: string, @CurrentUser() u: JwtUser) { return this.svc.quoteSurcharge(m, +a, u); }
  @Post('surcharges/charge') chargeSurcharge(@Body(new ZodValidationPipe(SurchargeChargeBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.chargeSurcharge(b, u); }
}
