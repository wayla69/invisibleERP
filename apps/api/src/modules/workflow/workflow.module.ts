import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { SodController } from './sod.controller';
import { WorkflowService } from './workflow.service';
import { SodService } from './sod.service';

// Generic approval-workflow engine + SoD. Exported so any module (Procurement, Finance…) can opt in.
@Module({
  controllers: [WorkflowController, SodController],
  providers: [WorkflowService, SodService],
  exports: [WorkflowService, SodService],
})
export class WorkflowModule {}
