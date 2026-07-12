import { Module } from '@nestjs/common';
import { TaxController } from './tax.controller';
import { TaxCoreModule } from './tax-core.module';
import { TaxDocsModule } from './documents/tax-docs.module';
import { TaxReportsModule } from './reports/tax-reports.module';
import { TaxJobsModule } from './tax-jobs.module';
import { TaxUtpModule } from './tax-utp.module';

// Umbrella tax module (docs/28 consolidation PR #2): calculation core (tax-core.module — TaxService),
// statutory documents (documents/ — tax invoices ม.86, WHT 50 ทวิ, e-tax), and filing reports (reports/ —
// PP.30/PND. views over the immutable filing snapshots). TaxJobsModule (docs/33 PR4) adds the scheduled
// WHT-cert/filing-draft/remittance jobs. TaxUtpModule (TAX-12) adds the DTA valuation allowance + Uncertain
// Tax Positions (FIN 48) register. Re-exports all so existing importers keep receiving the services.
@Module({
  imports: [TaxCoreModule, TaxDocsModule, TaxReportsModule, TaxJobsModule, TaxUtpModule],
  controllers: [TaxController],
  exports: [TaxCoreModule, TaxDocsModule, TaxReportsModule, TaxJobsModule, TaxUtpModule],
})
export class TaxModule {}
