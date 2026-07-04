import { Module } from '@nestjs/common';
import { TaxDocsModule } from './documents/tax-docs.module';
import { TaxReportsModule } from './reports/tax-reports.module';
import { TaxJobsService } from './tax-jobs.service';

// Scheduled tax automation jobs (docs/33 PR4) — WHT-cert batch + filing drafts + remittance reminder.
// Depends on WhtService (TaxDocsModule) and TaxReportsService (TaxReportsModule).
@Module({
  imports: [TaxDocsModule, TaxReportsModule],
  providers: [TaxJobsService],
  exports: [TaxJobsService],
})
export class TaxJobsModule {}
