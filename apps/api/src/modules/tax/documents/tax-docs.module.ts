import { Module } from '@nestjs/common';
import { TaxCoreModule } from '../tax-core.module';
import { TaxInvoiceService } from './tax-invoice.service';
import { WhtService } from './wht.service';
import { TaxDocsPdfService } from './tax-docs-pdf.service';
import { TaxDocsController } from './tax-docs.controller';
import { WhtController } from './wht.controller';
import { EtaxEmailService } from './etax-email.service';
import { MAILER, NodemailerMailer } from './mailer';
import { PosFiscalModule } from '../../pos/fiscal/pos-fiscal.module';
import { LedgerModule } from '../../ledger/ledger.module';
import { DocumentTemplatesModule } from '../../document-templates/document-templates.module';

// Thai Revenue-Dept tax documents: full + abbreviated tax invoice (ม.86/4, 86/6) and WHT 50 ทวิ (ม.50 ทวิ).
// DocNumberService comes from the global CommonModule; DRIZZLE is global; TaxService from TaxCoreModule
// (not the umbrella TaxModule — that would be a circular module dependency, docs/28 consolidation PR #2).
@Module({
  imports: [TaxCoreModule, PosFiscalModule, LedgerModule, DocumentTemplatesModule],
  controllers: [TaxDocsController, WhtController],
  providers: [TaxInvoiceService, WhtService, TaxDocsPdfService, EtaxEmailService, { provide: MAILER, useClass: NodemailerMailer }],
  exports: [TaxInvoiceService, WhtService],
})
export class TaxDocsModule {}
