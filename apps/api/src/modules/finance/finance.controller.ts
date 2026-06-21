import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FinanceService, type ReceiptDto, type ApTxnDto } from './finance.service';

const ReceiptBody = z.object({ invoice_no: z.string().min(1), amount: z.number().positive(), method: z.string().optional(), ref_no: z.string().optional(), remarks: z.string().optional() });
const ApTxnBody = z.object({ vendor_id: z.number().optional(), vendor_name: z.string().optional(), txn_type: z.string().optional(), invoice_no: z.string().optional(), invoice_date: z.string().optional(), due_date: z.string().optional(), amount: z.number(), paid_amount: z.number().optional(), remarks: z.string().optional(), vat_treatment: z.enum(['standard', 'exempt', 'zero']).optional() });
const PayBody = z.object({ amount: z.number().positive() });

@Controller('api/finance')
export class FinanceController {
  constructor(private readonly svc: FinanceService) {}

  // READ
  @Get('pl') @Permissions('exec', 'dashboard', 'ar', 'creditors')
  pl(@Query('month') month: string, @Query('year') year: string) { return this.svc.pl(parseInt(month, 10), parseInt(year, 10)); }

  @Get('ap') @Permissions('creditors', 'exec')
  ap(@Query('status') status = 'Outstanding', @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.svc.ap(status, limit ? +limit : 20, offset ? +offset : 0); }

  @Get('ar') @Permissions('ar', 'exec')
  ar(@Query('limit') limit?: string, @Query('offset') offset?: string) { return this.svc.ar(limit ? +limit : 20, offset ? +offset : 0); }

  @Get('kpi') @Permissions('exec', 'dashboard')
  kpi() { return this.svc.kpi(); }

  // sub-ledger ↔ GL reconciliation (AR 1100 == open AR, AP 2000 == open AP)
  @Get('reconciliation') @Permissions('exec', 'ar', 'creditors')
  reconciliation() { return this.svc.reconcile(); }

  // WRITE
  @Post('ar/sync') @Permissions('ar')
  syncAr(@CurrentUser() u: JwtUser) { return this.svc.syncArInvoices(u); }

  @Post('ar/receipts') @Permissions('ar')
  receipt(@Body(new ZodValidationPipe(ReceiptBody)) b: ReceiptDto, @CurrentUser() u: JwtUser) { return this.svc.createReceipt(b, u); }

  @Post('ap/transactions') @Permissions('creditors')
  apTxn(@Body(new ZodValidationPipe(ApTxnBody)) b: ApTxnDto, @CurrentUser() u: JwtUser) { return this.svc.createApTxn(b, u); }

  @Patch('ap/transactions/:txnNo/pay') @Permissions('creditors')
  payAp(@Param('txnNo') txnNo: string, @Body(new ZodValidationPipe(PayBody)) b: { amount: number }, @CurrentUser() u: JwtUser) { return this.svc.payAp(txnNo, b.amount, u); }
}
