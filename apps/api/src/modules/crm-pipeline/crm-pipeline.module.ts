import { Module } from '@nestjs/common';
import { CrmPipelineService } from './crm-pipeline.service';
import { CrmPipelineController } from './crm-pipeline.controller';

// CRM sales pipeline (REV-16). DocNumberService + DRIZZLE are global (CommonModule / DatabaseModule).
@Module({
  controllers: [CrmPipelineController],
  providers: [CrmPipelineService],
  exports: [CrmPipelineService],
})
export class CrmPipelineModule {}
