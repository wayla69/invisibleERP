import { Module } from '@nestjs/common';
import { CrmService } from './crm.service';
import { CrmController } from './crm.controller';
import { CrmPipelineModule } from './pipeline/crm-pipeline.module';
import { PipelineModule } from './pipeline/pipeline.module';

// Umbrella CRM module (docs/28 consolidation PR #3): accounts/360 core + the two pipeline slices under
// crm/pipeline/ — CrmPipelineModule (lead→qualify→convert, REV-17, /api/crm/pipeline) and the older
// stage-board forecaster PipelineModule (/api/pipeline). They stay separate services on separate tables;
// a service-level merge was evaluated and rejected (different data models — it would need a migration,
// out of scope per the RFC's behavior-identical rule). Re-exported so importers (bi) can keep resolving.
@Module({
  imports: [CrmPipelineModule, PipelineModule],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService, CrmPipelineModule, PipelineModule],
})
export class CrmModule {}
