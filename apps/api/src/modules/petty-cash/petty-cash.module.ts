import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { MessagingModule } from '../messaging/messaging.module';
import { CommitmentsModule } from '../commitments/commitments.module';
import { PettyCashService } from './petty-cash.service';
import { PettyCashController } from './petty-cash.controller';
import { PettyCashApprovalQueues } from './petty-cash-approval-queues';

// Petty cash imprest float + direct-expense / advance maker-checker (EXP-08). DocNumberService +
// StatusLogService + DRIZZLE are global (CommonModule / DatabaseModule); LedgerService posts the GL.
// MessagingModule supplies LineNotifyService (LC-2): linked approvers hear about new requests, the
// requester hears the decision. Messaging imports no modules, so this edge cannot form a cycle.
@Module({
  imports: [LedgerModule, MessagingModule, CommitmentsModule],
  controllers: [PettyCashController],
  providers: [PettyCashApprovalQueues, PettyCashService],
  exports: [PettyCashService],
})
export class PettyCashModule {}
