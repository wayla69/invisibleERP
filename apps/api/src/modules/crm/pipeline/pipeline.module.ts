import { Module } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { PipelineController } from './pipeline.controller';
import { CrmPipelineModule } from './crm-pipeline.module';

// CRM-1 unification (0293): PipelineService is a thin adapter over the unified spine (CrmPipelineService).
@Module({ imports: [CrmPipelineModule], providers: [PipelineService], controllers: [PipelineController], exports: [PipelineService] })
export class PipelineModule {}
