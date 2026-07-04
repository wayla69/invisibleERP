import { Module } from '@nestjs/common';
import { CommitmentsModule } from '../commitments/commitments.module';
import { ProcurementModule } from '../procurement/procurement.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { PmrController } from './pmr.controller';
import { PmrService } from './pmr.service';

// Project Material Requisition (PMR) — M2, docs/32, PROJ-13. The requisition hub: it needs the BoQ-line
// budget (CommitmentsModule), procurement to raise the PR / draft the PO (ProcurementModule), the approval
// engine (WorkflowModule) and the LINE approval card (MessagingModule). One-way imports → no DI cycle.
@Module({
  imports: [CommitmentsModule, ProcurementModule, WorkflowModule, MessagingModule, ReservationsModule],
  controllers: [PmrController],
  providers: [PmrService],
  exports: [PmrService],
})
export class PmrModule {}
