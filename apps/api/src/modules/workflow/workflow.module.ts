import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { SodController } from './sod.controller';
import { WorkflowService } from './workflow.service';
import { SodService } from './sod.service';
import { MessagingModule } from '../messaging/messaging.module';

// Generic approval-workflow engine + SoD. Exported so any module (Procurement, Finance…) can opt in.
// MessagingModule supplies LineNotifyService (0228): linked staff get LINE pushes on queue-entry and
// final approve/reject. Messaging imports no modules, so this edge cannot form a module cycle.
@Module({
  imports: [MessagingModule],
  controllers: [WorkflowController, SodController],
  providers: [WorkflowService, SodService],
  exports: [WorkflowService, SodService],
})
export class WorkflowModule {}
