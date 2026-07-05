import { Module } from '@nestjs/common';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { AttachmentsService } from './attachments.service';
import { PoPdfService } from './po-pdf.service';
import { GrPdfService } from './gr-pdf.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { CostingModule } from '../costing/costing.module';
import { PlatformModule } from '../platform/platform.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommitmentsModule } from '../commitments/commitments.module';
import { DocumentTemplatesModule } from '../document-templates/document-templates.module';

// MessagingModule supplies LineNotifyService (D2) — close-the-loop LINE pushes to the PR requester when
// their requisition is bought (PR→PO / PO approved) or received (GR). It's a one-way import: MessagingModule
// resolves ProcurementService lazily via ModuleRef, so it never imports ProcurementModule (no DI cycle).
// CommitmentsModule supplies the BoQ-line encumbrance ledger (M1, PROJ-12) — a project PO reserves budget
// against its BoQ line (BUDGET_EXCEEDED if it would overrun), releases on cancel, consumes on receipt.
@Module({ imports: [WorkflowModule, CostingModule, PlatformModule, MessagingModule, CommitmentsModule, DocumentTemplatesModule], controllers: [ProcurementController], providers: [ProcurementService, AttachmentsService, PoPdfService, GrPdfService], exports: [ProcurementService, AttachmentsService] })
export class ProcurementModule {}
