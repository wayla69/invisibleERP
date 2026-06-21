import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module';
import { TaxInvoiceService } from './tax-invoice.service';
import { WhtService } from './wht.service';
import { TaxDocsPdfService } from './tax-docs-pdf.service';
import { TaxDocsController } from './tax-docs.controller';
import { WhtController } from './wht.controller';

// Thai Revenue-Dept tax documents: full + abbreviated tax invoice (ม.86/4, 86/6) and WHT 50 ทวิ (ม.50 ทวิ).
// DocNumberService comes from the global CommonModule; DRIZZLE is global; TaxService from TaxModule.
@Module({
  imports: [TaxModule],
  controllers: [TaxDocsController, WhtController],
  providers: [TaxInvoiceService, WhtService, TaxDocsPdfService],
  exports: [TaxInvoiceService, WhtService],
})
export class TaxDocsModule {}
