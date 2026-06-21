import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportExcelService } from './reports-excel.service';
import { ReportPdfService } from './reports-pdf.service';
import { ReportExportService } from './reports-export.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, ReportExcelService, ReportPdfService, ReportExportService],
})
export class ReportsModule {}
