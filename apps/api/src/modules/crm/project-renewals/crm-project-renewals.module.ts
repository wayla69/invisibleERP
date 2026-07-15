import { Module } from '@nestjs/common';
import { CrmProjectRenewalsService } from './crm-project-renewals.service';
import { CrmProjectRenewalsController } from './crm-project-renewals.controller';
import { CrmPipelineModule } from '../pipeline/crm-pipeline.module';

// CRM-18 CRM↔PPM back-flow: raises a renewal opportunity from a delivered project + a detective gap list.
// Imports CrmPipelineModule to create the opportunity through the CRM domain (CrmPipelineService is exported
// there; no module cycle — the pipeline module does not depend on this one).
@Module({
  imports: [CrmPipelineModule],
  controllers: [CrmProjectRenewalsController],
  providers: [CrmProjectRenewalsService],
  exports: [CrmProjectRenewalsService],
})
export class CrmProjectRenewalsModule {}
