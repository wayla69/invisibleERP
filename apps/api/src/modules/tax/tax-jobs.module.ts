import { Module } from '@nestjs/common';
import { TaxDocsModule } from './documents/tax-docs.module';
import { TaxReportsModule } from './reports/tax-reports.module';
import { PosFiscalModule } from '../pos/fiscal/pos-fiscal.module';
import { TaxJobsService } from './tax-jobs.service';

// Scheduled tax automation jobs (docs/33 PR4) — WHT-cert batch + filing drafts + remittance reminder +
// e-Tax submission retry. Depends on WhtService (TaxDocsModule), TaxReportsService (TaxReportsModule), and
// EtaxService (PosFiscalModule).
@Module({
  imports: [TaxDocsModule, TaxReportsModule, PosFiscalModule],
  providers: [TaxJobsService],
  exports: [TaxJobsService],
})
export class TaxJobsModule {}
