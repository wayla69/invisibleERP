import { Controller, Get, Post, Param, Body, Module } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CommonModule } from '../../common/common.module';
import { SupplierService } from './supplier.service';

const InvoiceBody = z.object({ po_no: z.string().optional(), invoice_no: z.string().min(1), invoice_date: z.string().optional(), amount: z.number().positive(), vat_amount: z.number().nonnegative().optional() });

// Phase D3 — Supplier portal. Vendor-facing, self-scoped to the logged-in vendor (perm `vendor_portal`):
// see own POs, acknowledge them, and submit invoices (→ pending AP for the buyer to match/pay).
@Controller('api/supplier')
@Permissions('vendor_portal')
export class SupplierController {
  constructor(private readonly svc: SupplierService) {}

  @Get('purchase-orders') myPos(@CurrentUser() u: JwtUser) { return this.svc.myPurchaseOrders(u); }
  @Get('purchase-orders/:poNo') poDetail(@Param('poNo') poNo: string, @CurrentUser() u: JwtUser) { return this.svc.poDetail(poNo, u); }
  @Post('purchase-orders/:poNo/acknowledge') ack(@Param('poNo') poNo: string, @CurrentUser() u: JwtUser) { return this.svc.acknowledge(poNo, u); }
  @Get('invoices') myInvoices(@CurrentUser() u: JwtUser) { return this.svc.myInvoices(u); }
  @Post('invoices') submitInvoice(@Body(new ZodValidationPipe(InvoiceBody)) b: z.infer<typeof InvoiceBody>, @CurrentUser() u: JwtUser) { return this.svc.submitInvoice(b, u); }
}

@Module({ imports: [CommonModule], controllers: [SupplierController], providers: [SupplierService] })
export class SupplierModule {}
