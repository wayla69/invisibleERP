import { Module } from '@nestjs/common';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { AttachmentsService } from './attachments.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { CostingModule } from '../costing/costing.module';
import { PlatformModule } from '../platform/platform.module';
import { MessagingModule } from '../messaging/messaging.module';

// MessagingModule supplies LineNotifyService (D2) — close-the-loop LINE pushes to the PR requester when
// their requisition is bought (PR→PO / PO approved) or received (GR). It's a one-way import: MessagingModule
// resolves ProcurementService lazily via ModuleRef, so it never imports ProcurementModule (no DI cycle).
@Module({ imports: [WorkflowModule, CostingModule, PlatformModule, MessagingModule], controllers: [ProcurementController], providers: [ProcurementService, AttachmentsService], exports: [ProcurementService, AttachmentsService] })
export class ProcurementModule {}
