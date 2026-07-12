import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { FxService } from './fx.service';
import { FxController } from './fx.controller';
import { FxApprovalQueues } from './fx-approval-queues';

// FX revaluation. DRIZZLE is global; LedgerService for the revaluation GL postings.
@Module({
  imports: [LedgerModule],
  controllers: [FxController],
  providers: [FxApprovalQueues, FxService],
  exports: [FxService],
})
export class FxModule {}
