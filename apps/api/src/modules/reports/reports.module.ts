import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportExcelService } from './reports-excel.service';
import { ReportPdfService } from './reports-pdf.service';
import { ReportExportService } from './reports-export.service';
import { StatutoryFsController } from './statutory-fs.controller';
import { StatutoryFsService } from './statutory-fs.service';
import { StatutoryFsReviewsService } from './statutory-fs-reviews.service';
import { StatutoryFsReviewQueue } from './statutory-fs-review-queue';

@Module({
  imports: [LedgerModule],
  controllers: [ReportsController, StatutoryFsController],
  providers: [ReportsService, ReportExcelService, ReportPdfService, ReportExportService, StatutoryFsService, StatutoryFsReviewsService, StatutoryFsReviewQueue],
})
export class ReportsModule {}
