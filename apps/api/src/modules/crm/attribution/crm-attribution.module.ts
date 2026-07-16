import { Module } from '@nestjs/common';
import { CrmAttributionService } from './crm-attribution.service';
import { CrmAttributionController } from './crm-attribution.controller';
import { CrmAttributionBiReports } from './crm-attribution-bi-reports';

// CRM-15 multi-touch campaign attribution (control CRM-17): campaign touchpoints on opportunities +
// model-governed distribution of won revenue. The attribution report is a schedulable BI report
// (CrmAttributionBiReports, discovered at boot).
@Module({
  controllers: [CrmAttributionController],
  providers: [CrmAttributionService, CrmAttributionBiReports],
  exports: [CrmAttributionService],
})
export class CrmAttributionModule {}
