import { Module } from '@nestjs/common';
import { EInvoiceService } from './einvoice.service';
import { EInvoiceController } from './einvoice.controller';

// C3 (Phase 22) — pluggable e-invoicing engine. DRIZZLE is global; stub-default so CI runs offline.
@Module({
  controllers: [EInvoiceController],
  providers: [EInvoiceService],
})
export class EInvoiceModule {}
