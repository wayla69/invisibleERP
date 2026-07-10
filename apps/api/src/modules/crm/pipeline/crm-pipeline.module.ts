import { Module } from '@nestjs/common';
import { CrmPipelineService } from './crm-pipeline.service';
import { CrmPipelineController, CrmWebToLeadController } from './crm-pipeline.controller';

// CRM sales pipeline (REV-17). DocNumberService + DRIZZLE are global (CommonModule / DatabaseModule).
// CRM-2: CrmWebToLeadController is the @Public website-form capture (rate-limited + honeypot).
@Module({
  controllers: [CrmPipelineController, CrmWebToLeadController],
  providers: [CrmPipelineService],
  exports: [CrmPipelineService],
})
export class CrmPipelineModule {}
