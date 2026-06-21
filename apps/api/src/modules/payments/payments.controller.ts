import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  PaymentService,
  type RecordTenderDto,
  type RefundDto,
  type OpenTillDto,
  type CloseTillDto,
} from './payments.service';

const TenderBody = z.object({
  sale_no: z.string().min(1),
  tenant_id: z.number().optional(),
  method: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().optional(),
  gateway: z.string().optional(),
  till_session_id: z.number().optional(),
});
const RefundBody = z.object({ payment_no: z.string().min(1), amount: z.number().positive(), reason: z.string().optional() });
const OpenTillBody = z.object({ opening_float: z.number().nonnegative().optional() });
const CloseTillBody = z.object({ session_no: z.string().min(1), closing_count: z.number() });

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly svc: PaymentService) {}

  @Post() @Permissions('pos', 'cust_pos', 'ar')
  tender(@Body(new ZodValidationPipe(TenderBody)) b: RecordTenderDto, @CurrentUser() u: JwtUser) {
    return this.svc.recordTender(b, u);
  }

  @Post('refunds') @Permissions('pos', 'cust_pos', 'ar')
  refund(@Body(new ZodValidationPipe(RefundBody)) b: RefundDto, @CurrentUser() u: JwtUser) {
    return this.svc.refund(b, u);
  }

  @Patch(':no/void') @Permissions('pos', 'cust_pos', 'ar')
  void(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.voidPayment(no, u);
  }

  // confirm an async tender (PromptPay/Authorized → Captured) once settlement is observed
  @Patch(':no/settle') @Permissions('pos', 'cust_pos', 'ar')
  settle(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.settle(no, u);
  }

  @Post('till/open') @Permissions('pos', 'cust_pos', 'ar')
  openTill(@Body(new ZodValidationPipe(OpenTillBody)) b: OpenTillDto, @CurrentUser() u: JwtUser) {
    return this.svc.openTill(b, u);
  }

  @Post('till/close') @Permissions('pos', 'cust_pos', 'ar')
  closeTill(@Body(new ZodValidationPipe(CloseTillBody)) b: CloseTillDto, @CurrentUser() u: JwtUser) {
    return this.svc.closeTill(b, u);
  }

  @Get() @Permissions('pos', 'cust_pos', 'ar')
  list(@Query('sale_no') saleNo: string) {
    return this.svc.listPaymentsForSale(saleNo);
  }
}
