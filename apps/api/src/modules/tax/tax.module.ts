import { Module } from '@nestjs/common';
import { TaxController } from './tax.controller';
import { TaxCoreModule } from './tax-core.module';
import { TaxDocsModule } from './documents/tax-docs.module';
import { TaxReportsModule } from './reports/tax-reports.module';

// Umbrella tax module (docs/28 consolidation PR #2): calculation core (tax-core.module — TaxService),
// statutory documents (documents/ — tax invoices ม.86, WHT 50 ทวิ, e-tax), and filing reports (reports/ —
// PP.30/PND. views over the immutable filing snapshots). Re-exports all three so existing importers keep
// receiving TaxService by importing TaxModule.
@Module({
  imports: [TaxCoreModule, TaxDocsModule, TaxReportsModule],
  controllers: [TaxController],
  exports: [TaxCoreModule, TaxDocsModule, TaxReportsModule],
})
export class TaxModule {}
