import { Module } from '@nestjs/common';
import { CrmDqService } from './crm-dq.service';
import { CrmDqController } from './crm-dq.controller';
import { CrmDqBiReports } from './crm-dq-bi-reports';

// CRM-17 CRM data-quality: field-completeness/validity scoring + duplicate surveillance + the merge audit read.
// The DQ snapshot is a schedulable BI report (CrmDqBiReports, discovered at boot).
@Module({
  controllers: [CrmDqController],
  providers: [CrmDqService, CrmDqBiReports],
  exports: [CrmDqService],
})
export class CrmDqModule {}
