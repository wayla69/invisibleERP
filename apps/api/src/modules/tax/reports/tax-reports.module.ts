import { Module } from '@nestjs/common';
import { LedgerModule } from '../../ledger/ledger.module';
import { TaxReportsService } from './tax-reports.service';
import { TaxReportsPdfService } from './tax-reports-pdf.service';
import { TaxReportsController } from './tax-reports.controller';

// Read-only aggregation of existing data into Thai statutory reports
// (รายงานภาษีขาย/ซื้อ, ภ.พ.30, ภ.ง.ด.3/53). No GL postings; PP30 reconciles against GL 2100.
@Module({
  imports: [LedgerModule],
  controllers: [TaxReportsController],
  providers: [TaxReportsService, TaxReportsPdfService],
  exports: [TaxReportsService],
})
export class TaxReportsModule {}
